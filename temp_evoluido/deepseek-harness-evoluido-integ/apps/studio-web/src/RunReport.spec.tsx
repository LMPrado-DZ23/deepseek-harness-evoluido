import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Checkpoints, RunReport, isCheckpointList, isRunReport, type CheckpointListValue, type CheckpointValue, type RunReportValue } from './RunReport'
import { UNDO_AVAILABLE_BY_STATE, type ProjectUiState } from './presentation'

const report = (overrides: Partial<RunReportValue> = {}): RunReportValue => ({
  stages: [
    { step: 'install', label: 'Preparando as ferramentas do seu aplicativo', state: 'passed', detail: 'added 120 packages' },
    { step: 'build', label: 'Montando o aplicativo', state: 'failed', detail: 'error TS1005' },
    { step: 'test', label: 'Conferindo se as partes funcionam', state: 'not-run', detail: '' },
    { step: 'e2e', label: 'Usando o aplicativo como uma pessoa usaria', state: 'not-run', detail: '' },
  ],
  files: [{ path: 'src/GeneratedApp.tsx', lines: 42, bytes: 900, author: 'model', change: 'added' }],
  findings: [],
  correction: null,
  attempt: 1,
  ...overrides,
})

describe('E-06: a criação para de ser uma caixa preta', () => {
  it('mostra cada etapa em português com o estado dela', () => {
    // A pessoa terminava com `BUILD_FAILED` e nada mais: o registro do processo
    // era gravado como evidência e nunca mostrado.
    const html = renderToStaticMarkup(createElement(RunReport, { report: report() }))
    expect(html).toContain('O que aconteceu na criação')
    expect(html).toContain('Preparando as ferramentas do seu aplicativo')
    expect(html).toContain('parou aqui')
    expect(html).toContain('não chegou a acontecer')
    // Nada de código de estado em inglês na cara de quem não programa.
    expect(html).not.toMatch(/BUILD_FAILED|TESTS_FAILED|not-run<\/span>/u)
  })

  it('o detalhe técnico existe, mas vem fechado', () => {
    const html = renderToStaticMarkup(createElement(RunReport, { report: report() }))
    expect(html).toContain('Detalhes técnicos')
    expect(html).toContain('error TS1005')
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
  })

  it('etapa que não rodou não ganha bloco técnico vazio', () => {
    const html = renderToStaticMarkup(createElement(RunReport, { report: report() }))
    // Duas etapas com saída, duas sem: quatro <details> seria um convite a
    // clicar em nada.
    expect((html.match(/<details/gu) ?? []).length).toBe(2)
  })
})

describe('E-07: a pessoa vê o que foi feito, recusado e corrigido', () => {
  it('lista os arquivos com autor e tamanho', () => {
    const html = renderToStaticMarkup(createElement(RunReport, { report: report() }))
    expect(html).toContain('O que foi feito para você')
    expect(html).toContain('src/GeneratedApp.tsx')
    expect(html).toContain('42 linhas')
    expect(html).toContain('escrito pela IA')
    expect(html).toContain('novo')
    // E não deixa a pessoa achar que foi publicado.
    expect(html).toContain('Nada saiu do seu computador')
  })

  it('mostra o que foi recusado e o que foi pedido para corrigir, quando houve', () => {
    const html = renderToStaticMarkup(createElement(RunReport, {
      report: report({ findings: ['content/app.json: CPF válido em dado de exemplo'], correction: 'build: exit 1', attempt: 2 }),
    }))
    expect(html).toContain('O que foi recusado')
    expect(html).toContain('CPF válido em dado de exemplo')
    expect(html).toContain('O que foi pedido para corrigir')
    expect(html).toContain('build: exit 1')
    expect(html).toContain('tentativa número')
  })

  it('sem recusa e sem correção, não inventa seção vazia', () => {
    const html = renderToStaticMarkup(createElement(RunReport, { report: report() }))
    expect(html).not.toContain('O que foi recusado')
    expect(html).not.toContain('O que foi pedido para corrigir')
    expect(html).not.toContain('tentativa número')
  })

  it('quando nada foi escrito, diz isso em vez de mostrar lista vazia', () => {
    const html = renderToStaticMarkup(createElement(RunReport, { report: report({ files: [] }) }))
    expect(html).toContain('Nenhum arquivo chegou a ser escrito')
  })
})

describe('o cliente recusa um relato que não é um relato', () => {
  it('aceita o formato do servidor e descarta o resto', () => {
    // Desenhar meia etapa mostraria à pessoa algo que o servidor nunca disse.
    expect(isRunReport(report())).toBe(true)
    expect(isRunReport(null)).toBe(false)
    expect(isRunReport({ stages: [], files: [], findings: [], correction: null })).toBe(false)
    expect(isRunReport({ ...report(), stages: [{ step: 'x', label: 'x', state: 'quase', detail: '' }] })).toBe(false)
    expect(isRunReport({ ...report(), correction: 42 })).toBe(false)
  })
})

const checkpoint = (overrides: Partial<CheckpointValue> = {}): CheckpointValue => ({
  run_id: 'attempt-1', attempt: 1, created_at: '2026-09-03T12:01:00.000Z', run_directory: '/runs/attempt-1',
  tree_sha256: null, acceptance_checks: [], integrity: 'VERIFIED', green: false,
  blocker: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', ...overrides,
})
const list = (overrides: Partial<CheckpointListValue> = {}): CheckpointListValue => ({
  checkpoints: [checkpoint()], green_run_id: null, reason: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', current_run_id: null, ...overrides,
})
const noop = () => undefined
// O estado padrao e TESTS_FAILED porque e o caso em que voltar EXISTE: os
// testes antigos foram escritos para esse mundo, e mante-lo preserva o que
// eles ja provavam.
const render = (value: CheckpointListValue, confirmingRunId: string | null = null, projectState: ProjectUiState | null = 'TESTS_FAILED') =>
  renderToStaticMarkup(createElement(Checkpoints, {
    list: value, projectState, confirmingRunId, askConfirm: noop, cancelConfirm: noop, undo: noop,
  }))

describe('E-08: a pessoa vê para onde pode voltar, e por que às vezes não pode', () => {
  it('sem ponto seguro, diz isso e explica o motivo sem jargão — e não oferece voltar', () => {
    const html = render(list())
    expect(html).toContain('Não há ponto seguro para voltar')
    expect(html).toContain('a prova de que os critérios combinados foram conferidos não foi emitida')
    expect(html).not.toContain('Voltar para este ponto')
    // Nada de código em inglês na cara de quem não programa.
    expect(html).not.toContain('ACCEPTANCE_ATTESTATION_UNAVAILABLE')
  })

  it('com ponto seguro, oferece voltar e diz que nada é apagado', () => {
    const html = render(list({
      checkpoints: [checkpoint({ green: true, blocker: null, acceptance_checks: [{ id: 'title', label: 'Tem título', status: 'PASSED' }] })],
      green_run_id: 'attempt-1', reason: null, current_run_id: 'attempt-1',
    }))
    expect(html).toContain('ponto seguro')
    expect(html).toContain('integridade conferida')
    // A contagem passou a dizer o que foi MESMO conferido: antes, "conferidos"
    // contava a lista inteira, com falha e não automatizado dentro.
    expect(html).toContain('1 critérios, todos conferidos')
    expect(html).toContain('você está aqui')
    expect(html).toContain('Voltar para este ponto')
    expect(html).toContain('continua no seu computador')
    expect(html).not.toContain('Não há ponto seguro para voltar')
  })

  it('a confirmação existe e diz o que o desfazer NÃO faz', () => {
    const green = checkpoint({ green: true, blocker: null })
    const value = list({ checkpoints: [green], green_run_id: green.run_id, reason: null })
    expect(render(value)).not.toContain('Voltar para este ponto?')
    const confirming = render(value, green.run_id)
    expect(confirming).toContain('Voltar para este ponto?')
    expect(confirming).toContain('Nada é apagado')
    expect(confirming).toContain('Sim, voltar para este ponto')
    expect(confirming).toContain('Cancelar')
  })

  it('depois de uma falha, recomeçar é oferecido e explica o que acontece com o que já foi feito', () => {
    const html = renderToStaticMarkup(createElement(Checkpoints, {
      list: list(), projectState: 'TESTS_FAILED' as ProjectUiState, confirmingRunId: null, askConfirm: noop, cancelConfirm: noop, undo: noop, restart: noop,
    }))
    expect(html).toContain('Tentar de novo')
    expect(html).toContain('continua guardada')
    // Sem a ação de recomeçar, a tela não inventa um botão que não faz nada.
    expect(render(list())).not.toContain('Tentar de novo')
  })

  it('o cliente recusa uma lista de pontos que o servidor não disse', () => {
    expect(isCheckpointList(list())).toBe(true)
    expect(isCheckpointList(null)).toBe(false)
    expect(isCheckpointList({ ...list(), reason: 'TUDO_CERTO' })).toBe(false)
    expect(isCheckpointList({ ...list(), green_run_id: 7 })).toBe(false)
    expect(isCheckpointList({ ...list(), checkpoints: [{ ...checkpoint(), integrity: 'QUASE' }] })).toBe(false)
    expect(isCheckpointList({ ...list(), checkpoints: [{ ...checkpoint(), green: 'sim' }] })).toBe(false)
  })
})

describe('E-08: o botão de voltar só aparece quando voltar é possível', () => {
  const green = (): CheckpointListValue => list({
    checkpoints: [checkpoint({ run_id: 'run-1', green: true, blocker: null })],
    green_run_id: 'run-1', reason: null,
  })

  it('durante a criação, NÃO oferece voltar — e diz que é preciso parar antes', () => {
    for (const state of ['GENERATING', 'BUILD_OK', 'TESTS_OK'] as const) {
      const html = render(green(), null, state)
      expect(html, `estado ${state} ofereceu voltar durante a criação`).not.toContain('Voltar para este ponto')
      expect(html).toContain('Pare a criação primeiro')
    }
  })

  it('antes de qualquer tentativa, NÃO oferece voltar — e diz quando passa a ser possível', () => {
    for (const state of ['DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED'] as const) {
      const html = render(green(), null, state)
      expect(html, `estado ${state} ofereceu voltar sem tentativa nenhuma`).not.toContain('Voltar para este ponto')
      expect(html).toContain('depois que uma tentativa de criação termina')
    }
  })

  it('depois de parar, oferece voltar', () => {
    for (const state of ['BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED', 'VERIFIED_PROTOTYPE'] as const) {
      expect(render(green(), null, state), `estado ${state} escondeu o botão de voltar`).toContain('Voltar para este ponto')
    }
  })

  it('a confirmação também some quando o estado não permite: não basta esconder o primeiro botão', () => {
    // Sem esta regra, quem já tinha aberto a confirmação e viu a criação
    // recomeçar continuaria com "Sim, voltar para este ponto" na tela.
    expect(render(green(), 'run-1', 'GENERATING')).not.toContain('Sim, voltar para este ponto')
    expect(render(green(), 'run-1', 'TESTS_FAILED')).toContain('Sim, voltar para este ponto')
  })

  it('a tabela de estados é a mesma do servidor, e é exaustiva', () => {
    // Espelha UNDO_TRANSITIONS de plugins/prompt-to-app/src/state.ts. Se as
    // duas divergirem, a tela volta a oferecer o que o servidor recusa.
    expect(UNDO_AVAILABLE_BY_STATE).toEqual({
      DRAFT: false, SPEC_READY: false, PLAN_PROPOSED: false, PLAN_APPROVED: false,
      GENERATING: false, BUILD_OK: false, TESTS_OK: false,
      BUILD_FAILED: true, TESTS_FAILED: true, CANCELLED: true, INTERRUPTED: true,
      VERIFIED_PROTOTYPE: true,
    })
  })

  it('sem projeto ainda, não oferece voltar', () => {
    expect(render(green(), null, null)).not.toContain('Voltar para este ponto')
  })
})
