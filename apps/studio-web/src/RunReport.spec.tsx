import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RunReport, isRunReport, type RunReportValue } from './RunReport'

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
