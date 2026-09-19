import { t } from './i18n.js'

/**
 * O que cada ferramenta do agente geral está FAZENDO, em português, com o
 * detalhe que a pessoa precisa para acompanhar: o que foi pesquisado, qual
 * página, qual arquivo, qual comando.
 *
 * Antes desta fatia toda ferramenta do agente geral aparecia como "Executar
 * uma ação do FRIGG" — a pessoa via o agente trabalhar e não sabia em quê.
 * O detalhe é CURTO (120 caracteres), sem quebra de linha nem caractere de
 * controle, e só a pessoa dona da conversa o vê.
 */

const MAXIMO = 120

export function argumentosDaChamada(valor: unknown): Readonly<Record<string, unknown>> {
  if (typeof valor === 'string') {
    try { const lido: unknown = JSON.parse(valor); return typeof lido === 'object' && lido !== null && !Array.isArray(lido) ? lido as Record<string, unknown> : {} } catch { return {} }
  }
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? valor as Record<string, unknown> : {}
}

export function trechoSeguro(valor: unknown): string {
  if (typeof valor !== 'string') return ''
  const limpo = valor.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return limpo.length > MAXIMO ? limpo.slice(0, MAXIMO - 1) + '\u2026' : limpo
}

function comDetalhe(chave: string, detalhe: string): string {
  const base = t(chave)
  return detalhe === '' ? base : `${base}: ${detalhe}`
}

function hostDe(url: unknown): string {
  if (typeof url !== 'string') return ''
  try { return new URL(url).host } catch { return trechoSeguro(url) }
}

/**
 * O rótulo da chamada, ou `undefined` quando a ferramenta não é do agente
 * geral (as do Studio têm os rótulos delas).
 * @param nome - o nome da ferramenta.
 * @param argumentos - os argumentos, como o modelo os mandou.
 */
export function rotuloDoAgenteGeral(nome: string, argumentos: unknown): string | undefined {
  const a = argumentosDaChamada(argumentos)
  switch (nome) {
    case 'web_search': {
      const consultas = Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === 'string') : []
      return comDetalhe('tools.webSearch', trechoSeguro(consultas.join(' · ')))
    }
    case 'web_fetch': return comDetalhe('tools.webFetch', hostDe(a.url))
    case 'read': case 'read_image': return comDetalhe('tools.read', trechoSeguro(a.file_path))
    case 'write': return comDetalhe('tools.write', trechoSeguro(a.file_path))
    case 'edit': return comDetalhe('tools.edit', trechoSeguro(a.file_path))
    case 'glob': case 'grep': return comDetalhe('tools.search', trechoSeguro(a.pattern))
    case 'bash': return comDetalhe('tools.bash', trechoSeguro(typeof a.description === 'string' && a.description.trim() !== '' ? a.description : a.command))
    case 'skill': return comDetalhe('tools.skill', trechoSeguro(a.skill_name ?? a.name))
    case 'subagent': case 'subagent_fork': case 'send_message': case 'interrupt_agent': case 'list_agents': case 'list_subagent_models':
      return t('tools.delegation')
    case 'workflow': case 'ralph': return t('tools.workflow')
    case 'job_list': case 'job_output': case 'job_kill': return t('tools.jobs')
    case 'create_goal': case 'get_goal': case 'update_goal': return t('tools.goal')
    case 'ask_user_question': return t('tools.ask')
    case 'todo_write': return t('tools.todo')
    case 'exit_plan_mode': return t('tools.plan')
    default: return undefined
  }
}

export interface ItemDaLista { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }

/**
 * A LISTA DE TAREFAS que o agente escreveu, para a conversa mostrar como lista.
 * @param argumentos - os argumentos do `todo_write`.
 * @returns os itens, ou `undefined` quando não é uma lista válida.
 */
export function listaDeTarefas(argumentos: unknown): readonly ItemDaLista[] | undefined {
  const a = argumentosDaChamada(argumentos)
  if (!Array.isArray(a.todos)) return undefined
  const itens: ItemDaLista[] = []
  for (const item of a.todos.slice(0, 50)) {
    if (typeof item !== 'object' || item === null) return undefined
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return undefined
    itens.push({ content: trechoSeguro(content), status })
  }
  return itens
}

/** O plano apresentado (markdown), com teto. */
export function planoApresentado(argumentos: unknown): string | undefined {
  const plano = argumentosDaChamada(argumentos).plan
  if (typeof plano !== 'string' || plano.trim() === '') return undefined
  return plano.length > 16_000 ? plano.slice(0, 16_000) + '\u2026' : plano
}
