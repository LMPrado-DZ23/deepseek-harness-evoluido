import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StuckRuns, StuckRunsList, STUCK_RUNS_ENDPOINT, formatSince, isStuckRun, listStuckRuns } from './StuckRuns'
import { ConversationRequestError } from './conversationApi'

function row(overrides: Record<string, unknown> = {}) {
  return { run_id: 'run-1', workspace_id: 'meu-projeto', provider: 'spawn-in-process', since: '2026-09-08T00:00:00.000Z', ...overrides }
}

describe('trabalho parado', () => {
  it('some da tela quando não há nada parado', () => {
    const port = { fetch: async () => Response.json({ runs: [] }) }
    expect(renderToStaticMarkup(createElement(StuckRuns, { port }))).toBe('')
  })

  it('descarta uma linha incompleta em vez de assustar com meia informação', () => {
    expect(isStuckRun(row())).toBe(true)
    expect(isStuckRun(row({ run_id: '' }))).toBe(false)
    expect(isStuckRun(row({ run_id: 'run com espaço' }))).toBe(false)
    expect(isStuckRun(row({ workspace_id: '' }))).toBe(false)
    expect(isStuckRun(row({ provider: 42 }))).toBe(false)
    expect(isStuckRun(row({ since: '' }))).toBe(false)
    expect(isStuckRun(null)).toBe(false)
    expect(isStuckRun('run-1')).toBe(false)
  })

  it('lê pelo endereço exato e filtra o que não é reconhecível', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ runs: [row(), { run_id: 'só isso' }] }))
    const runs = await listStuckRuns({ fetch: fetchSpy })
    expect(fetchSpy).toHaveBeenCalledWith(STUCK_RUNS_ENDPOINT, expect.objectContaining({ method: 'GET' }))
    expect(runs).toEqual([row()])
  })

  it('recusa uma resposta que não é a lista, em vez de dizer que não há nada parado', async () => {
    const port = { fetch: async () => Response.json({ nada: true }) }
    await expect(listStuckRuns(port)).rejects.toBeInstanceOf(ConversationRequestError)
  })

  it('diz o que está preso, desde quando, e a frase exata para encerrar', () => {
    const html = renderToStaticMarkup(createElement(StuckRunsList, { runs: [row()], error: null }))
    expect(html).toContain('aria-labelledby="stuck-runs-title"')
    expect(html).toContain('Trabalho parado esperando você')
    expect(html).toContain('os arquivos deles seguem reservados')
    expect(html).toContain('run-1')
    expect(html).toContain('encerre a execução run-1')
    // Nada de caminho absoluto do disco atravessando para a tela.
    expect(html).not.toMatch(/[A-Za-z]:\\|\/home\/|\/var\/lib\//u)
  })

  it('uma falha de leitura NUNCA vira "não há nada parado"', () => {
    const failed = renderToStaticMarkup(createElement(StuckRunsList, {
      runs: [], error: new ConversationRequestError(503, 'serviço indisponível', true),
    }))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('serviço indisponível')
    // E sem falha nenhuma e sem nada parado, a seção some por completo.
    expect(renderToStaticMarkup(createElement(StuckRunsList, { runs: [], error: null }))).toBe('')
  })

  it('não transforma uma data inválida em "agora"', () => {
    expect(formatSince('não é data')).toBe('não é data')
    expect(formatSince('2026-09-08T00:00:00.000Z')).toContain('2026')
  })
})
