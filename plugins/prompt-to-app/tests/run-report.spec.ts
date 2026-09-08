import { describe, expect, it } from 'vitest'
import {
  diffRunFiles,
  parsePipelineLog,
  runDetail,
  runReport,
  RUN_DETAIL_LIMIT,
  type RunFile,
} from '../src/run-report.ts'

const log = [
  '[install]', 'added 120 packages', '',
  '[build]', 'compiled successfully', '',
  '[test]', '2 passed', '',
  '[e2e]', 'ok', '',
].join('\n')

const file = (path: string, content: string, author: 'model' | 'studio' = 'model') => ({ path, content, author })

describe('E-06: a criação deixa de ser uma caixa preta', () => {
  it('separa o log nos passos que o produziram', () => {
    // O pipeline.log era gravado como evidência e nunca renderizado: a pessoa
    // terminava com um código em inglês e nada mais.
    expect(parsePipelineLog(log).map(block => block.step)).toEqual(['install', 'build', 'test', 'e2e'])
    expect(parsePipelineLog(log)[1]?.output).toBe('compiled successfully')
  })

  it('não inventa passo quando o log é vazio ou de formato desconhecido', () => {
    // Adivinhar aqui viraria uma etapa "que passou" sem prova nenhuma.
    expect(parsePipelineLog('')).toEqual([])
    expect(parsePipelineLog('erro sem cabeçalho de passo')).toEqual([])
  })

  it('toda etapa tem frase em português, e o código do passo nunca é a frase', () => {
    const report = runReport({
      stage: 'verify', runState: 'PASSED', attempt: 1, log, files: [], findings: [], correction: null,
    })
    expect(report.stages).toHaveLength(4)
    for (const stage of report.stages) {
      expect(stage.label, stage.step).not.toBe(stage.step)
      expect(stage.label, stage.step).toMatch(/[a-záéíóúçãõ]{4,}/u)
      expect(stage.state).toBe('passed')
    }
  })

  it('marca como falha só o passo em que parou, e o que nunca rodou como não executado', () => {
    // "Aguardando" para um passo que nunca vai rodar engana quem espera.
    const partial = ['[install]', 'ok', '', '[build]', 'error TS1005', ''].join('\n')
    const report = runReport({
      stage: 'build', runState: 'FAILED', attempt: 1, log: partial, files: [], findings: [], correction: null,
    })
    expect(report.stages.map(stage => [stage.step, stage.state])).toEqual([
      ['install', 'passed'], ['build', 'failed'], ['test', 'not-run'], ['e2e', 'not-run'],
    ])
    expect(report.stages[1]?.detail).toContain('error TS1005')
  })

  it('o passo em andamento aparece em andamento, e não como aprovado', () => {
    const report = runReport({
      stage: 'build', runState: 'RUNNING', attempt: 1, log: ['[install]', 'ok', '', '[build]', 'compilando'].join('\n'),
      files: [], findings: [], correction: null,
    })
    expect(report.stages[1]?.state).toBe('running')
  })

  it('o detalhe técnico é cortado preservando o fim, onde o erro costuma estar', () => {
    const long = `${'a'.repeat(RUN_DETAIL_LIMIT)}ERRO_FINAL`
    const cut = runDetail(long)
    expect(cut.length).toBeLessThanOrEqual(RUN_DETAIL_LIMIT + 2)
    expect(cut).toContain('ERRO_FINAL')
    expect(cut).toContain('…')
    expect(runDetail('curto')).toBe('curto')
  })
})

describe('E-07: a pessoa vê o que foi feito, o que foi recusado e o que foi corrigido', () => {
  it('lista os arquivos com autor e tamanho, e ordena para a leitura não pular', () => {
    const files = diffRunFiles([file('src/b.tsx', 'um\ndois'), file('content/a.json', '{}', 'studio')])
    const report = runReport({
      stage: 'verify', runState: 'PASSED', attempt: 1, log, files, findings: [], correction: null,
    })
    expect(report.files.map((entry: RunFile) => entry.path)).toEqual(['content/a.json', 'src/b.tsx'])
    expect(report.files[1]).toMatchObject({ lines: 2, bytes: 7, author: 'model', change: 'added' })
    expect(report.files[0]?.author).toBe('studio')
  })

  it('na primeira tentativa tudo é novo; na seguinte, só o que mudou aparece como mudado', () => {
    // Marcar tudo como "inalterado" na primeira daria a impressão de que o
    // Studio não fez nada.
    const first = diffRunFiles([file('a.tsx', 'v1'), file('b.tsx', 'igual')])
    expect(first.map(entry => entry.change)).toEqual(['added', 'added'])
    const second = diffRunFiles(
      [file('a.tsx', 'v2'), file('b.tsx', 'igual'), file('c.tsx', 'novo')],
      [{ path: 'a.tsx', content: 'v1' }, { path: 'b.tsx', content: 'igual' }],
    )
    expect(second.map(entry => [entry.path, entry.change])).toEqual([
      ['a.tsx', 'changed'], ['b.tsx', 'unchanged'], ['c.tsx', 'added'],
    ])
  })

  it('mostra o que os controles recusaram e o que foi pedido para corrigir', () => {
    const report = runReport({
      stage: 'generate', runState: 'FAILED', attempt: 2, log,
      files: [], findings: ['content/app.json: CPF válido em dado de exemplo'],
      correction: 'build: exit 1',
    })
    expect(report.findings).toEqual(['content/app.json: CPF válido em dado de exemplo'])
    expect(report.correction).toBe('build: exit 1')
    expect(report.attempt).toBe(2)
  })

  it('na primeira tentativa não existe correção a mostrar', () => {
    const report = runReport({
      stage: 'verify', runState: 'PASSED', attempt: 1, log, files: [], findings: [], correction: null,
    })
    expect(report.correction).toBe(null)
    expect(report.findings).toEqual([])
  })
})
