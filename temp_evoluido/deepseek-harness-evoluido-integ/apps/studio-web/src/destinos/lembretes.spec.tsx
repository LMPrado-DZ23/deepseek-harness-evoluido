import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { intervaloEmTexto, lerLembretes, pedidoDeCancelamento } from './lembretes'
import { LembretesDaConversa, ListaDeLembretes } from './Destinos'
import copy from '../i18n/destinos.pt-BR.json'

const INTERVALOS = { minutos: copy.lembretesMinutos, horas: copy.lembretesHoras, dias: copy.lembretesDias }
const porta = (status: number, corpo: unknown) => ({ fetch: vi.fn(async () => new Response(JSON.stringify(corpo), { status })) })

describe('os lembretes na tela Agendado', () => {
  it('intervalo em palavras, na maior unidade exata', () => {
    expect(intervaloEmTexto(86_400 * 2, INTERVALOS)).toBe('2 dia(s)')
    expect(intervaloEmTexto(7_200, INTERVALOS)).toBe('2 hora(s)')
    expect(intervaloEmTexto(900, INTERVALOS)).toBe('15 minuto(s)')
  })

  it('o pedido de cancelamento leva o identificador exato', () => {
    expect(pedidoDeCancelamento('schedule-3', copy.lembretesPedido)).toBe('Cancele o lembrete schedule-3 com a ferramenta de lembretes. Não crie outro.')
  })

  it('lê pela rota da conversa; resposta fora do formato é erro, ilegível passa como tal', async () => {
    const lista = { estado: 'ok', lembretes: [{ id: 'schedule-1', tipo: 'repetido', proximo: '2026-09-19T13:00:00.000Z', atrasado: false, intervaloSegundos: 3600, texto: 'x' }] }
    const ok = porta(200, lista)
    await expect(lerLembretes('c 1', ok)).resolves.toEqual(lista)
    expect(ok.fetch).toHaveBeenCalledWith('/studio/assistant/conversation/c%201/schedules', { method: 'GET', credentials: 'same-origin' })
    await expect(lerLembretes('c', porta(200, { estado: 'ilegivel' }))).resolves.toEqual({ estado: 'ilegivel' })
    await expect(lerLembretes('c', porta(200, { estado: 'ok', lembretes: [{ id: 1 }] }))).rejects.toThrow('formato')
    await expect(lerLembretes('c', porta(200, { estado: 'ok', lembretes: [{ ...lista.lembretes[0], intervaloSegundos: '1' }] }))).rejects.toThrow('formato')
    await expect(lerLembretes('c', porta(200, { estado: 'ok', lembretes: [null] }))).rejects.toThrow('formato')
    await expect(lerLembretes('c', porta(503, {}))).rejects.toThrow('503')
  })

  const desenhar = (estado: Parameters<typeof ListaDeLembretes>[0]['estado'], aviso: string | null = null) =>
    renderToStaticMarkup(<ListaDeLembretes estado={estado} aviso={aviso} aoCancelar={() => {}} aoAtualizar={() => {}} />)

  it('desenha cada estado com a frase certa, e nunca lista vazia no lugar de "não consegui ler"', () => {
    expect(desenhar({ fase: 'lendo' })).toContain(copy.lembretesLendo)
    expect(desenhar({ fase: 'lendo' })).not.toContain(copy.lembretesAtualizar)
    expect(desenhar({ fase: 'erro' })).toContain(copy.lembretesErro)
    expect(desenhar({ fase: 'leu', conversa: 'c', leitura: { estado: 'ilegivel' } })).toContain('não fecha')
    expect(desenhar({ fase: 'leu', conversa: 'c', leitura: { estado: 'ok', lembretes: [] } })).toContain('Nenhum lembrete ativo')
  })

  it('cada lembrete mostra o que diz, quando, e o botão com nome próprio', () => {
    const html = desenhar({ fase: 'leu', conversa: 'c', leitura: { estado: 'ok', lembretes: [
      { id: 'schedule-1', tipo: 'repetido', proximo: '2026-09-19T13:00:00.000Z', atrasado: false, intervaloSegundos: 3600, texto: 'ver pedidos' },
      { id: 'schedule-2', tipo: 'uma-vez', proximo: '2026-09-19T11:00:00.000Z', atrasado: true, texto: 'conferir vendas' },
    ] } }, copy.lembretesPedidoEnviado)
    expect(html).toContain('ver pedidos')
    expect(html).toContain('Repete a cada 1 hora(s)')
    expect(html).toContain('Uma vez · Atrasado')
    expect(html).toContain('aria-label="Pedir para cancelar o lembrete schedule-2"')
    expect(html).toContain(copy.lembretesPedidoEnviado)
    expect(html).toContain('Pausar não existe')
  })

  it('o componente começa lendo', () => {
    expect(renderToStaticMarkup(<LembretesDaConversa ler={() => new Promise(() => {})} />)).toContain(copy.lembretesLendo)
  })
})
