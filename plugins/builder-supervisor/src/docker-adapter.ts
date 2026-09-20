import { createHash } from 'node:crypto'
import { EXPORT_SCRIPT } from './export-script.js'
import { rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DockerEnginePort } from './docker-engine.js'
import { cleanupManagedExportResources, enforceExportRetention, listManagedExportArchives, openManagedExportArchive, publishValidatedDockerArchive, readValidatedPublishedArtifact } from './export-artifact.js'
import type { BuilderAttestation, BuildStep, ExportedArtifact, StepResult } from './model.js'
import { BuilderSupervisorError } from './model.js'
import { Semaphore } from './semaphore.js'
import { isBuilderRuntimeScopeId, isInstallationId, type BuilderRuntimeScopeId } from './runtime-scope.js'
import { templateStoreVolumeName, verifyTemplateStoreVolume } from './template-store-volume.js'

const OUTPUT_LIMIT = 512 * 1024
const EXPORT_ARCHIVE_LIMIT = 640 * 1024 * 1024
const COMMANDS: Readonly<Record<BuildStep, readonly string[]>> = {
  install: ['pnpm', 'install', '--offline', '--frozen-store', '--frozen-lockfile', '--trust-lockfile', '--ignore-scripts', '--store-dir', '/template-store/tree'],
  build: ['pnpm', 'run', 'build'], test: ['pnpm', 'run', 'test'], e2e: ['pnpm', 'run', 'test:e2e'],
}

export interface BuilderLimits {
  readonly memoryBytes: number; readonly nanoCpus: number; readonly pids: number; readonly timeoutMs: number
  readonly workspaceBytes: number; readonly maxWorkspaceBytes: number; readonly concurrentContainers: number
  readonly maxExportBytes: number; readonly maxRetainedExports: number
}
export interface DockerBuilderAdapterOptions {
  readonly engine: DockerEnginePort; readonly imageDigest: `sha256:${string}`; readonly installationId: string; readonly scopeId: BuilderRuntimeScopeId
  readonly exportRoot: string; readonly templateStoreVersion: string; readonly templateStoreSha256: string; readonly limits?: BuilderLimits
  /** @internal Deterministic filesystem fault seam; production uses node:fs/promises.rm. */
  readonly removeArchive?: (path: string) => Promise<void>
  /** @internal Deterministic export-garbage fault seam. */
  readonly cleanupExportResources?: typeof cleanupManagedExportResources
  /** @internal Deterministic descriptor-close fault seam. */
  readonly closeArchive?: (handle: FileHandle) => Promise<void>
  /** @internal O relógio da reconferência do store (ver `STORE_REVERIFY_MS`). */
  readonly now?: () => number
  /**
   * POR QUE uma exportação falhou, para o registro de quem opera.
   *
   * O diário guarda só o código (`EXPORT_INVALID`), e o código cobria uma
   * dúzia de causas diferentes. Medido em 20/09/2026: duas criações que
   * passaram em tudo pararam aqui, e nada dizia em qual passo. O evento leva
   * a ETAPA e, quando o exportador saiu com erro, o fim da saída de erro DELE
   * — que é o nosso programa falando, e não o aplicativo nem um segredo.
   */
  readonly diagnostico?: (evento: Readonly<Record<string, string | number>>) => void
}

/**
 * De quanto em quanto tempo o `preflight` refaz a conferência COMPLETA do store.
 *
 * A conferência completa baixa o volume inteiro e confere cada arquivo por
 * hash. Com o dublê de teste (um arquivo) ela era instantânea; com o store REAL
 * (23.346 entradas, 560 MB) ela leva minutos — medido em 19/09/2026. E o
 * `preflight` é o que a tela de saúde pergunta a cada consulta: a resposta
 * nunca chegava a tempo, e a tela dizia "ambiente isolado indisponível" com o
 * construtor de pé.
 *
 * Entre uma conferência completa e a próxima, o que se confere é o MESMO
 * volume: mesmo nome e mesma data de criação. Um volume trocado (apagado e
 * recriado) tem outra data e força a conferência completa na hora. O que fica
 * de fora nessa janela é alteração do conteúdo sem recriar o volume — o que
 * exige root no daemon, e contra quem tem root no daemon nenhuma conferência
 * daqui protege. Os builds montam o volume SÓ LEITURA.
 */
export const STORE_REVERIFY_MS = 15 * 60_000
/** O prazo de UMA conferência completa do store, independente de quem pergunta. */
export const STORE_VERIFY_TIMEOUT_MS = 20 * 60_000

/** Espera a promessa até o sinal desistir, sem cancelar o trabalho dela. */
function esperar<T>(promessa: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const desistir = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', desistir, { once: true })
    promessa.then(valor => { signal.removeEventListener('abort', desistir); resolve(valor) }, erro => { signal.removeEventListener('abort', desistir); reject(erro) })
  })
}
export interface PreparedArtifact {
  readonly archivePath: string
  readonly archiveHandle?: FileHandle
  readonly archiveBytes: number
  readonly sha256: string
  readonly files: number
  readonly bytes: number
}
export interface RecoveredBuild { readonly build_ref: string; readonly build_id: string }
export interface BuilderExecutionPort {
  preflight(signal: AbortSignal): Promise<BuilderAttestation>
  reconcile(expected: readonly RecoveredBuild[], signal: AbortSignal): Promise<readonly RecoveredBuild[]>
  prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void>
  execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult>
  cancel(buildRef: string, signal: AbortSignal): Promise<void>
  exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact>
  commitArtifact(buildRef: string, pinnedBuildRefs: ReadonlySet<string>, signal: AbortSignal): Promise<void>
  cleanup(buildRef: string, signal: AbortSignal): Promise<void>
  listManaged(signal: AbortSignal): Promise<readonly string[]>
}

/** Os limites que o adaptador aplica quando ninguém declarou outros. */
export const DEFAULT_BUILDER_LIMITS: BuilderLimits = Object.freeze({
  memoryBytes: 2 * 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256, timeoutMs: 180_000,
  workspaceBytes: 4 * 1024 ** 3, maxWorkspaceBytes: 8 * 1024 ** 3, concurrentContainers: 2,
  maxExportBytes: 2 * 1024 ** 3, maxRetainedExports: 5,
})

/**
 * O hash da POLÍTICA de construção — imagem, escopo, store, comandos, limites e
 * as restrições do contêiner.
 *
 * Ele é FUNÇÃO EXPORTADA, e não conta feita dentro do construtor, porque tem
 * DOIS consumidores que precisam chegar ao mesmo número: o adaptador, que o
 * atesta a cada execução, e o instalador, que o grava na configuração
 * provisionada. A atestação compara os dois (`supervisor-main.ts`) e reprova
 * com `BUILDER_ATTESTATION_FAILED` quando divergem. Uma segunda cópia desta
 * conta no instalador seria a segunda verdade mais cara possível: ela
 * concordaria com esta até o dia em que alguém mudasse um comando ou um limite
 * aqui — e aí toda construção seria recusada, com o instalador jurando que
 * provisionou certo.
 * @param input - o que a política amarra.
 * @returns o SHA-256 em hexadecimal.
 */
export function builderPolicySha256(input: {
  readonly imageDigest: string
  readonly scopeId: string
  readonly templateStoreVersion: string
  readonly templateStoreSha256: string
  readonly limits?: BuilderLimits
}): string {
  return createHash('sha256').update(JSON.stringify({
    protocol: 1, image: input.imageDigest, scope: input.scopeId,
    templateStoreVersion: input.templateStoreVersion, templateStoreSha256: input.templateStoreSha256,
    templateStoreValidator: 'host-canonical-v1', templateStoreMountSteps: ['install'], commands: COMMANDS,
    exportAllowlist: ['.next/standalone/**', '.next/static/**', 'public/**', 'evidence/appspec-report.json'],
    limits: input.limits ?? DEFAULT_BUILDER_LIMITS, user: '10001:10001', network: 'none', readOnlyRoot: true,
    capDrop: ['ALL'], noNewPrivileges: true,
  })).digest('hex')
}

export class DockerBuilderAdapter implements BuilderExecutionPort {
  readonly #limits: BuilderLimits
  readonly #active = new Map<string, string>()
  readonly #buildIds = new Map<string, string>()
  readonly #containers: Semaphore
  readonly #prepares = new Semaphore(1)
  readonly #exports = new Semaphore(1)
  readonly #templateStoreVolume: string
  readonly #policySha256: string
  #storeVerified: { readonly createdAt: string; readonly at: number } | undefined
  #storeVerification: Promise<boolean> | undefined
  constructor(private readonly options: DockerBuilderAdapterOptions) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest)) throw new Error('INVALID_BUILDER_IMAGE')
    if (!isInstallationId(options.installationId) || !isBuilderRuntimeScopeId(options.scopeId)) throw new Error('INVALID_RUNTIME_SCOPE')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u.test(options.templateStoreVersion) || !/^[a-f0-9]{64}$/u.test(options.templateStoreSha256)) throw new Error('INVALID_TEMPLATE_STORE')
    if (!isAbsolute(options.exportRoot) || options.exportRoot.includes('\0')) throw new Error('INVALID_EXPORT_ROOT')
    this.#limits = options.limits ?? DEFAULT_BUILDER_LIMITS
    for (const value of Object.values(this.#limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_BUILDER_LIMIT')
    if (this.#limits.workspaceBytes > this.#limits.maxWorkspaceBytes || this.#limits.maxRetainedExports > 1_000) throw new Error('INVALID_BUILDER_LIMIT')
    this.#containers = new Semaphore(this.#limits.concurrentContainers)
    this.#templateStoreVolume = templateStoreVolumeName(options.installationId, options.scopeId, options.templateStoreVersion, options.templateStoreSha256)
    this.#policySha256 = builderPolicySha256({
      imageDigest: options.imageDigest, scopeId: options.scopeId,
      templateStoreVersion: options.templateStoreVersion, templateStoreSha256: options.templateStoreSha256,
      limits: this.#limits,
    })
  }

  async preflight(signal: AbortSignal): Promise<BuilderAttestation> {
    let state: 'OK' | 'BLOCKED_EXTERNAL' = 'BLOCKED_EXTERNAL'; let imageId = this.options.imageDigest
    try {
      await this.options.engine.ping(signal); imageId = (await this.options.engine.inspectImage(this.options.imageDigest, signal)).Id as `sha256:${string}`
      const storeContentValid = await this.#storeIsValid(signal)
      state = imageId === this.options.imageDigest && storeContentValid ? 'OK' : 'BLOCKED_EXTERNAL'
    } catch { state = 'BLOCKED_EXTERNAL' }
    return { state, protocol_version: 1, scope_id: this.options.scopeId, image_id: /^sha256:[a-f0-9]{64}$/u.test(imageId) ? imageId : this.options.imageDigest, policy_sha256: this.#policySha256 }
  }

  /**
   * O store está íntegro? Conferência completa na primeira vez e quando o
   * volume mudou; depois de `STORE_REVERIFY_MS`, a reconferência roda POR TRÁS
   * e a resposta de agora é a última confirmada para o MESMO volume.
   *
   * Medido em 19/09/2026 no WSL2 do titular: a conferência completa leva
   * minutos, e ela corria presa ao sinal de QUEM perguntou — a tela de saúde
   * (8 s) ou o início de uma criação. O sinal curto cancelava a conferência
   * inteira, ela nunca terminava, e o construtor ficava "indisponível" para
   * sempre depois de 15 min: a criação parava em `BUILDER_UNAVAILABLE` com o
   * gerente de pé. Agora a conferência tem o PRÓPRIO prazo
   * (`STORE_VERIFY_TIMEOUT_MS`); quem pergunta só espera por ela, e desistir
   * de esperar não a cancela. Uma reconferência que reprova derruba a próxima
   * resposta: o que se ganha é não bloquear, e não deixar de conferir.
   */
  async #storeIsValid(signal: AbortSignal): Promise<boolean> {
    const now = this.options.now ?? Date.now
    const rows = await this.options.engine.listVolumes({ name: [this.#templateStoreVolume] }, signal)
    const exact = rows.filter(row => record(row).Name === this.#templateStoreVolume)
    const createdAt = exact.length === 1 && typeof record(exact[0]).CreatedAt === 'string' ? String(record(exact[0]).CreatedAt) : undefined
    // Sem a data de criação não há como saber se é o MESMO volume: não se
    // guarda nada, e a conferência completa roda toda vez.
    const cached = this.#storeVerified
    const mesmoVolume = createdAt !== undefined && cached !== undefined && cached.createdAt === createdAt
    if (mesmoVolume && now() - cached.at < STORE_REVERIFY_MS) return true
    const conferencia = this.#conferirStore(createdAt)
    if (mesmoVolume) return true
    return esperar(conferencia, signal)
  }

  /** Uma conferência completa por vez, com prazo próprio, gravando o resultado para o volume dela. */
  #conferirStore(createdAt: string | undefined): Promise<boolean> {
    const now = this.options.now ?? Date.now
    this.#storeVerification ??= verifyTemplateStoreVolume({ engine: this.options.engine, imageDigest: this.options.imageDigest, installationId: this.options.installationId, scopeId: this.options.scopeId, version: this.options.templateStoreVersion, treeSha256: this.options.templateStoreSha256, volumeName: this.#templateStoreVolume }, AbortSignal.timeout(STORE_VERIFY_TIMEOUT_MS))
      .catch(() => false)
      .then(valid => {
        this.#storeVerified = valid && createdAt !== undefined ? { createdAt, at: now() } : undefined
        return valid
      })
      .finally(() => { this.#storeVerification = undefined })
    return this.#storeVerification
  }

  async reconcile(expected: readonly RecoveredBuild[], signal: AbortSignal): Promise<readonly RecoveredBuild[]> {
    const expectedByRef = new Map<string, string>(); const expectedById = new Map<string, string>()
    for (const row of expected) {
      if (!validBuildRef(row.build_ref) || !validBuildId(row.build_id) || expectedByRef.has(row.build_ref) || expectedById.has(row.build_id)) throw new BuilderSupervisorError('RECOVERY_FAILED')
      expectedByRef.set(row.build_ref, row.build_id); expectedById.set(row.build_id, row.build_ref)
    }
    const filter = managedFilter(this.options.installationId, this.options.scopeId); const [containers, volumes] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal)])
    const recovered = new Map<string, string>(); const ids = new Map<string, string>()
    for (const row of [...containers, ...volumes]) {
      const labels = record(row.Labels); const buildRef = labels['dz23.build_ref']; const buildId = labels['dz23.build_id']
      if (typeof buildRef !== 'string' || !validBuildRef(buildRef) || typeof buildId !== 'string' || !validBuildId(buildId)) throw new BuilderSupervisorError('RECOVERY_FAILED')
      const previous = recovered.get(buildRef); if (previous !== undefined && previous !== buildId) throw new BuilderSupervisorError('RECOVERY_FAILED')
      const idOwner = ids.get(buildId); if (idOwner !== undefined && idOwner !== buildRef) throw new BuilderSupervisorError('RECOVERY_FAILED')
      recovered.set(buildRef, buildId)
      ids.set(buildId, buildRef)
    }
    const exportRefs = await listManagedExportArchives(this.options.exportRoot)
    for (const [buildRef, buildId] of recovered) if (expectedByRef.get(buildRef) !== buildId || expectedById.get(buildId) !== buildRef) throw new BuilderSupervisorError('RECOVERY_FAILED')
    for (const buildRef of exportRefs) if (!expectedByRef.has(buildRef)) throw new BuilderSupervisorError('RECOVERY_FAILED')
    for (const [buildRef, buildId] of recovered) this.#buildIds.set(buildRef, buildId)
    await cleanupManagedExportResources(this.options.exportRoot, undefined, signal)
    return [...recovered].map(([build_ref, build_id]) => ({ build_ref, build_id }))
  }

  async prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void> {
    const release = await this.#prepares.acquire(signal)
    if (this.#buildIds.has(buildRef)) { release(); throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS') }
    if ((this.#buildIds.size + 1) * this.#limits.workspaceBytes > this.#limits.maxWorkspaceBytes) { release(); throw new BuilderSupervisorError('CAPACITY_EXCEEDED') }
    const resources = names(this.options.scopeId, buildRef); const labels = baseLabels(this.options.installationId, this.options.scopeId, buildRef, buildId); let anchor: string | undefined; let volumeCreated = false
    try {
      await this.options.engine.createVolume(resources.volume, { ...labels, 'dz23.resource': 'workspace' }, { type: 'tmpfs', device: 'tmpfs', o: `size=${this.#limits.workspaceBytes},uid=10001,gid=10001,mode=0700` }, signal)
      volumeCreated = true
      anchor = await this.options.engine.createContainer(resources.anchor, containerBody(this.options.imageDigest, ['sleep', 'infinity'], labels, 'anchor', this.#limits, [{ Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false }]), signal)
      /*
        A âncora SOBE antes de receber os arquivos. O volume da área de trabalho
        é `tmpfs`, e um `tmpfs` só é montado quando algum contêiner que o usa
        está rodando: copiar para um contêiner apenas CRIADO grava na camada
        dele, e o `tmpfs` vazio é montado por cima na partida. Medido em
        19/09/2026 no Docker real, na primeira criação com modelo real: o
        `install` respondeu "No package.json found in /workspace" — o código
        gerado estava certo e tinha ido parar debaixo da montagem. O dublê não
        tem montagem, e por isso a ordem antiga passava em todos os testes.
      */
      await this.options.engine.startContainer(anchor, signal)
      if (artifact.archiveHandle !== undefined) {
        if (this.options.engine.putArchiveHandle === undefined) throw new BuilderSupervisorError('RECOVERY_FAILED')
        await this.options.engine.putArchiveHandle(anchor, '/workspace', artifact.archiveHandle, artifact.archiveBytes, signal)
      } else await this.options.engine.putArchive(anchor, '/workspace', artifact.archivePath, artifact.archiveBytes, signal)
      this.#buildIds.set(buildRef, buildId)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (anchor !== undefined) await this.options.engine.removeContainer(anchor, AbortSignal.timeout(10_000)).catch(item => rollbackErrors.push(item))
      if (volumeCreated) await this.options.engine.removeVolume(resources.volume, AbortSignal.timeout(10_000)).catch(item => rollbackErrors.push(item))
      const filter = { label: [...managedFilter(this.options.installationId, this.options.scopeId).label, `dz23.build_ref=${buildRef}`] }
      const [containers, volumes] = await Promise.all([
        this.options.engine.listContainers(filter, AbortSignal.timeout(10_000)).catch(item => { rollbackErrors.push(item); return [{}] }),
        this.options.engine.listVolumes(filter, AbortSignal.timeout(10_000)).catch(item => { rollbackErrors.push(item); return [{}] }),
      ])
      if (rollbackErrors.length > 0 || containers.length > 0 || volumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
      throw error
    } finally { release() }
  }

  async execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult> {
    const buildId = this.#buildIds.get(buildRef); if (buildId === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    const release = await this.#containers.acquire(signal); const resources = names(this.options.scopeId, buildRef); const labels = baseLabels(this.options.installationId, this.options.scopeId, buildRef, buildId)
    let container: string | undefined; let exitCode = -1; let timedOut = false; let outputLimited = false; let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0)
    const timeout = AbortSignal.timeout(this.#limits.timeoutMs); const executionSignal = AbortSignal.any([signal, timeout])
    try {
      container = await this.options.engine.createContainer(resources.step(step), containerBody(this.options.imageDigest, COMMANDS[step], labels, 'step', this.#limits, [
        { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false },
        ...(step === 'install' ? [{ Type: 'volume', Source: this.#templateStoreVolume, Target: '/template-store', ReadOnly: true }] : []),
      ], step), executionSignal)
      this.#active.set(buildRef, container); await this.options.engine.startContainer(container, executionSignal)
      const [completion, logs] = await Promise.all([this.options.engine.waitContainer(container, executionSignal), this.options.engine.containerLogs(container, OUTPUT_LIMIT, executionSignal)])
      exitCode = completion.StatusCode; stdout = logs.stdout; stderr = logs.stderr
    } catch (error) {
      timedOut = timeout.aborted && !signal.aborted; outputLimited = error instanceof Error && error.message === 'DOCKER_RESPONSE_TOO_LARGE'
      if (container !== undefined) await this.options.engine.stopContainer(container, AbortSignal.timeout(10_000)).catch(() => undefined)
      if (!timedOut && !signal.aborted && !outputLimited) throw error
    } finally {
      let cleanupError: unknown
      try { if (container !== undefined) await this.options.engine.removeContainer(container, AbortSignal.timeout(10_000)) }
      catch (error) { cleanupError = error }
      finally { this.#active.delete(buildRef); release() }
      if (cleanupError !== undefined) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    }
    outputLimited ||= stdout.byteLength + stderr.byteLength > OUTPUT_LIMIT
    const stdoutText = sanitized(stdout, OUTPUT_LIMIT); const stderrText = sanitized(stderr, Math.max(0, OUTPUT_LIMIT - Buffer.byteLength(stdoutText)))
    return { exit_code: outputLimited || timedOut || signal.aborted ? -1 : exitCode, stdout: stdoutText, stderr: stderrText, timed_out: timedOut, termination_reason: timedOut ? 'timeout' : outputLimited ? 'output_limit' : null, output_limit_exceeded: outputLimited }
  }

  async cancel(buildRef: string, signal: AbortSignal): Promise<void> { const active = this.#active.get(buildRef); if (active !== undefined) await this.options.engine.stopContainer(active, signal) }

  async exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact> {
    const resources = names(this.options.scopeId, buildRef)
    const release = await this.#exports.acquire(signal); let exporter: string | undefined; let exportVolumeCreated = false; let result: ExportedArtifact | undefined; let operationError: unknown; let archive: Awaited<ReturnType<typeof openManagedExportArchive>> | undefined; let archiveClosed = false
    let etapa = 'publicado-antes'
    try {
      const existing = await readValidatedPublishedArtifact(this.options.exportRoot, buildRef)
      if (existing !== undefined) {
        await cleanupManagedExportResources(this.options.exportRoot, buildRef, signal); result = existing
      } else {
        etapa = 'construcao-conhecida'
        const buildId = this.#buildIds.get(buildRef); if (buildId === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
        etapa = 'limpeza-anterior'
        await cleanupManagedExportResources(this.options.exportRoot, undefined, signal)
        etapa = 'abrir-arquivo'
        archive = await openManagedExportArchive(this.options.exportRoot, buildRef)
        etapa = 'exportador'
        const labels = baseLabels(this.options.installationId, this.options.scopeId, buildRef, buildId)
        await this.options.engine.createVolume(resources.exportVolume, { ...labels, 'dz23.resource': 'export' }, { type: 'tmpfs', device: 'tmpfs', o: `size=${Math.min(EXPORT_ARCHIVE_LIMIT, this.#limits.maxExportBytes)},uid=10001,gid=10001,mode=0700` }, signal)
        exportVolumeCreated = true
        exporter = await this.options.engine.createContainer(resources.exporter, containerBody(this.options.imageDigest, ['node', '-e', EXPORT_SCRIPT], labels, 'export', this.#limits, [
          { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: true },
          { Type: 'volume', Source: resources.exportVolume, Target: '/export', ReadOnly: false },
        ]), signal)
        await this.options.engine.startContainer(exporter, signal)
        const completion = await this.options.engine.waitContainer(exporter, signal)
        if (completion.StatusCode !== 0) {
          const saida = await this.options.engine.containerLogs(exporter, 64 * 1024, AbortSignal.timeout(5_000)).catch(() => undefined)
          this.options.diagnostico?.({ evento: 'exportador-saiu-com-erro', status: completion.StatusCode, saida: saida === undefined ? '' : saida.stderr.toString('utf8').slice(-600) })
          throw new BuilderSupervisorError('EXPORT_INVALID')
        }
        etapa = 'baixar'
        const downloaded = await this.options.engine.downloadArchive(exporter, '/export/.', archive.handle, Math.min(EXPORT_ARCHIVE_LIMIT, this.#limits.maxExportBytes), signal)
        const stat = await archive.handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== archive.dev || stat.ino !== archive.ino || stat.size !== downloaded.bytes) throw new BuilderSupervisorError('EXPORT_INVALID')
        await (this.options.closeArchive?.(archive.handle) ?? archive.handle.close()); archiveClosed = true
        etapa = 'publicar'
        const published = await publishValidatedDockerArchive(this.options.exportRoot, buildRef, archive.path, signal, undefined, { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: downloaded.sha256 })
        result = published
      }
    } catch (error) {
      operationError = error
      this.options.diagnostico?.({ evento: 'exportacao-falhou', etapa, codigo: error instanceof BuilderSupervisorError ? error.code : error instanceof Error ? error.message.slice(0, 200) : 'desconhecido', onde: ondeRecusou(error) })
    }
    const cleanupErrors: unknown[] = []
    try {
      if (exporter !== undefined) {
        await this.options.engine.stopContainer(exporter, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
        await this.options.engine.removeContainer(exporter, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      }
      if (exportVolumeCreated) await this.options.engine.removeVolume(resources.exportVolume, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      const containerFilter = { label: [...managedFilter(this.options.installationId, this.options.scopeId).label, `dz23.build_ref=${buildRef}`, 'dz23.role=export'] }
      const volumeFilter = { label: [...managedFilter(this.options.installationId, this.options.scopeId).label, `dz23.build_ref=${buildRef}`, 'dz23.resource=export'] }
      const [containers, volumes] = await Promise.all([
        this.options.engine.listContainers(containerFilter, AbortSignal.timeout(10_000)).catch(error => { cleanupErrors.push(error); return [{}] }),
        this.options.engine.listVolumes(volumeFilter, AbortSignal.timeout(10_000)).catch(error => { cleanupErrors.push(error); return [{}] }),
      ])
      if (archive !== undefined) { if (!archiveClosed) await (this.options.closeArchive?.(archive.handle) ?? archive.handle.close()).catch(error => cleanupErrors.push(error)); await (this.options.removeArchive?.(archive.path) ?? rm(archive.path, { force: true })).catch(error => cleanupErrors.push(error)) }
      await (this.options.cleanupExportResources ?? cleanupManagedExportResources)(this.options.exportRoot, buildRef, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      if (cleanupErrors.length > 0 || containers.length > 0 || volumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
      if (result === undefined) throw operationError
      return result
    } finally { release() }
  }

  async commitArtifact(buildRef: string, pinnedBuildRefs: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    const release = await this.#exports.acquire(signal)
    try { await enforceExportRetention(this.options.exportRoot, buildRef, pinnedBuildRefs, this.#limits.maxRetainedExports, this.#limits.maxExportBytes, signal) }
    finally { release() }
  }

  async cleanup(buildRef: string, signal: AbortSignal): Promise<void> {
    const filter = { label: [...managedFilter(this.options.installationId, this.options.scopeId).label, `dz23.build_ref=${buildRef}`] }; const errors: unknown[] = []
    const [containers, volumes] = await Promise.all([this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [] }), this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [] })])
    for (const row of containers) {
      const id = identifier(row); if (id === undefined) { errors.push(new Error('INVALID_MANAGED_CONTAINER')); continue }
      try { await this.options.engine.stopContainer(id, signal) } catch (error) { errors.push(error) }
      try { await this.options.engine.removeContainer(id, signal) } catch (error) { errors.push(error) }
    }
    for (const row of volumes) { const name = identifier(row); if (name === undefined) { errors.push(new Error('INVALID_MANAGED_VOLUME')); continue } try { await this.options.engine.removeVolume(name, signal) } catch (error) { errors.push(error) } }
    await (this.options.cleanupExportResources ?? cleanupManagedExportResources)(this.options.exportRoot, buildRef, signal).catch(error => errors.push(error))
    const [remainingContainers, remainingVolumes] = await Promise.all([this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }), this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] })])
    if (errors.length > 0 || remainingContainers.length > 0 || remainingVolumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    this.#active.delete(buildRef); this.#buildIds.delete(buildRef)
  }

  async listManaged(signal: AbortSignal): Promise<readonly string[]> {
    const filter = managedFilter(this.options.installationId, this.options.scopeId); const [containers, volumes, archives] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal), listManagedExportArchives(this.options.exportRoot)])
    const refs = new Set<string>()
    for (const row of [...containers, ...volumes]) { const value = record(row.Labels)['dz23.build_ref']; if (typeof value !== 'string' || !validBuildRef(value)) throw new BuilderSupervisorError('RECOVERY_FAILED'); refs.add(value) }
    for (const value of archives) refs.add(value)
    return [...refs].sort()
  }

}

function containerBody(image: string, command: readonly string[], labels: Readonly<Record<string, string>>, role: string, limits: BuilderLimits, mounts: readonly unknown[], step?: BuildStep): Readonly<Record<string, unknown>> {
  return { Image: image, Cmd: command, WorkingDir: '/workspace', User: '10001:10001', Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'], Labels: { ...labels, 'dz23.role': role, ...(step === undefined ? {} : { 'dz23.step': step }) }, HostConfig: hardenedHost(limits, mounts), NetworkDisabled: true, LogConfig: boundedLogs() }
}
/**
 * O endurecimento do contêiner do construtor, em UM lugar (S-15).
 *
 * Exportado para a PROVA poder consumir exatamente este objeto em vez de
 * redigitar as opções: uma prova que reescreve os argumentos prova a cópia
 * dela, e não o que o produto manda para o Docker — foi assim que
 * `deny: ['network']` sobreviveu no A-06.
 */
export function hardenedHost(limits: BuilderLimits, mounts: readonly unknown[]): Readonly<Record<string, unknown>> { return { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: limits.pids, Memory: limits.memoryBytes, NanoCpus: limits.nanoCpus, OomKillDisable: false, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', Mounts: mounts, ShmSize: 268_435_456, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=268435456,uid=10001,gid=10001' }, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }] } }
function boundedLogs(): Readonly<Record<string, unknown>> { return { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } } }
function names(scopeId: BuilderRuntimeScopeId, buildRef: string) { const slug = randomStable(scopeId, buildRef); return { volume: `dz23-build-work-${slug}`, exportVolume: `dz23-build-export-${slug}`, anchor: `dz23-build-anchor-${slug}`, exporter: `dz23-build-exporter-${slug}`, step: (value: BuildStep) => `dz23-build-${value}-${slug}` } }
function randomStable(scopeId: BuilderRuntimeScopeId, buildRef: string): string { return createHash('sha256').update(`${scopeId}:${buildRef}`).digest('hex').slice(0, 20) }
function baseIdentityLabels(installationId: string, scopeId: BuilderRuntimeScopeId): Readonly<Record<string, string>> { return { 'com.dz23.studio.installation-id': installationId, 'com.dz23.studio.scope-id': scopeId } }
function baseLabels(installationId: string, scopeId: BuilderRuntimeScopeId, buildRef: string, buildId: string): Readonly<Record<string, string>> { return { 'dz23.managed': 'builder', ...baseIdentityLabels(installationId, scopeId), 'dz23.build_ref': buildRef, 'dz23.build_id': buildId } }
function managedFilter(installationId: string, scopeId: BuilderRuntimeScopeId): { readonly label: readonly string[] } { return { label: ['dz23.managed=builder', `com.dz23.studio.installation-id=${installationId}`, `com.dz23.studio.scope-id=${scopeId}`] } }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identifier(value: unknown): string | undefined { const row = record(value); const id = row.Id ?? row.Name; return typeof id === 'string' && id !== '' ? id.replace(/^\//u, '') : undefined }
function validBuildRef(value: string): boolean { return /^build_[a-f0-9]{32}$/u.test(value) }
function validBuildId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value) }
function sanitized(value: Buffer, maximumBytes: number): string {
  const source = value.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''); let result = ''; let bytes = 0
  for (const character of source) { const size = Buffer.byteLength(character); if (bytes + size > maximumBytes) break; result += character; bytes += size }
  return result
}

/**
 * A linha que RECUSOU, tirada da pilha do erro: o leitor do arquivo recusa
 * em trinta lugares com o mesmo código, e o código sozinho não diz qual.
 * Só arquivo e linha do nosso próprio código — nenhum conteúdo.
 * @param error - o erro.
 * @returns `arquivo.js:linha`, ou vazio.
 */
export function ondeRecusou(error: unknown): string {
  const pilha = error instanceof Error && typeof error.stack === 'string' ? error.stack.split('\n').slice(1) : []
  for (const linha of pilha) {
    const achado = /([\w.-]+\.[cm]?[jt]s):(\d+):\d+\)?$/u.exec(linha.trim())
    if (achado !== null && !/\binvalid\b|\bmismatch\b/u.test(linha)) return `${achado[1]}:${achado[2]}`
  }
  return ''
}
