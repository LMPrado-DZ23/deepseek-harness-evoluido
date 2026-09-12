import { deflateSync } from 'node:zlib'

import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { createDesignSpec } from '../src/design.js'
import type { StudioPlan, StudioRun } from '../src/model.js'
import { ModelCodeGenerator, PromptToAppPipeline, type CodeGenerationResult, type CodeGeneratorPort } from '../src/pipeline.js'
import { generationRules } from '../src/import-policy.js'
import { BuilderLifecycleError, type BuildStep, type BuilderLifecycleFinished, type BuilderLifecycleResolverPort, type BuilderLifecycleSession, type BuilderLifecycleStepResult } from '../src/builder-lifecycle.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from '../src/service.js'
import { latestGreenCheckpoint, runCheckpoints } from '../src/checkpoint.js'

const actor: PromptToAppActor = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Apresentar serviços.', audience: 'Clientes', journeys: ['Conhecer serviços'],
  pages: [{ name: 'Início', sections: ['Serviços'] }], entities: [], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A página tem um título.'],
}
const plan: StudioPlan = {
  plan_id: 'plan', spec_id: 'spec', project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId,
  slices: [{ slice_id: 'slice', title: 'Página', description: 'Criar página', acceptance_criteria: ['Compila'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'] }],
  status: 'APPROVED', created_at: '2026-09-03T12:00:00.000Z', updated_at: '2026-09-03T12:00:00.000Z',
}
const cleanGeneration = {
  files: [
    { path: 'content/app.json', content: '{"title":"Aurora","description":"Serviços"}' },
    { path: 'src/GeneratedApp.tsx', content: 'export default function GeneratedApp(){ return <main><h1>Início</h1><h2>Serviços</h2></main> }' },
  ], route: 'ollama', model: 'qwen', inputTokens: 10, outputTokens: 20,
} as const
/**
 * Um gerador que escreve ALGO DIFERENTE a cada chamada — que e o que um modelo
 * faz ao receber uma correcao.
 *
 * Um duble que devolve o mesmo arquivo tres vezes e repeticao POR CONSTRUCAO, e
 * desde a OS-65 o laco para nela. Um teste sobre as tres tentativas precisa de
 * um gerador que ao menos TENTE outra coisa; se ele nao tentar, o que o teste
 * mede deixa de ser o laco e passa a ser o duble.
 *
 * So o codigo varia: `content/app.json` e JSON, e sujar o JSON trocaria o
 * defeito que o teste quer exercer por um erro de sintaxe.
 */
function varying<T extends CodeGenerationResult>(base: T = cleanGeneration as unknown as T) {
  let call = 0
  return vi.fn(async (): Promise<T> => {
    call += 1
    return {
      ...base,
      files: base.files.map(file => file.path.endsWith('.json')
        ? { ...file }
        : { ...file, content: `${file.content}\n// tentativa ${call}` }),
    }
  })
}

/**
 * Um PNG REAL, montado aqui, para o teste exercitar o leitor de verdade.
 *
 * Uma foto falsificada por duble provaria que o duble sabe devolver bytes.
 * `tinta` diz quantos pixels sao escuros: zero e uma tela de uma cor so.
 */
function pngSolido(width: number, height: number, fundo: readonly [number, number, number, number], tinta = 0): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 4 + 1) + 1 + x * 4
      const escuro = y * width + x < tinta
      raw[at] = escuro ? 20 : fundo[0]; raw[at + 1] = escuro ? 20 : fundo[1]
      raw[at + 2] = escuro ? 20 : fundo[2]; raw[at + 3] = fundo[3]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

interface FixtureExecutionResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly outputLimitExceeded?: boolean }
interface FixtureOptions {
  readonly preflight?: 'OK' | 'BLOCKED_EXTERNAL'
  readonly execute?: (directory: string, command: string) => Promise<FixtureExecutionResult>
  readonly finish?: BuilderLifecycleSession['finish']
  readonly emergencyStop?: { assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void }
  readonly generationTokenBudget?: number
  /**
   * O armazenamento PERDE a gravacao: `putRun` aceita e `runs()` nao devolve.
   *
   * Nao e cenario inventado — e o que um armazenamento com escrita assincrona,
   * uma transacao revertida ou uma leitura em replica atrasada produzem. E e o
   * unico jeito de exercitar o que a revisao independente faz quando o registro
   * que ela precisa ler nao esta la.
   */
  readonly forgetRuns?: boolean
  /** Execucoes ANTERIORES que este espaco de trabalho ja viu (T-20). */
  readonly history?: StudioRun[]
}

/**
 * Uma OPERACAO anterior: uma tentativa que falhou, e a seguinte que passou.
 *
 * O relogio do dobro esta parado em 03/09, entao as datas ficam ANTES dele: uma
 * observacao do futuro e descartada de proposito pelo motor, e usa-la aqui
 * faria o teste passar por acidente.
 */
function historico(id: string, dia: number, falha = 'install: exit 1'): StudioRun[] {
  const base = { project_id: 'project', plan_id: 'plan', attempt: 1, steps: [] } as unknown as StudioRun
  return [
    { ...base, run_id: `${id}-1`, operation_id: id, attempt: 1, state: 'FAILED', failure_code: falha,
      started_at: `2026-09-0${String(dia)}T09:00:00.000Z`, finished_at: `2026-09-0${String(dia)}T10:00:00.000Z` },
    { ...base, run_id: `${id}-2`, operation_id: id, attempt: 2, state: 'PASSED', failure_code: null,
      started_at: `2026-09-0${String(dia)}T10:30:00.000Z`, finished_at: `2026-09-0${String(dia)}T11:00:00.000Z` },
  ] as StudioRun[]
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-pipeline-test-')); roots.push(root)
  const templateDirectory = resolve(root, 'template'); const runsRoot = resolve(root, 'runs')
  await mkdir(resolve(templateDirectory, 'src'), { recursive: true })
  await writeFile(resolve(templateDirectory, 'package.json'), '{"private":true}')
  await writeFile(resolve(templateDirectory, 'src/App.tsx'), 'export default function App(){ return null }')
  await writeFile(resolve(templateDirectory, 'next-env.d.ts'), '/// generated by Next.js')
  let state = 'PLAN_APPROVED'
  const runs: StudioRun[] = []; const transitions: string[] = []; const evidence: { kind: string; relative_path: string }[] = []
  const service = {
    project: vi.fn(() => ({ state, category: 'landing-page' })), plan: vi.fn(() => plan), latestSpec: vi.fn(() => ({ app_spec: spec })),
    designOrDefault: vi.fn(() => createDesignSpec({ preset: 'modern' })),
    transition: vi.fn(async (_actor, _projectId, to: string) => { state = to; transitions.push(to); return { state } }),
    putRun: vi.fn(async (_actor, run: StudioRun) => { runs.push(run) }),
    // `runs` existe aqui porque a RETOMADA precisa achar a execução anterior:
    // sem esta leitura, `findResumable` não tem onde procurar o diretório da
    // tentativa cancelada.
    runs: vi.fn(() => (options.forgetRuns === true ? [] : [...runs, ...(options.history ?? [])])),
    // O aprendizado (T-20) le o HISTORICO deste espaco de trabalho, e para
    // chegar nele precisa passar pelos projetos. Sem esta porta no dobro a
    // leitura lancaria, o `catch` devolveria `undefined`, e o aviso nunca
    // seria exercitado por teste nenhum.
    listProjects: vi.fn(() => [{ project_id: 'project' }]),
    putEvidence: vi.fn(async (_actor, item: { kind: string; relative_path: string }) => { evidence.push(item) }),
  }
  const executeImplementation: NonNullable<FixtureOptions['execute']> = options.execute ?? (async (): Promise<FixtureExecutionResult> => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }))
  const execute = vi.fn(executeImplementation)
  let preparedDirectory = ''; let buildState: 'PREPARED' | 'INSTALL_OK' | 'BUILD_OK' | 'TEST_OK' | 'E2E_OK' | 'FAILED' | 'CANCELLED' = 'PREPARED'
  const builder: BuilderLifecycleSession = {
    preflight: vi.fn(async () => options.preflight === 'BLOCKED_EXTERNAL'
      ? { state: 'BLOCKED_EXTERNAL' as const }
      : { state: 'OK' as const }),
    prepare: vi.fn(async directory => { preparedDirectory = directory; buildState = 'PREPARED'; return { buildRef: 'build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
    execute: vi.fn(async (_buildRef: string, step: BuildStep) => {
      const command = ({ install: 'pnpm install --offline', build: 'pnpm run build', test: 'pnpm run test', e2e: 'pnpm run test:e2e' } as const)[step]
      const result = await execute(preparedDirectory, command)
      buildState = result.exitCode === 0 ? ({ install: 'INSTALL_OK', build: 'BUILD_OK', test: 'TEST_OK', e2e: 'E2E_OK' } as const)[step] : 'FAILED'
      return { state: buildState, step, result: { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timed_out: result.timedOut, termination_reason: result.outputLimitExceeded === true ? 'output_limit' as const : result.timedOut ? 'timeout' as const : null, output_limit_exceeded: result.outputLimitExceeded === true } }
    }),
    cancel: vi.fn(async () => { buildState = 'CANCELLED' }),
    finish: vi.fn(options.finish ?? (async () => ({ finalState: buildState === 'E2E_OK' ? 'E2E_OK' as const : buildState === 'CANCELLED' ? 'CANCELLED' as const : 'FAILED' as const, exported: buildState === 'E2E_OK' ? { relative_path: 'exports/build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), files: 1, bytes: 1 } : null, cleanupPending: false, cleaned: true }))),
    listManaged: vi.fn(async () => []),
  }
  const resolver: BuilderLifecycleResolverPort<PromptToAppActor> = { forActor: vi.fn(async () => builder) }
  let id = 0
  const pipeline = new PromptToAppPipeline({
    service: service as unknown as PromptToAppService, builder: resolver,
    templateDirectory, runsRoot, now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `id-${++id}`,
    ...(options.emergencyStop === undefined ? {} : { emergencyStop: options.emergencyStop }),
    ...(options.generationTokenBudget === undefined ? {} : { generationTokenBudget: options.generationTokenBudget }),
  })
  return { pipeline, service, builder, resolver, execute, runs, transitions, evidence, templateDirectory, runsRoot }
}

describe('Prompt-to-App pipeline', () => {
  it('T-08: a MESMA falha repetida muda o pedido — a terceira tentativa nao pede igual a segunda', async () => {
    // O laco tenta tres vezes e passa ao gerador o diagnostico da vez
    // anterior. Falhando sempre pelo mesmo motivo, a terceira pedia
    // exatamente a mesma correcao da segunda: mesma falha, mesma estrategia.
    const f = await fixture({ execute: async () => ({ exitCode: 1, stdout: '', stderr: 'sempre a mesma falha', timedOut: false }) })
    const generator: CodeGeneratorPort = { generate: varying() }
    await f.pipeline.run(actor, 'project', generator)

    expect(generator.generate).toHaveBeenCalledTimes(3)
    const pedidos = vi.mocked(generator.generate).mock.calls.map(call => call[2])
    // A primeira nao tem correcao nenhuma: nada falhou ainda.
    expect(pedidos[0]).toBeUndefined()
    // A segunda leva o diagnostico cru da primeira.
    expect(pedidos[1]).toBeDefined()
    expect(pedidos[1]).not.toContain('Mude de estratégia')
    // A TERCEIRA leva o aviso: aquela correcao ja foi pedida e deu no mesmo.
    expect(pedidos[2]).toContain('Mude de estratégia')
    // E o diagnostico original continua la: mudar de abordagem nao e esquecer
    // qual era o problema.
    expect(pedidos[2]).toContain(pedidos[1]!)
  })

  it.skipIf(process.platform === 'win32')('rejects a template symlink before creating a run or changing project state', async () => {
    const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'dz23-template-outside-')); roots.push(outside)
    await symlink(outside, resolve(f.templateDirectory, 'linked'), 'dir')
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    await expect(f.pipeline.run(actor, 'project', generator)).rejects.toThrow('Link simbólico')
    expect(generator.generate).not.toHaveBeenCalled()
    expect(f.runs).toEqual([])
    expect(f.transitions).toEqual([])
  })

  /**
   * O ciclo do construtor relatando o que os testes do app gerado acharam.
   *
   * O relatório de aceitação é escrito pelo pipeline com todos os critérios
   * `PENDING`; quem os resolve é a suíte do próprio app, no passo `test`. Este
   * duplo faz exatamente isso - e nada além disso.
   */
  const reportingExecute = (statuses: 'PASSED' | 'FAILED' | 'PENDING') => async (directory: string, command: string) => {
    if (command === 'pnpm run test') {
      const path = resolve(directory, 'evidence', 'appspec-report.json')
      const report = JSON.parse(await readFile(path, 'utf8')) as { checks: { status: string }[] }
      for (const check of report.checks) if (check.status === 'PENDING') check.status = statuses
      await writeFile(path, JSON.stringify(report), 'utf8')
    }
    return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
  }

  const attestingFinish: BuilderLifecycleSession['finish'] = async (): Promise<BuilderLifecycleFinished> => ({
    finalState: 'E2E_OK',
    exported: { relative_path: 'exports/build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), files: 1, bytes: 1 },
    cleanupPending: false, cleaned: true,
    attestation: { image_digest: `sha256:${'d'.repeat(64)}`, policy_sha256: 'f'.repeat(64), scope_id: 's_1' },
  })

  /**
   * T-12 — REVISAO INDEPENDENTE. Contra o PIPELINE, e nao contra a funcao pura:
   * a licao da OS-61 e da OS-65 e que a sabotagem na fiacao sobrevive a
   * qualquer teste que so exercite o motor.
   */
  it('um critério deixado por conferir NUNCA chega a protótipo verificado', async () => {
    // Fui procurar o buraco que a revisao independente pegaria: uma suite que
    // sai zero sem exercitar um criterio deixa a linha dele PENDENTE. O buraco
    // NAO EXISTE — quem o fecha e a atestacao de aceitacao, antes da revisao.
    // Este teste fica porque prova a propriedade, e nao porque prova quem a
    // garante: se um dia a atestacao parar de conferir, a revisao e o segundo
    // muro, e este teste continua valendo sem ser reescrito.
    const f = await fixture({ execute: reportingExecute('PENDING'), finish: attestingFinish })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })

    expect(result.state).not.toBe('VERIFIED_PROTOTYPE')
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
  })

  /**
   * T-18 — a tela que abre EM BRANCO. Contra o pipeline, e nao contra a funcao
   * pura: e a fiacao que decide se alguem olha para a foto.
   */
  it('uma criação que compila, testa e abre EM BRANCO NÃO é protótipo verificado', async () => {
    // Este e o defeito mais constrangedor do produto: tudo verde, e a pagina
    // branca. Todo o resto do pipeline olha para o que o computador executou.
    const branca = pngSolido(40, 40, [255, 255, 255, 255])
    const f = await fixture({
      execute: async (directory, command) => {
        if (command === 'pnpm run test') {
          const path = resolve(directory, 'evidence', 'appspec-report.json')
          const report = JSON.parse(await readFile(path, 'utf8')) as { checks: { status: string }[] }
          for (const check of report.checks) if (check.status === 'PENDING') check.status = 'PASSED'
          await writeFile(path, JSON.stringify(report), 'utf8')
          await writeFile(resolve(directory, 'evidence', 'screenshot-home.png'), branca)
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
      finish: attestingFinish,
    })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })

    expect(result.state).not.toBe('VERIFIED_PROTOTYPE')
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
    expect(result.message).toContain('BLANK_SCREEN')
  })

  it('captura AUSENTE não reprova: reprovar seria reprovar por defeito do observador', async () => {
    // A suite gerada pode nao ter tirado a foto — template antigo, passo que
    // nao chegou a rodar. Isso nao e uma tela em branco.
    const f = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(result.state).toBe('VERIFIED_PROTOTYPE')
  })

  it('uma tela COM conteúdo passa', async () => {
    const comConteudo = pngSolido(40, 40, [255, 255, 255, 255], 400)
    const f = await fixture({
      execute: async (directory, command) => {
        if (command === 'pnpm run test') {
          const path = resolve(directory, 'evidence', 'appspec-report.json')
          const report = JSON.parse(await readFile(path, 'utf8')) as { checks: { status: string }[] }
          for (const check of report.checks) if (check.status === 'PENDING') check.status = 'PASSED'
          await writeFile(path, JSON.stringify(report), 'utf8')
          await writeFile(resolve(directory, 'evidence', 'screenshot-home.png'), comConteudo)
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
      finish: attestingFinish,
    })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) }))
      .resolves.toMatchObject({ state: 'VERIFIED_PROTOTYPE' })
  })

  it('registro que sumiu entre gravar e ler NÃO é aprovação', async () => {
    // A revisao pede o registro que o pipeline acabou de gravar. Se ele nao
    // esta la, isso nao e "sem problemas": e a propria prova sumindo. Tratar
    // ausencia como confirmacao seria aprovar justamente quando o sistema
    // acabou de demonstrar que nao consegue guardar o que afirma.
    const f = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish, forgetRuns: true })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })

    expect(result.state).not.toBe('VERIFIED_PROTOTYPE')
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
    // E o REGISTRO nao fica dizendo `PASSED`. Ele foi gravado como aprovado um
    // instante antes da revisao rodar; sem a regravacao, o armazenamento
    // guardaria uma execucao aprovada de um projeto reprovado — a propria
    // revisao criando a contradicao que ela existe para denunciar.
    // A ULTIMA gravacao desta execucao. O duble ACUMULA as chamadas; o
    // armazenamento de verdade grava por chave, entao a ultima e a que fica.
    const ultimo = f.runs.at(-1)!
    expect(ultimo.state).toBe('FAILED')
    expect(ultimo.artifact_sha256).toBeNull()
  })

  it('a aprovação CARREGA o aviso sobre critérios que ninguém conferiu por máquina', async () => {
    // O aviso nao desmente a aprovacao; ele viaja junto dela. Sem isso a pessoa
    // le "verificado" sobre um criterio que ninguem conferiu.
    // O criterio do fixture — "A página tem um título." — e prosa sem literal
    // extraivel, entao ele nasce NOT_AUTOMATED e nenhuma maquina o confere.
    const f = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })

    expect(result.state).toBe('VERIFIED_PROTOTYPE')
    // Em campo PROPRIO, e nao dentro de `message`: `message` e renderizado como
    // "Codigo da falha" em fonte de codigo, debaixo de "Detalhes tecnicos" — o
    // lugar que o produto ensina a pessoa a ignorar.
    expect(result.notice).toContain('Confira você mesmo')
    expect(result.message).not.toContain('Confira você mesmo')
  })

  it('conclui a jornada quando o construtor declara imagem e política, gravando as quatro atestações', async () => {
    // O caminho de SUCESSO estava morto: um ciclo que passava lançava
    // ACCEPTANCE_ATTESTATION_UNAVAILABLE e levava embora VERIFIED_PROTOTYPE, a
    // prévia e o aviso à pessoa. Este é o teste que prova que ele voltou.
    const f = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(result).toMatchObject({ state: 'VERIFIED_PROTOTYPE', attempts: 1 })
    expect(f.transitions).toEqual(['GENERATING', 'BUILD_OK', 'TESTS_OK', 'VERIFIED_PROTOTYPE'])
    const run = f.runs.at(-1)!
    expect(run).toMatchObject({ state: 'PASSED', stage: 'verify', artifact_sha256: 'a'.repeat(64), template_integrity: 'VERIFIED' })
    // Os RESUMOS ficam no registro; os documentos inteiros vivem em evidence/.
    // Um manifesto completo dentro da chave-valor cresceria sem teto.
    expect(run.attestations).toEqual({
      acceptance_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sbom_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provenance_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      builder_image_digest: `sha256:${'d'.repeat(64)}`,
      policy_sha256: 'f'.repeat(64),
    })
    const written = f.evidence.map(item => item.relative_path)
    for (const name of ['acceptance', 'manifest', 'sbom', 'provenance']) {
      expect(written.some(path => path.endsWith(`evidence/attestation-${name}.json`)), name).toBe(true)
    }
    // A atestação de aceitação diz APROVADO e mostra em quê se baseou.
    const directory = run.run_directory
    const acceptance = JSON.parse(await readFile(resolve(directory, 'evidence/attestation-acceptance.json'), 'utf8')) as Record<string, unknown>
    expect(acceptance).toMatchObject({
      kind: 'dz23.acceptance', verdict: 'PASSED', template_integrity: 'VERIFIED',
      builder: { image_digest: `sha256:${'d'.repeat(64)}`, policy_sha256: 'f'.repeat(64), scope_id: 's_1' },
    })
    expect((acceptance.summary as { failed: number, pending: number })).toMatchObject({ failed: 0, pending: 0 })
    // A proveniência não se cala sobre o que ela NÃO prova.
    const provenance = JSON.parse(await readFile(resolve(directory, 'evidence/attestation-provenance.json'), 'utf8')) as Record<string, unknown>
    expect(provenance).toMatchObject({ signed: false, manifest_sha256: run.attestations!.manifest_sha256 })
    // O SBOM lista o que o app declara - aqui, um package.json sem dependência
    // nenhuma, que é "declarado com zero" e não "indisponível".
    const sbom = JSON.parse(await readFile(resolve(directory, 'evidence/attestation-sbom.json'), 'utf8')) as Record<string, unknown>
    expect(sbom).toMatchObject({ source: 'declared', unavailable_reason: null, components: [] })
  })

  it('grava cada passo do construtor ENQUANTO ele acontece, e não só no fim', async () => {
    // "A ideia desse projeto é ver a construção em tempo real." A tela mostrava
    // uma frase por ETAPA - `build` ou `test` -, e o construtor roda quatro
    // passos dentro dessas duas. Durante os minutos mais longos do produto a
    // pessoa via um texto imóvel enquanto quatro coisas diferentes aconteciam,
    // e "trabalhando" e "travado" tinham a mesma aparência.
    //
    // O que este teste afirma é o TEMPO REAL, não o resultado: existe um
    // registro em que `install` já terminou e `build` está em andamento. Um
    // registro que só ganhasse os passos no fim passaria por um teste que
    // olhasse apenas `runs.at(-1)` - e não mostraria nada a ninguém enquanto a
    // espera acontece, que é o defeito inteiro.
    const f = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })

    const live = f.runs.find(run => run.steps?.some(entry => entry.state === 'RUNNING'))
    expect(live, 'nenhum registro pegou um passo em andamento').toBeDefined()

    const midway = f.runs.find(run =>
      run.steps?.[0]?.step === 'install' && run.steps[0].state === 'PASSED'
      && run.steps[1]?.step === 'build' && run.steps[1].state === 'RUNNING')
    expect(midway, 'nenhum registro mostra install pronto com build em andamento').toBeDefined()
    // O passo em andamento não tem fim: inventar um seria mostrar duração para
    // algo que ainda está acontecendo.
    expect(midway!.steps![1]!.finished_at).toBeNull()
    expect(midway!.steps![0]!.finished_at).not.toBeNull()

    // No fim, os quatro passos estão lá, na ordem do construtor, todos fechados.
    const final = f.runs.at(-1)!
    expect(final.steps?.map(entry => entry.step)).toEqual(['install', 'build', 'test', 'e2e'])
    expect(final.steps?.every(entry => entry.state === 'PASSED')).toBe(true)
    expect(final.steps?.every(entry => entry.finished_at !== null)).toBe(true)
  })

  it('um passo que reprova é gravado como reprovado, e os seguintes não aparecem', async () => {
    // Um passo eternamente RUNNING faria a tela girar para sempre num passo que
    // já acabou - a aparência exata de um travamento. E um passo que nunca
    // rodou NÃO pode aparecer: ausência aqui quer dizer "não chegou a
    // acontecer", nunca "pulado com sucesso".
    const f = await fixture({
      execute: async (_directory: string, command: string) => command.includes('build')
        ? { exitCode: 1, stdout: '', stderr: 'erro de compilação', timedOut: false }
        : { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false },
    })
    await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    const withSteps = f.runs.filter(run => run.steps !== undefined && run.steps.length > 0)
    expect(withSteps.length).toBeGreaterThan(0)
    const last = withSteps.at(-1)!
    expect(last.steps!.map(entry => [entry.step, entry.state])).toEqual([['install', 'PASSED'], ['build', 'FAILED']])
    expect(last.steps!.every(entry => entry.state !== 'RUNNING')).toBe(true)
  })

  it('uma criação cancelada RETOMA de onde parou, sem chamar o modelo de novo', async () => {
    // Cancelar recomeçava do ZERO. Quem apertava "Cancelar" depois de esperar
    // — porque precisava do computador, porque fechou o navegador — perdia a
    // geração inteira e pagava o modelo outra vez.
    //
    // E o custo é o MENOR dos dois problemas. Geração não é determinística:
    // pedir de novo, com o mesmo plano, devolve um aplicativo DIFERENTE. A
    // pessoa aprovava um plano, esperava, cancelava, mandava recomeçar — e
    // recebia outra coisa. Retomar é o que faz a segunda tentativa entregar o
    // que a primeira estava construindo.
    const controller = new AbortController()
    const f = await fixture({
      // O cancelamento acontece DEPOIS da geração e DENTRO da construção, que
      // é exatamente a janela em que havia trabalho para perder.
      execute: async (_directory: string, command: string) => {
        if (command.includes('run build')) controller.abort()
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    })
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    const cancelled = await f.pipeline.run(actor, 'project', generator, { signal: controller.signal })
    expect(cancelled).toMatchObject({ state: 'CANCELLED' })
    expect(generator.generate).toHaveBeenCalledTimes(1)
    const cancelledRun = f.runs.at(-1)!
    expect(cancelledRun.state).toBe('CANCELLED')

    // O marco de geração ficou em disco: é ele que torna a retomada um FATO
    // verificável, e não uma suposição sobre o que sobrou na pasta.
    const marker = JSON.parse(await readFile(resolve(cancelledRun.run_directory, 'generation.json'), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ plan_id: plan.plan_id, attempt: 1, route: 'ollama', model: 'qwen' })

    // Segunda execução, sem sinal de cancelamento: retoma.
    const second = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    // A mesma pasta e a mesma memória de execuções da primeira.
    second.runs.push(...f.runs)
    const resumedGenerator = { generate: vi.fn(async () => cleanGeneration) }
    await second.service.transition(actor, 'project', 'CANCELLED')
    second.runs.length = 0
    second.runs.push(cancelledRun)
    const result = await second.pipeline.run(actor, 'project', resumedGenerator)

    // O MODELO NÃO FOI CHAMADO. Esta é a afirmação inteira.
    expect(resumedGenerator.generate).not.toHaveBeenCalled()
    expect(result.state).toBe('VERIFIED_PROTOTYPE')
    // E a retomada não é invisível: o registro diz de onde veio, senão ninguém
    // conseguiria auditar depois qual geração produziu o artefato.
    expect(second.runs.at(-1)?.resumed_from_run_id).toBe(cancelledRun.run_id)
  })

  it('NÃO retoma quando o plano mudou depois do cancelamento', async () => {
    // Os arquivos guardados respondem à pergunta ANTIGA. Reaproveitá-los depois
    // que a pessoa mudou o plano entregaria calado o aplicativo que ela acabou
    // de deixar de querer — que é pior do que gerar de novo.
    const controller = new AbortController()
    const f = await fixture({
      execute: async (_directory: string, command: string) => {
        if (command.includes('run build')) controller.abort()
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    })
    await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) }, { signal: controller.signal })
    const cancelledRun = f.runs.at(-1)!

    const second = await fixture({ execute: reportingExecute('PASSED'), finish: attestingFinish })
    second.runs.length = 0
    second.runs.push(cancelledRun)
    await second.service.transition(actor, 'project', 'CANCELLED')
    // O plano de agora é outro.
    second.service.plan.mockReturnValue({ ...plan, plan_id: 'plano-diferente' })
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    await second.pipeline.run(actor, 'project', generator)
    expect(generator.generate).toHaveBeenCalledTimes(1)
    expect(second.runs.at(-1)?.resumed_from_run_id).toBeUndefined()
  })

  it('NÃO retoma uma execução que REPROVOU: repetir existe para corrigir', async () => {
    // "Tentar novamente" depois de uma reprovação precisa gerar de novo, com o
    // diagnóstico do que falhou. Reaproveitar a geração reprovada entregaria o
    // mesmo defeito com outro nome, e a pessoa apertaria o botão para sempre.
    const f = await fixture({
      execute: async (_directory: string, command: string) => command.includes('run build')
        ? { exitCode: 1, stdout: '', stderr: 'quebrou', timedOut: false }
        : { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false },
    })
    const generator = { generate: varying() }
    const failed = await f.pipeline.run(actor, 'project', generator)
    expect(failed.state).toBe('BUILD_FAILED')
    // Três tentativas, três chamadas: o marco existe em disco e mesmo assim
    // NENHUMA delas retomou.
    expect(generator.generate).toHaveBeenCalledTimes(3)
    expect(f.runs.every(run => run.resumed_from_run_id === undefined)).toBe(true)
  })

  it('um critério REPROVADO derruba a atestação, e o ciclo verde do construtor não salva a execução', async () => {
    // O veredito da atestação é o que a pessoa vai mostrar a alguém: ele manda
    // sobre o "passou" do construtor.
    const f = await fixture({ execute: reportingExecute('FAILED'), finish: attestingFinish })
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(result).toMatchObject({ state: 'TESTS_FAILED' })
    expect(f.runs.some(run => run.state === 'PASSED')).toBe(false)
    expect(f.runs.at(-1)).toMatchObject({ failure_code: 'ACCEPTANCE_ATTESTATION_FAILED' })
    expect(f.runs.at(-1)?.attestations).toBeUndefined()
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
  })

  it('does not promote supervisor success while the authenticated exported acceptance report is unavailable', async () => {
    const f = await fixture(); const generator = { generate: vi.fn(async () => cleanGeneration) }
    const result = await f.pipeline.run(actor, 'project', generator)
    expect(result).toMatchObject({ state: 'BLOCKED_EXTERNAL', attempts: 1 })
    expect(f.transitions).toEqual(['GENERATING', 'INTERRUPTED'])
    expect(f.execute).toHaveBeenCalledTimes(4)
    expect(f.resolver.forActor).toHaveBeenCalledOnce()
    expect(f.runs.at(-1)).toMatchObject({ stage: 'verify', state: 'BLOCKED_EXTERNAL', failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', artifact_sha256: null })
    expect(f.runs.some(run => run.state === 'PASSED')).toBe(false)
    expect(f.runs.flatMap(run => run.acceptance_checks).some(check => check.status === 'PENDING')).toBe(true)
    expect(f.runs.at(-1)).toMatchObject({ operation_id: expect.any(String), owner_session_id: 'direct-execution' })
    // Uma execução bloqueada não promove nada, mas EXPLICA: o relato do que
    // aconteceu é a única evidência gravada, e é o que tira a pessoa de um
    // código em inglês. Nenhuma evidência de build ou artefato aparece aqui.
    expect(f.evidence.map(item => item.kind)).toEqual(['diff'])
    expect(f.evidence[0]?.relative_path).toMatch(/run-report\.json$/u)
  })

  it('rejects hostile operation identifiers before creating a run path', async () => {
    const f = await fixture(); const escaped = resolve(f.runsRoot, '..', 'escaped')
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) }, { operationId: '../escaped' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(lstat(escaped)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.runs).toEqual([])
    expect(f.transitions).toEqual([])
  })

  it.each([
    ['missing checks', '{}'],
    ['invalid JSON', '{'],
    ['empty checks', '{"schema_version":1,"checks":[]}'],
  ])('fails closed when the AppSpec report has %s', async (_case, content) => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run test:e2e') await writeFile(resolve(directory, 'evidence/appspec-report.json'), content)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'TESTS_FAILED' })
    expect(f.runs.some(run => run.state === 'PASSED')).toBe(false)
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
    expect(f.runs.at(-1)).toMatchObject({ state: 'FAILED', failure_code: 'APPSPEC_REPORT_INVALID' })
  })

  it('never records PASS when finish cannot prove cleanup', async () => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run test:e2e') await passAcceptance(directory)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    }, finish: async () => ({ finalState: 'E2E_OK', exported: { relative_path: 'exports/build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), files: 1, bytes: 1 }, cleanupPending: true, cleaned: false }) })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL', attempts: 1 })
    expect(f.runs.at(-1)).toMatchObject({ state: 'BLOCKED_EXTERNAL', failure_code: 'FINISH_INCONCLUSIVE', artifact_sha256: null })
    expect(f.transitions).toEqual(['GENERATING', 'INTERRUPTED'])
    expect(f.service.project()).toMatchObject({ state: 'INTERRUPTED' })
  })

  it('terminalizes an unexpected test-process failure without leaving GENERATING', async () => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run build') await writeRuntimeOutput(directory)
      if (command === 'pnpm run test') throw new Error('subprocess-channel-lost')
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'TESTS_FAILED' })
    expect(f.runs.at(-1)).toMatchObject({ state: 'FAILED', stage: 'test', failure_code: 'PIPELINE_UNEXPECTED_FAILURE' })
    expect(f.transitions).toEqual(['GENERATING', 'BUILD_OK', 'TESTS_FAILED'])
  })

  it('records an inconclusive lifecycle channel as interrupted instead of a logical build failure', async () => {
    const f = await fixture()
    f.builder.execute = vi.fn(async () => { throw new BuilderLifecycleError('INTERRUPTED', 'INVALID_STEP_ORDER') })
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(result).toMatchObject({ state: 'INTERRUPTED', attempts: 1 })
    expect(f.runs.at(-1)).toMatchObject({ state: 'FAILED', failure_code: 'INVALID_STEP_ORDER', artifact_sha256: null })
    expect(f.transitions).toEqual(['GENERATING', 'INTERRUPTED'])
  })

  it('does not trust a locally forged PASSED report as exported evidence', async () => {
    const f = await fixture()
    const execute: BuilderLifecycleSession['execute'] = async (_buildRef: string, step: BuildStep): Promise<BuilderLifecycleStepResult> => {
      if (step === 'e2e') await passAcceptance(resolve(f.runsRoot, 'id-1'))
      return { state: ({ install: 'INSTALL_OK', build: 'BUILD_OK', test: 'TEST_OK', e2e: 'E2E_OK' } as const)[step], step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } }
    }
    const finish: BuilderLifecycleSession['finish'] = async (): Promise<BuilderLifecycleFinished> => ({ finalState: 'E2E_OK', exported: { relative_path: 'exports/build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sha256: 'a'.repeat(64), files: 1, bytes: 1 }, cleanupPending: false, cleaned: true })
    f.builder.execute = vi.fn(execute)
    f.builder.finish = vi.fn(finish)
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    expect(f.runs.at(-1)).toMatchObject({ state: 'BLOCKED_EXTERNAL', stage: 'verify', failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', artifact_sha256: null })
    expect(f.transitions).toEqual(['GENERATING', 'INTERRUPTED'])
    expect(f.transitions).not.toContain('VERIFIED_PROTOTYPE')
  })

  it('rejects an oversized acceptance report before parsing it', async () => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run test:e2e') await writeFile(resolve(directory, 'evidence/appspec-report.json'), ' '.repeat(1024 * 1024 + 1))
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'TESTS_FAILED' })
    expect(f.runs.at(-1)).toMatchObject({ state: 'FAILED', failure_code: 'APPSPEC_REPORT_TOO_LARGE' })
  })

  it('does not retry a process that exceeds the output budget', async () => {
    const f = await fixture({ execute: async () => ({
      exitCode: -1, stdout: 'bounded', stderr: '', timedOut: false,
      terminationReason: 'output_limit' as const, outputLimitExceeded: true,
    }) })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'BUILD_FAILED', attempts: 1 })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.runs.at(-1)).toMatchObject({ state: 'FAILED', failure_code: 'PROCESS_OUTPUT_LIMIT_EXCEEDED' })
  })

  it('allows only the framework-generated next-env file to change during build', async () => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run build') { await writeRuntimeOutput(directory); await writeFile(resolve(directory, 'next-env.d.ts'), '/// regenerated by Next.js') }
      if (command === 'pnpm run test:e2e') await passAcceptance(directory)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
  })

  it('rejects a build that changes another protected template file', async () => {
    const f = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run build') { await writeRuntimeOutput(directory); await writeFile(resolve(directory, 'src/App.tsx'), 'tampered') }
      if (command === 'pnpm run test:e2e') await passAcceptance(directory)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await expect(f.pipeline.run(actor, 'project', { generate: varying() })).resolves.toMatchObject({ state: 'BUILD_FAILED', message: 'TEMPLATE_INTEGRITY_FAILED' })
  })

  it('records the template integrity verdict on the attempt, and a tampered attempt is never a safe point', async () => {
    // O veredito era CALCULADO e jogado fora quando batia: sem gravá-lo, E-08
    // só saberia que a tentativa não reprovou, e não que ela foi conferida.
    const tampered = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run build') { await writeRuntimeOutput(directory); await writeFile(resolve(directory, 'src/App.tsx'), 'tampered') }
      if (command === 'pnpm run test:e2e') await passAcceptance(directory)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await tampered.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    const recusada = tampered.runs.filter(run => run.failure_code === 'TEMPLATE_INTEGRITY_FAILED')
    expect(recusada.length).toBeGreaterThan(0)
    expect(recusada.every(run => run.template_integrity === 'FAILED')).toBe(true)
    expect(runCheckpoints(recusada).every(checkpoint => !checkpoint.green)).toBe(true)
    expect(latestGreenCheckpoint(runCheckpoints(tampered.runs))).toBe(null)

    // E quando os passos rodam sem adulteração, a conferência que APROVOU fica
    // registrada — é ela que um ponto seguro exige quando a atestação existir.
    const clean = await fixture({ execute: async (directory, command) => {
      if (command === 'pnpm run test') return { exitCode: 1, stdout: '', stderr: 'falhou', timedOut: false }
      if (command === 'pnpm run build') await writeRuntimeOutput(directory)
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    } })
    await clean.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(clean.runs.some(run => run.template_integrity === 'VERIFIED')).toBe(true)
    // Integridade conferida NÃO é um verde: os passos não passaram.
    expect(latestGreenCheckpoint(runCheckpoints(clean.runs))).toBe(null)
  })

  it('distinguishes a test failure from a build failure after three attempts', async () => {
    const f = await fixture({ execute: async (_directory, command) => ({ exitCode: command === 'pnpm run test' ? 1 : 0, stdout: '', stderr: '', timedOut: false }) })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })
    expect(result).toMatchObject({ state: 'TESTS_FAILED', attempts: 3 })
    expect(f.transitions).toEqual(['GENERATING', 'BUILD_OK', 'TESTS_FAILED'])
    const failures = f.runs.filter(run => run.state === 'FAILED')
    expect(failures).toHaveLength(3)
    expect(failures.every(run => run.stage === 'test' && run.failure_code === 'test: exit 1')).toBe(true)
    expect(failures.every(run => run.artifact_sha256 == null)).toBe(true)
  })

  it('retries rejected model output with the prior diagnostic and closes as build failed', async () => {
    const f = await fixture()
    const generator: CodeGeneratorPort = { generate: vi.fn(async (_spec, _plan, diagnostic) => { throw new Error(diagnostic === undefined ? 'JSON inválido' : diagnostic) }) }
    const result = await f.pipeline.run(actor, 'project', generator)
    expect(result).toMatchObject({ state: 'BUILD_FAILED', attempts: 3, message: 'JSON inválido' })
    expect(generator.generate).toHaveBeenNthCalledWith(2, spec, plan, 'JSON inválido')
    expect(f.execute).not.toHaveBeenCalled()
    const failures = f.runs.filter(run => run.state === 'FAILED')
    expect(failures).toHaveLength(3)
    expect(failures.every(run => run.stage === 'generate' && run.failure_code === 'JSON inválido')).toBe(true)
    expect(f.transitions).toEqual(['GENERATING', 'BUILD_FAILED'])
  })

  /**
   * O teto de tokens de UMA criação, somando as três tentativas.
   *
   * Até aqui o único teto era de TEMPO, por passo do construtor — e tempo não é
   * o que a pessoa paga. Numa instalação com chave própria, três tentativas
   * sobre uma especificação grande gastavam o que gastassem.
   */
  it('para a criação quando o teto de tokens acaba, e diz que foi orçamento', async () => {
    const f = await fixture({ generationTokenBudget: 1_000 })
    // A cobrança acontece na geração BEM-SUCEDIDA: esta entrega os arquivos
    // (por isso cobra) e é recusada depois, na verificação de importação, para
    // forçar a repetição — que é onde o gasto multiplica.
    const spending: CodeGeneratorPort = {
      generate: vi.fn(async () => ({
        ...cleanGeneration,
        files: [{ path: 'src/GeneratedApp.tsx', content: "import { readFile } from 'node:fs'; export default function App(){ return null }; void readFile" }],
        inputTokens: 400, outputTokens: 200,
      })),
    }
    const result = await f.pipeline.run(actor, 'project', spending)

    // 600 na primeira tentativa, 1200 na segunda: a TERCEIRA não começa.
    //
    // E este teste É a prova da ORDEM entre orçamento e convergência: o duble
    // devolve o mesmo arquivo toda vez, então a repetição também acontece aqui.
    // Se a convergência fosse conferida antes do teto, o estado sairia
    // BUILD_FAILED e a pessoa leria "repetiu" no lugar de "acabou o limite" —
    // escondendo dela o único motivo que ela consegue resolver.
    expect(spending.generate).toHaveBeenCalledTimes(2)
    expect(result.state).toBe('BUDGET_EXCEEDED')
    const stopped = f.runs.at(-1)!
    expect(stopped.state).toBe('BUDGET_EXCEEDED')
    expect(stopped.failure_code).toContain('GENERATION_TOKEN_BUDGET_EXCEEDED')
    // O gasto somado viaja no diagnóstico: sem ele, quem opera não sabe se o
    // teto era apertado demais ou se a especificação é que é cara.
    expect(stopped.failure_code).toContain('tokens=1200')
  })

  /**
   * T-09 — CONVERGENCIA. Estes testes rodam contra o PIPELINE, e nao contra a
   * funcao pura: a licao da OS-61 foi que uma sabotagem na fiacao sobrevive a
   * qualquer teste que so exercite a funcao.
   */
  it('o gerador RECEBE as regras que vão ser aplicadas nele', async () => {
    // Elas eram escritas duas vezes — prosa no catalogo, constante na politica —
    // e as duas nao conversavam. O gerador continuava chutando um modulo que a
    // politica ja recusava, e cada chute custava uma tentativa inteira.
    // O prompt e montado DENTRO de `ModelCodeGenerator`, entao o teste usa o
    // gerador de verdade com um modelo duble, e le o que chegou ao modelo.
    const prompts: string[] = []
    const complete = vi.fn(async (..._args: unknown[]) => {
      prompts.push(String(_args[3] ?? ''))
      return { value: { files: cleanGeneration.files }, route: "ollama", model: "qwen" }
    })
    const real = new ModelCodeGenerator({ complete } as never, actor, 'local-only')
    await real.generate(spec, plan)
    const prompt = prompts[0] ?? ''
    for (const regra of generationRules()) expect(prompt).toContain(regra)
  })

  it('a criação PARA antes do limite quando a tentativa repete código e falha', async () => {
    // Duas tentativas com a mesma entrada escreveram byte a byte o mesmo
    // codigo e falharam byte a byte igual. A terceira gastaria o resto do teto
    // na mesma aposta.
    const f = await fixture({ execute: async () => ({ exitCode: 1, stdout: '', stderr: 'sempre a mesma falha', timedOut: false }) })
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => cleanGeneration) }
    const result = await f.pipeline.run(actor, 'project', generator)

    expect(generator.generate).toHaveBeenCalledTimes(2)
    expect(result.attempts).toBe(2)
    expect(result.state).toBe('BUILD_FAILED')
    // A frase da REPETICAO chega a pessoa em campo PROPRIO, e nao misturada ao
    // diagnostico cru: sem ela, uma criacao que parou na segunda tentativa
    // pareceria ter simplesmente falhado, e a pessoa apertaria "tentar de novo"
    // sem saber de nada.
    expect(result.notice).toContain('mesmo código')
    // E ela diz QUAL tentativa se repetiu.
    expect(result.notice).toContain('tentativa 1')
    // Mas NAO afirma que a proxima falharia: o gerador nao e deterministico.
    expect(result.notice).not.toMatch(/vai falhar|não funciona|impossível/iu)
    // E ela NAO afirma que a proxima falharia: o gerador nao e deterministico.
    expect(result.message).not.toMatch(/vai falhar|não funciona|impossível/iu)
  })

  it('o APRENDIZADO fala com quem acabou de ver a criação falhar (T-20)', async () => {
    // Ate aqui o motor derivava regras que ninguem lia. A pessoa que acabou de
    // ver uma falha esta diante de uma pergunta real — "tento de novo ou
    // desisto?" — e saber que esta mesma falha ja foi superada antes muda a
    // resposta dela.
    const antes = (id: string, dia: number) => historico(id, dia)
    const f = await fixture({
      execute: async () => ({ exitCode: 1, stdout: '', stderr: 'build: exit 1', timedOut: false }),
      // CINCO ocasioes, e nao tres: a execucao que acabou de falhar conta
      // CONTRA a regra, e com tres o resultado seria 3 acertos em 4 — 25% de
      // erro, acima do teto de 20%, e a regra nao validaria. Ou seja: o
      // conselho so aparece quando o historico e forte o bastante para
      // sobreviver ao contra-exemplo que a pessoa acabou de viver.
      history: [...antes('a', 1), ...antes('b', 2), ...antes('c', 3), ...antes('d', 1), ...antes('e', 2)],
    })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })

    expect(result.state).toBe('BUILD_FAILED')
    expect(result.notice).toBeDefined()
    // Os DOIS numeros, sempre: uma regra sem evidencia pede obediencia.
    expect(result.notice).toContain('5 de 6')
    // E ela NAO manda a pessoa obedecer, e nao promete que a proxima passa.
    expect(result.notice).toContain('a decisão é sua')
    expect(result.notice).not.toMatch(/vai funcionar|garantido/iu)
  })

  it('o histórico que NÃO sobrevive ao contra-exemplo de agora não vira conselho (T-20)', async () => {
    // Tres superadas mais a que acabou de falhar sao 3 de 4: 25% de erro,
    // acima do teto. A pessoa que acabou de viver o contra-exemplo e justamente
    // quem menos deveria ouvir "isto costuma dar certo".
    const f = await fixture({
      execute: async () => ({ exitCode: 1, stdout: '', stderr: 'install: exit 1', timedOut: false }),
      history: [...historico('a', 1), ...historico('b', 2), ...historico('c', 3)],
    })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })
    expect(result.state).toBe('BUILD_FAILED')
    expect(result.notice ?? '').not.toContain('já foi superada')
  })

  it('sem histórico que sustente, a criação falha SEM conselho inventado (T-20)', async () => {
    // O silencio e a resposta certa quando nao ha o que dizer. Um aviso que
    // aparece sempre vira decoracao, e a pessoa aprende a nao le-lo.
    const f = await fixture({ execute: async () => ({ exitCode: 1, stdout: '', stderr: 'build: exit 1', timedOut: false }) })
    const result = await f.pipeline.run(actor, 'project', { generate: varying() })
    expect(result.state).toBe('BUILD_FAILED')
    expect(result.notice ?? '').not.toContain('já foi superada')
  })

  it('a REPETIÇÃO desta execução vem ANTES do que o histórico diz (T-20)', async () => {
    // Repeticao e sobre o que esta acontecendo agora — "voce esta repetindo o
    // mesmo codigo" — e e mais urgente do que uma media de outras vezes.
    const antes = (id: string, dia: number) => historico(id, dia)
    const f = await fixture({
      execute: async () => ({ exitCode: 1, stdout: '', stderr: 'build: exit 1', timedOut: false }),
      history: [...antes('a', 1), ...antes('b', 2), ...antes('c', 3), ...antes('d', 1), ...antes('e', 2)],
    })
    // Gerador CONSTANTE: a convergencia para por repeticao.
    const result = await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    expect(result.notice).toContain('mesmo código')
  })

  it('código DIFERENTE com a mesma falha NÃO para a criação: o gerador está tentando', async () => {
    const f = await fixture({ execute: async () => ({ exitCode: 1, stdout: '', stderr: 'sempre a mesma falha', timedOut: false }) })
    const generator: CodeGeneratorPort = { generate: varying() }
    const result = await f.pipeline.run(actor, 'project', generator)

    expect(generator.generate).toHaveBeenCalledTimes(3)
    expect(result.attempts).toBe(3)
  })

  it('saída RECUSADA duas vezes IGUAL é repetição: o modelo escreveu a mesma coisa', async () => {
    // A saida foi recusada antes de chegar ao disco, entao ela nunca aparece em
    // `attemptFiles`. Se a convergencia olhasse so o que sobreviveu a
    // conferencia, duas recusas de textos DIFERENTES pareceriam iguais — e duas
    // recusas do MESMO texto pareceriam tentativas distintas.
    const f = await fixture()
    const generator = { generate: vi.fn(async () => ({
      ...cleanGeneration,
      files: [{ path: 'src/GeneratedApp.tsx', content: "import { readFile } from 'node:fs'; export default function App(){ return null }; void readFile" }],
    })) }
    const result = await f.pipeline.run(actor, 'project', generator)

    expect(generator.generate).toHaveBeenCalledTimes(2)
    expect(result.attempts).toBe(2)
  })

  it('geração que LANÇA não conta como repetição: não houve saída para comparar', async () => {
    // Duas recusas do gerador nao dizem se ele tentou a mesma coisa ou outra.
    // Tratar "nao observado" como "igual" pararia a criacao afirmando uma
    // repeticao que ninguem viu.
    const f = await fixture()
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => { throw new Error('JSON inválido') }) }
    const result = await f.pipeline.run(actor, 'project', generator)

    expect(generator.generate).toHaveBeenCalledTimes(3)
    expect(result.attempts).toBe(3)
  })

  it('sem teto configurado, a criação usa as três tentativas', async () => {
    // O padrão NÃO é um limite inventado por mim: sem configuração, não há teto.
    const f = await fixture()
    const spending: CodeGeneratorPort = {
      generate: varying({
        ...cleanGeneration,
        files: [{ path: 'src/GeneratedApp.tsx', content: "import { readFile } from 'node:fs'; export default function App(){ return null }; void readFile" }],
        inputTokens: 400_000, outputTokens: 200_000,
      }),
    }
    const result = await f.pipeline.run(actor, 'project', spending)
    expect(spending.generate).toHaveBeenCalledTimes(3)
    expect(result.state).toBe('BUILD_FAILED')
  })

  it('rejects forbidden imports before writing or running builder commands', async () => {
    const f = await fixture()
    const generator = { generate: varying({
      ...cleanGeneration,
      files: [{ path: 'src/GeneratedApp.tsx', content: "import { readFile } from 'node:fs'; export default function App(){ return null }; void readFile" }],
    }) }
    const result = await f.pipeline.run(actor, 'project', generator)
    expect(result).toMatchObject({ state: 'BUILD_FAILED', attempts: 3 })
    expect(result.message).toContain('node:fs')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.runs.filter(run => run.state === 'FAILED')).toHaveLength(3)
  })

  it('rejects a real personal identifier embedded in the AppSpec before preflight or generation', async () => {
    const f = await fixture()
    const unsafeSpec: AppSpecV1 = {
      ...spec,
      entities: [{ name: 'Cadastro', kind: 'database', sensitive: false, fields: [
        { name: 'Tipo', type: 'selection', required: true, options: ['CPF 529.982.247-25'] },
      ] }],
    }
    f.service.project.mockImplementation(() => ({ state: 'PLAN_APPROVED', category: 'form-database' }))
    f.service.latestSpec.mockReturnValue({ app_spec: unsafeSpec })
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    await expect(f.pipeline.run(actor, 'project', generator)).rejects.toMatchObject({ code: 'INVALID' })
    expect(f.builder.preflight).not.toHaveBeenCalled()
    expect(generator.generate).not.toHaveBeenCalled()
    expect(f.runs).toHaveLength(0)
  })

  it('blocks before generation when the isolated builder is unavailable', async () => {
    const f = await fixture({ preflight: 'BLOCKED_EXTERNAL' }); const generator = { generate: vi.fn(async () => cleanGeneration) }
    await expect(f.pipeline.run(actor, 'project', generator)).resolves.toEqual({ state: 'BLOCKED_EXTERNAL', attempts: 0, message: 'O ambiente isolado para criar seu projeto não está disponível neste computador.' })
    expect(generator.generate).not.toHaveBeenCalled()
    expect(f.transitions).toEqual([])
    expect(f.runs.at(-1)).toMatchObject({ stage: 'build', state: 'BLOCKED_EXTERNAL', sandbox: 'unavailable', artifact_sha256: null, failure_code: 'BUILDER_UNAVAILABLE' })
    await expect(lstat(f.runsRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to start without the approved plan and approved project state', async () => {
    const f = await fixture()
    f.service.plan.mockReturnValueOnce({ ...plan, status: 'PROPOSED' })
    await expect(f.pipeline.run(actor, 'project', { generate: vi.fn() })).rejects.toBeInstanceOf(PromptToAppError)
    expect(f.builder.preflight).not.toHaveBeenCalled()
  })

  it('records cancellation against the owning browser session before the next builder step', async () => {
    const controller = new AbortController()
    const f = await fixture({ execute: async () => { controller.abort('cancelled-by-user'); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } })
    const result = await f.pipeline.run({ ...actor, sessionId: 'browser-session' }, 'project', { generate: vi.fn(async () => cleanGeneration) }, { operationId: 'operation', ownerSessionId: 'browser-session', signal: controller.signal })
    expect(result).toMatchObject({ state: 'CANCELLED', attempts: 1 })
    expect(f.runs.at(-1)).toMatchObject({ run_id: 'operation', operation_id: 'operation', owner_session_id: 'browser-session', state: 'CANCELLED', artifact_sha256: null })
    expect(f.transitions).toEqual(['GENERATING', 'CANCELLED'])
    expect(f.builder.cancel).toHaveBeenCalledOnce()
    expect(f.builder.finish).toHaveBeenCalledOnce()
  })
})

async function passAcceptance(directory: string): Promise<void> {
  const reportPath = resolve(directory, 'evidence/appspec-report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { checks: Array<{ status: string }> }
  report.checks = report.checks.map(check => check.status === 'PENDING' ? { ...check, status: 'PASSED' } : check)
  await writeFile(reportPath, JSON.stringify(report))
}

async function writeRuntimeOutput(directory: string): Promise<void> {
  await mkdir(resolve(directory, '.next/standalone'), { recursive: true })
  await mkdir(resolve(directory, '.next/static'), { recursive: true })
  await mkdir(resolve(directory, 'public'), { recursive: true })
  await writeFile(resolve(directory, '.next/standalone/server.js'), 'server')
  await writeFile(resolve(directory, '.next/static/app.js'), 'static')
  await writeFile(resolve(directory, 'public/logo.txt'), 'public')
}

describe('E-06 e E-07: a execução deixa um relato que a pessoa consegue ler', () => {
  it('grava o relato ao lado da execução e o registra como evidência do tipo diff', async () => {
    // `kind: 'diff'` existia no esquema e NENHUM código o produzia: era um
    // valor morto. E o `pipeline.log` era gravado e nunca renderizado, então a
    // pessoa terminava com um código em inglês e nada mais.
    const f = await fixture()
    await f.pipeline.run(actor, 'project', { generate: vi.fn(async () => cleanGeneration) })
    const run = f.runs.at(-1)!
    const raw = await readFile(resolve(run.run_directory, 'run-report.json'), 'utf8')
    const report = JSON.parse(raw) as {
      stages: { step: string; label: string; state: string; detail: string }[]
      files: { path: string; author: string; change: string; lines: number }[]
      findings: string[]
      correction: string | null
      attempt: number
    }
    expect(report.stages.map(stage => stage.step)).toEqual(['install', 'build', 'test', 'e2e'])
    for (const stage of report.stages) expect(stage.label, stage.step).not.toBe(stage.step)
    // Os arquivos que a pessoa recebeu, e quem escreveu cada um.
    expect(report.files.length).toBeGreaterThan(0)
    expect(report.files.some(file => file.author === 'model')).toBe(true)
    expect(report.files.every(file => file.change === 'added')).toBe(true)
    expect(report.correction).toBe(null)
    expect(f.evidence.some(item => item.kind === 'diff' && item.relative_path.endsWith('run-report.json'))).toBe(true)
  })

  it('T-26: a PRIMEIRA tentativa de hoje ja sabe como terminou a de ontem', async () => {
    // A memoria por criacao so compara tentativas de uma mesma criacao entre
    // si. Esta e a outra metade: a criacao de ontem falhou, e a de hoje
    // comecava sem saber disso.
    const f = await fixture()
    f.runs.push({
      run_id: 'run-de-ontem', operation_id: 'run-de-ontem', owner_session_id: 'sessao',
      plan_id: 'plan', project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId,
      stage: 'build', attempt: 1, state: 'FAILED',
      // O relogio do pipeline e FIXO no fixture: usar `Date.now()` aqui poria a
      // execucao de ontem no futuro do pipeline, e a janela deixaria de ser
      // exercida — foi assim que a sabotagem contra a janela sobreviveu.
      started_at: '2026-09-02T12:00:00.000Z', finished_at: null,
      sandbox: 'full', route: null, model: null, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, run_directory: 'nao-importa', artifact_sha256: null,
      failure_code: 'O teste de acessibilidade reprovou em src/Form.tsx', acceptance_checks: [],
    } as never)
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => cleanGeneration) }
    await f.pipeline.run(actor, 'project', generator)
    const correcao = (generator.generate as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string | undefined
    expect(correcao).toContain('O teste de acessibilidade reprovou em src/Form.tsx')
    expect(correcao).toContain('tentativa(s) anterior(es)')
  })

  it('T-26: falha de OUTRO plano nao semeia a criacao de hoje', async () => {
    // Plano diferente significa que a pessoa mudou o que pediu, e a falha
    // antiga pode nao ter mais nada a ver.
    const f = await fixture()
    f.runs.push({
      run_id: 'run-de-outro-plano', operation_id: 'run-de-outro-plano', owner_session_id: 'sessao',
      plan_id: 'plano-antigo', project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId,
      stage: 'build', attempt: 1, state: 'FAILED',
      started_at: '2026-09-02T12:00:00.000Z', finished_at: null,
      sandbox: 'full', route: null, model: null, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, run_directory: 'nao-importa', artifact_sha256: null,
      failure_code: 'uma falha de outro plano', acceptance_checks: [],
    } as never)
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => cleanGeneration) }
    await f.pipeline.run(actor, 'project', generator)
    expect((generator.generate as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeUndefined()
  })

  it('T-26: sem execucao anterior, a primeira tentativa nao recebe correcao nenhuma', async () => {
    const f = await fixture()
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => cleanGeneration) }
    await f.pipeline.run(actor, 'project', generator)
    expect((generator.generate as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeUndefined()
  })

  it('T-26: falha VELHA demais nao semeia: ela pode ja ter sido corrigida', async () => {
    // Continuar avisando seria mandar o gerador evitar um caminho que voltou a
    // funcionar.
    const f = await fixture()
    f.runs.push({
      run_id: 'run-antigo', operation_id: 'run-antigo', owner_session_id: 'sessao',
      plan_id: 'plan', project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId,
      stage: 'build', attempt: 1, state: 'FAILED',
      started_at: '2026-05-01T12:00:00.000Z', finished_at: null,
      sandbox: 'full', route: null, model: null, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, run_directory: 'nao-importa', artifact_sha256: null,
      failure_code: 'uma falha de quatro meses atras', acceptance_checks: [],
    } as never)
    const generator: CodeGeneratorPort = { generate: vi.fn(async () => cleanGeneration) }
    await f.pipeline.run(actor, 'project', generator)
    expect((generator.generate as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeUndefined()
  })

  it('na retentativa o relato mostra o que foi pedido para corrigir', async () => {
    const f = await fixture()
    let calls = 0
    const generator: CodeGeneratorPort = {
      generate: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('JSON inválido')
        return cleanGeneration
      }),
    }
    await f.pipeline.run(actor, 'project', generator)
    const directories = [...new Set(f.runs.map(run => run.run_directory))].filter(value => value !== 'not-created')
    const reports = await Promise.all(directories.map(async directory =>
      JSON.parse(await readFile(resolve(directory, 'run-report.json'), 'utf8')) as { attempt: number; correction: string | null }))
    // A primeira tentativa não tinha nada a corrigir; a segunda carrega o
    // motivo real da anterior, e não uma frase genérica.
    expect(reports.find(report => report.attempt === 1)?.correction).toBe(null)
    expect(reports.find(report => report.attempt === 2)?.correction).toBe('JSON inválido')
  })
})

describe('E-11: a parada de emergência alcança o pipeline', () => {
  it('escopo parado não começa execução: nada é lido, nada é gravado, nada transita', async () => {
    const f = await fixture({
      emergencyStop: {
        assertRunning() {
          const error = new Error('O Studio está parado por uma parada de emergência.') as Error & { code?: string }
          error.code = 'STOPPED'
          throw error
        },
      },
    })
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    await expect(f.pipeline.run(actor, 'project', generator)).rejects.toMatchObject({ code: 'STOPPED' })
    // A recusa é a PRIMEIRA linha: nem o projeto foi lido, e por isso nenhuma
    // execução pendente sobra para a próxima pessoa entender.
    expect(f.service.project).not.toHaveBeenCalled()
    expect(f.runs).toEqual([])
    expect(f.transitions).toEqual([])
    expect(generator.generate).not.toHaveBeenCalled()
  })

  it('a parada de OUTRO escopo não impede esta execução', async () => {
    const f = await fixture({
      emergencyStop: {
        assertRunning(scope) {
          if (scope.orgId === 'org-b') throw new Error('parado')
        },
      },
    })
    const generator = { generate: vi.fn(async () => cleanGeneration) }
    await f.pipeline.run(actor, 'project', generator)
    expect(generator.generate).toHaveBeenCalled()
  })
})
