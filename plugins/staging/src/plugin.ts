import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { registerPromptToAppHttpExtension, type PromptToAppActor } from '@dz23-studio/prompt-to-app'
import { roleAllows } from '@dz23-studio/policy'
import { StagingActionApprovalAdapter } from './approval-adapter.js'
import { studioStagingReleasesDomainSpec } from './domain.js'
import { createStagingHttpExtension } from './http.js'
import { LocalStagingProvider, type StagingArtifactBytesPort, type VerifiedFile } from './local-provider.js'
import { DomainStagingRepository } from './repository.js'
import { StagingService } from './service.js'
import { artifactFromRun, selectVerifiedRun, type VerifiedRunView } from './source.js'

export const name = 'dz23-studio-staging'
/**
 * `inject` lista só o que este plugin não sabe viver sem.
 *
 * A autoridade de confirmação fica FORA: ela é opcional no perfil, e listá-la
 * aqui faria o Studio inteiro deixar de subir onde ela não estiver. Sem ela o
 * staging não monta rota nenhuma - o que é diferente de montar uma rota que
 * publica sem confirmação.
 */
export const inject = ['storageDomain', 'studioPromptToApp']

export interface Config {
  /**
   * A pasta onde as versões de teste são publicadas. Caminho absoluto.
   *
   * Ausente, o staging NÃO MONTA. Escolher um diretório padrão seria decidir,
   * pelo dono da instalação, onde o produto dele passa a escrever.
   */
  readonly root?: string
  /** O destino lógico dentro dessa pasta. Um por ambiente de teste. */
  readonly targetRef?: string
  readonly providerId?: string
}

export interface StudioStagingRuntime {
  readonly service: StagingService
  /**
   * `MOUNTED` só quando existe pasta, autoridade de confirmação e domínio
   * aberto. Qualquer outra coisa é `NOT_CONFIGURED`, e a rota responde 503
   * dizendo o que falta - nunca um 404 que pareça "isto não existe".
   */
  readonly state: 'MOUNTED'
  readonly targetRef: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioStaging: StudioStagingRuntime }
}

const DEFAULT_TARGET = 'dz23-target:staging-local'

/**
 * De onde saem os bytes do artefato: a execução que o produziu.
 *
 * O manifesto ATESTADO é lido do disco, e não recalculado: recalcular
 * responderia "o que está lá bate com o que está lá", que é sempre verdade. O
 * que precisa bater é o disco com o que foi ATESTADO na verificação.
 * @param runs - as execuções do prompt-to-app.
 * @returns a porta de bytes.
 */
export function runArtifactBytesPort(directoryOf: (runId: string) => string | undefined): StagingArtifactBytesPort {
  return {
    async open(artifact) {
      const directory = directoryOf(artifact.run_id)
      // Só uma execução que a LEITURA AUTORIZADA acabou de aprovar é
      // resolvível. Procurar a execução aqui de novo daria ao provedor um
      // caminho para bytes que ninguém conferiu que são de quem pediu.
      if (directory === undefined) throw new Error('ARTIFACT_RUN_MISSING')
      const manifestPath = resolve(directory, 'evidence', 'attestation-manifest.json')
      const document = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        readonly artifact_sha256?: unknown
        readonly files?: readonly { readonly path?: unknown, readonly sha256?: unknown }[]
      }
      // O manifesto tem de ser DESTE artefato. Um manifesto de outra execução
      // aprovaria arquivos que ninguém atestou para esta publicação.
      if (document.artifact_sha256 !== artifact.artifact_sha256) throw new Error('ARTIFACT_MANIFEST_MISMATCH')
      const files: VerifiedFile[] = []
      for (const entry of document.files ?? []) {
        if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') throw new Error('ARTIFACT_MANIFEST_INVALID')
        files.push({ path: entry.path, sha256: entry.sha256 })
      }
      if (files.length === 0) throw new Error('ARTIFACT_MANIFEST_EMPTY')
      return { directory, files }
    },
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const root = config.root
  // Sem pasta escolhida não há staging. A rota continua existindo e responde
  // 503 com o motivo; o que não existe é uma publicação que escreve num lugar
  // que ninguém escolheu.
  const unregisterUnconfigured = registerPromptToAppHttpExtension(createStagingHttpExtension(() => undefined))
  if (root === undefined) {
    ctx.effect(() => unregisterUnconfigured, 'studio-staging.httpExtensionUnconfigured')
    return
  }
  unregisterUnconfigured()
  const approvals = ctx.get('studioActionApproval')?.service
  if (approvals === undefined) {
    // A confirmação T2 é a única coisa entre um clique e um efeito fora do
    // Studio. Sem autoridade, o staging não monta - e diz por quê.
    const unregister = registerPromptToAppHttpExtension(createStagingHttpExtension(() => undefined))
    ctx.effect(() => unregister, 'studio-staging.httpExtensionNoApproval')
    return
  }
  const domain: Domain<typeof studioStagingReleasesDomainSpec> = await ctx.storageDomain.open(studioStagingReleasesDomainSpec)
  ctx.effect(() => async () => { await domain.close() }, 'studio-staging.domainClose')
  const targetRef = config.targetRef ?? DEFAULT_TARGET
  const runtime = ctx.studioPromptToApp
  // O caminho da execução autorizada, guardado no momento em que a leitura
  // passou pelo escopo. É o único jeito de o provedor achar os bytes sem
  // procurar por conta própria.
  const authorizedDirectories = new Map<string, string>()
  const service = new StagingService({
    repository: new DomainStagingRepository(domain.table('releases')),
    source: {
      async verifiedArtifact(actor, projectId, runId) {
        const rows = runtime.service.runs(actor as unknown as PromptToAppActor, projectId) as readonly (VerifiedRunView & { readonly run_directory: string })[]
        const run: VerifiedRunView & { readonly run_directory: string } = selectVerifiedRun(rows, projectId, { orgId: actor.orgId, tenantId: actor.tenantId }, runId) as VerifiedRunView & { readonly run_directory: string }
        const artifact = artifactFromRun(run)
        authorizedDirectories.set(run.run_id, run.run_directory)
        return await Promise.resolve(artifact)
      },
    },
    approvals: new StagingActionApprovalAdapter(approvals),
    provider: new LocalStagingProvider({
      targetRef, root,
      ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
      artifacts: runArtifactBytesPort(runId => authorizedDirectories.get(runId)),
    }),
    authorization: { allows: roleAllows },
  })
  const unregister = registerPromptToAppHttpExtension(createStagingHttpExtension(() => service))
  ctx.effect(() => unregister, 'studio-staging.httpExtension')
  ctx.provide('studioStaging', { service, state: 'MOUNTED', targetRef })
}
