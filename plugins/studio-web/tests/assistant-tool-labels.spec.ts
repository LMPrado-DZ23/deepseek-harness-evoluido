import { describe, expect, it } from 'vitest'
import { listaDeTarefas, planoApresentado, rotuloDoAgenteGeral, trechoSeguro } from '../src/assistant-tool-labels.js'
import { sanitizeAssistantEvent } from '../src/assistant-conversation.js'

const evento = (type: string, seq: number, data: Record<string, unknown>) => ({ type, seq, time: 100 + seq, data })

describe('o que o agente está fazendo, em português', () => {
  it.each([
    ['web_search', { queries: ['capital da Austrália'] }, 'Pesquisando na internet: capital da Austrália'],
    ['web_fetch', { url: 'https://pt.wikipedia.org/wiki/Canberra' }, 'Lendo a página: pt.wikipedia.org'],
    ['write', '{"file_path":"resposta.md","content":"x"}', 'Escrevendo o arquivo: resposta.md'],
    ['bash', { command: 'ls -la', description: 'Listar a pasta' }, 'Rodando um comando: Listar a pasta'],
    ['bash', { command: 'ls\n-la' }, 'Rodando um comando: ls -la'],
    ['read', {}, 'Lendo o arquivo'],
  ])('%s', (nome, args, rotulo) => {
    expect(rotuloDoAgenteGeral(nome, args)).toBe(rotulo)
  })

  it('ferramenta do Studio não é do agente geral', () => {
    expect(rotuloDoAgenteGeral('studio_agent_start', {})).toBeUndefined()
  })

  it('o detalhe é curto e sem controle', () => {
    expect(trechoSeguro('a'.repeat(300)).length).toBe(120)
    expect(trechoSeguro('a\u0000b\nc')).toBe('a b c')
  })
})

describe('lista de tarefas e plano viram itens da conversa', () => {
  it('todo_write vira todo.state', () => {
    const e = sanitizeAssistantEvent(evento('tool/call', 3, { callId: 'c1', name: 'todo_write', arguments: { todos: [{ content: 'Pesquisar', status: 'completed' }, { content: 'Escrever', status: 'in_progress' }] } }))
    expect(e).toEqual({ type: 'todo.state', seq: 3, at: 103, items: [{ content: 'Pesquisar', status: 'completed' }, { content: 'Escrever', status: 'in_progress' }] })
  })

  it('exit_plan_mode vira plan.proposed', () => {
    expect(sanitizeAssistantEvent(evento('tool/call', 4, { callId: 'c2', name: 'exit_plan_mode', arguments: '{"plan":"# Plano\\n1. fazer"}' })))
      .toEqual({ type: 'plan.proposed', seq: 4, at: 104, text: '# Plano\n1. fazer' })
  })

  it('lista malformada não vira lista (volta a ser linha de ferramenta)', () => {
    expect(listaDeTarefas({ todos: [{ content: 'x', status: 'talvez' }] })).toBeUndefined()
    expect(sanitizeAssistantEvent(evento('tool/call', 5, { callId: 'c3', name: 'todo_write', arguments: { todos: 'x' } }))).toMatchObject({ type: 'tool.state', label: 'Atualizando a lista de tarefas' })
    expect(planoApresentado({ plan: '  ' })).toBeUndefined()
  })

  it('a chamada comum leva o rótulo com o detalhe', () => {
    expect(sanitizeAssistantEvent(evento('tool/call', 6, { callId: 'c4', name: 'web_search', arguments: { queries: ['frigg'] } }))).toMatchObject({ type: 'tool.state', label: 'Pesquisando na internet: frigg', state: 'running' })
  })
})

describe('cada subagente diz qual trabalho recebeu', () => {
  it('a descrição da delegação entra no rótulo; sem ela, o rótulo genérico', () => {
    expect(rotuloDoAgenteGeral('subagent', { description: 'Pesquisar concorrentes', prompt: 'x' })).toBe('Delegando trabalho a um subagente: Pesquisar concorrentes')
    expect(rotuloDoAgenteGeral('subagent_fork', '{"description":"Resumir o PDF"}')).toBe('Delegando trabalho a um subagente: Resumir o PDF')
    expect(rotuloDoAgenteGeral('subagent', {})).toBe('Delegando trabalho a um subagente')
    expect(rotuloDoAgenteGeral('list_agents', { description: 'ignorado' })).toBe('Delegando trabalho a um subagente')
  })
})
