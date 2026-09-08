import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  EmergencyStop,
  EmergencyStopPanel,
  MIN_RESUME_REASON_LENGTH,
  StopOutcome,
  browserEmergencyStopPort,
  formatMoment,
  isEmergencyStopState,
  resumeReasonAccepted,
  type EmergencyStopPanelProps,
  type EmergencyStopState,
} from './EmergencyStop'

const running: EmergencyStopState = {
  stopped: false, engaged_by: null, engaged_at: null, reason: null,
  released_by: null, released_at: null, release_reason: null,
}
const stopped: EmergencyStopState = {
  stopped: true, engaged_by: 'ana@exemplo.com', engaged_at: '2026-09-08T12:00:00.000Z',
  reason: 'Cobrança disparando em loop.', released_by: null, released_at: null, release_reason: null,
}

function panel(overrides: Partial<EmergencyStopPanelProps> = {}): string {
  return renderToStaticMarkup(createElement(EmergencyStopPanel, {
    state: running, surfaces: [], confirming: false, busy: null,
    reason: '', resumeReason: '', error: '',
    onAskConfirm: () => undefined, onCancelConfirm: () => undefined,
    onReason: () => undefined, onResumeReason: () => undefined,
    onEngage: () => undefined, onRelease: () => undefined,
    ...overrides,
  }))
}

describe('E-11: o botão está visível e diz o que faz', () => {
  it('mostra o botão de parar e explica o alcance dele', () => {
    const html = panel()
    expect(html).toContain('Parada de emergência')
    expect(html).toContain('Parar tudo agora')
    expect(html).toContain('agentes, criações, integrações e filas')
    expect(html).toContain('O Studio está funcionando')
  })

  it('antes da primeira leitura NÃO afirma que está tudo funcionando', () => {
    // Afirmar "nada está parado" sem ter lido nada é mentir sobre segurança
    // justamente na tela que responde "o Studio está parado?".
    const html = panel({ state: null })
    expect(html).toContain('Lendo o estado do Studio')
    expect(html).not.toContain('O Studio está funcionando')
    expect(html).not.toContain('O Studio está parado')
  })

  it('parar pede confirmação antes: parar é permitido, mas é grave', () => {
    const html = panel({ confirming: true })
    expect(html).toContain('Parar tudo agora?')
    expect(html).toContain('Sim, parar tudo')
    expect(html).toContain('Voltar')
    // O motivo é opcional aqui de propósito: em uma emergência ninguém deve
    // parar para redigir.
    expect(html).toContain('Motivo (opcional)')
  })
})

describe('E-11: parado, a tela diz o que não acontece e como retomar', () => {
  it('mostra quem parou, quando e por quê', () => {
    const html = panel({ state: stopped })
    expect(html).toContain('O Studio está parado')
    expect(html).toContain('ana@exemplo.com')
    expect(html).toContain('Cobrança disparando em loop.')
    expect(html).toContain('Parado em')
  })

  it('diz que nada novo começa, e o que é preciso para retomar', () => {
    const html = panel({ state: stopped })
    expect(html).toContain('Nada novo começa')
    expect(html).toContain('Para retomar')
    expect(html).toContain('chave de acesso')
    expect(html).toContain('motivo escrito')
    expect(html).toContain('Retomar o Studio')
  })

  it('sem motivo escrito, o botão de retomar fica desabilitado', () => {
    // A assimetria aparece na tela, e não só no servidor: parar é um clique;
    // voltar exige alguém que assine o porquê.
    expect(panel({ state: stopped })).toContain('Retomar o Studio</button>')
    expect(panel({ state: stopped, resumeReason: '' })).toMatch(/disabled=""[^>]*>Retomar o Studio|<button[^>]*disabled=""[^>]*>\s*Retomar o Studio/u)
    expect(panel({ state: stopped, resumeReason: 'Provedor confirmou a correção.' })).not.toMatch(/disabled=""[^>]*>Retomar o Studio/u)
  })

  it('parado sem motivo informado não mostra campo vazio e mudo', () => {
    const html = panel({ state: { ...stopped, reason: null } })
    expect(html).toContain('Motivo não informado.')
  })

  it('depois de retomado, mostra quem assumiu a volta', () => {
    const html = panel({
      state: { ...running, released_by: 'bruno@exemplo.com', released_at: '2026-09-08T13:00:00.000Z', release_reason: 'Conferimos a fatura.' },
    })
    expect(html).toContain('Última retomada por')
    expect(html).toContain('bruno@exemplo.com')
  })
})

describe('E-11: a tela separa o que parou do que não pôde ser provado', () => {
  it('mostra as duas listas, e não as soma', () => {
    const html = renderToStaticMarkup(createElement(StopOutcome, {
      surfaces: [
        { surface: 'Criações de aplicativo em andamento', cancelled: 2, unproven: [] },
        { surface: 'Assistentes em andamento', cancelled: 0, unproven: [{ what: 'run-7', why: 'processo externo codex' }] },
      ],
    }))
    expect(html).toContain('O que foi interrompido')
    expect(html).toContain('2 interrompidos')
    expect(html).toContain('O que o Studio não conseguiu provar que parou')
    expect(html).toContain('run-7')
    expect(html).toContain('processo externo codex')
    // A superfície sem nada interrompido não aparece na lista do que parou.
    expect(html).not.toContain('Assistentes em andamento: 0')
  })

  it('sem nada em andamento, diz isso em vez de mostrar listas vazias', () => {
    const html = renderToStaticMarkup(createElement(StopOutcome, { surfaces: [] }))
    expect(html).toContain('Não havia nada em andamento para interromper')
    expect(html).not.toContain('O que foi interrompido')
  })
})

describe('o cliente recusa um estado que não é um estado', () => {
  it('aceita o formato do servidor e descarta o resto', () => {
    expect(isEmergencyStopState(running)).toBe(true)
    expect(isEmergencyStopState(stopped)).toBe(true)
    expect(isEmergencyStopState(null)).toBe(false)
    expect(isEmergencyStopState({ stopped: 'sim' })).toBe(false)
    expect(isEmergencyStopState({ ...running, engaged_by: 42 })).toBe(false)
  })

  it('uma data ilegível vira o texto original, não um traço mudo', () => {
    expect(formatMoment('nem-data')).toBe('nem-data')
    expect(formatMoment('2026-09-08T12:00:00.000Z')).not.toBe('2026-09-08T12:00:00.000Z')
  })

  it('o mínimo do motivo é o mesmo do servidor', () => {
    expect(MIN_RESUME_REASON_LENGTH).toBe(10)
    expect(resumeReasonAccepted('   ')).toBe(false)
    expect(resumeReasonAccepted('curto')).toBe(false)
    expect(resumeReasonAccepted('Conferimos tudo.')).toBe(true)
  })
})

describe('a tela conversa com a rota', () => {
  it('abre acessível e sem afirmar nada antes de o servidor responder', () => {
    const port = { read: vi.fn(async () => ({ emergency_stop: stopped })), engage: vi.fn(), release: vi.fn() }
    const html = renderToStaticMarkup(createElement(EmergencyStop, { port }))
    expect(html).toContain('aria-labelledby="emergency-title"')
    expect(html).toContain('Lendo o estado do Studio')
    // A primeira pintura NÃO decide nada sobre segurança sozinha.
    expect(html).not.toContain('O Studio está funcionando')
    expect(html).not.toContain('Parar tudo agora')
  })

  it('a mutação leva o CSRF da sessão, como as outras', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ emergency_stop: stopped }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const port = browserEmergencyStopPort(async () => 'csrf-token')
      await port.engage('  Cobrança em loop.  ')
      const [url, init] = calls[0]!
      expect(url).toBe('/api/studio/apps/emergency-stop/engage')
      expect((init?.headers as Record<string, string>)['x-dz23-csrf']).toBe('csrf-token')
      expect(init?.body).toBe(JSON.stringify({ reason: 'Cobrança em loop.' }))
      // Parar sem motivo manda um corpo vazio, e não um motivo em branco.
      await port.engage('   ')
      expect(calls[1]![1]?.body).toBe('{}')
    } finally { vi.unstubAllGlobals() }
  })

  it('uma recusa do servidor vira a frase do servidor, não um erro genérico', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Retomar exige confirmação com sua chave de acesso nesta sessão.' }), { status: 401 },
    )))
    try {
      const port = browserEmergencyStopPort(async () => 'csrf-token')
      await expect(port.release('Achei que já podia voltar.')).rejects.toThrow('chave de acesso')
    } finally { vi.unstubAllGlobals() }
  })

  it('uma leitura que falha não é apresentada como "tudo funcionando"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    try {
      const port = browserEmergencyStopPort(async () => 'csrf-token')
      await expect(port.read()).rejects.toThrow('Não foi possível ler o estado')
    } finally { vi.unstubAllGlobals() }
  })
})
