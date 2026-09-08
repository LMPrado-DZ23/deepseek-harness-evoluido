/**
 * O catálogo de integrações como ele é PERGUNTADO: busca por texto, filtro por
 * tipo e por estado, e uma página por vez.
 *
 * Tudo aqui é função pura, e tudo aqui roda no SERVIDOR. Mandar o escopo
 * inteiro e filtrar na tela não é paginação — é fingir que é: o trabalho e o
 * tráfego continuam crescendo com o número de integrações, e quem tem muitas é
 * justamente quem pagaria por isso.
 */
import type { IntegrationKind, StudioIntegration, Verification } from './model.js'

/** Quantas integrações uma página traz por padrão, e o teto que o pedido não passa. */
export const INTEGRATIONS_PAGE_SIZE = 20
export const INTEGRATIONS_PAGE_MAX = 100

/** Quanto texto de busca o servidor aceita. Acima disto não é busca, é entrada de dados. */
export const SEARCH_MAX_LENGTH = 120

/** Ligada, desligada, ou tanto faz. */
export type IntegrationStatusFilter = 'all' | 'enabled' | 'disabled'

export interface IntegrationQuery {
  /** Texto livre. Compara sem acento e sem caixa: quem digita "salao" acha "Salão". */
  readonly search?: string | undefined
  /** Vazio ou ausente = todos os tipos. */
  readonly kinds?: readonly IntegrationKind[] | undefined
  readonly status?: IntegrationStatusFilter | undefined
  /** Vazio ou ausente = qualquer verificação. */
  readonly verifications?: readonly Verification[] | undefined
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

export interface IntegrationPage {
  readonly integrations: readonly StudioIntegration[]
  /** Posição da próxima página, ou `null` quando não há mais nada depois desta. */
  readonly next_cursor: string | null
  /**
   * Quantas integrações existem NO ESCOPO, ignorando o filtro, e quantas o
   * filtro deixou passar.
   *
   * São dois números porque "nada encontrado para X" e "você ainda não tem
   * integração" são situações diferentes, e uma lista vazia sozinha não
   * distingue as duas: quem lê a tela precisa saber se procurou errado ou se
   * ainda não registrou nada.
   */
  readonly total: number
  readonly matched: number
}

/**
 * O texto como ele é comparado: sem acento, sem caixa e sem espaço sobrando.
 *
 * Sem tirar o acento, buscar por "salao" não achava "Salão" — e ninguém digita
 * acento numa caixa de busca com pressa.
 * @param value - o texto original.
 * @returns o texto normalizado para comparação.
 */
export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

/**
 * Se uma integração responde ao texto buscado.
 *
 * Procura no que a pessoa vê ou digitaria: o nome, o id do manifesto, o nome do
 * publicador e a descrição. NÃO procura em `secret_ref`: o nome de um segredo do
 * cofre não é campo de busca, e um acerto ali contaria a quem procurasse quais
 * nomes existem lá dentro.
 * @param integration - o registro.
 * @param needle - o texto já normalizado por `normalizeSearch`.
 * @returns `true` quando algum campo público contém o texto.
 */
export function matchesSearch(integration: StudioIntegration, needle: string): boolean {
  if (needle === '') return true
  const haystack = [
    integration.name,
    integration.manifest?.id ?? '',
    integration.manifest?.publisher.name ?? '',
    integration.manifest?.description ?? '',
  ]
  return haystack.some(field => normalizeSearch(field).includes(needle))
}

/** Se uma integração passa por tipo, estado e verificação. Filtro vazio não filtra nada. */
export function matchesFilters(integration: StudioIntegration, query: IntegrationQuery): boolean {
  if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(integration.kind)) return false
  if (query.status === 'enabled' && !integration.enabled) return false
  if (query.status === 'disabled' && integration.enabled) return false
  if (query.verifications !== undefined && query.verifications.length > 0
    && !query.verifications.includes(integration.verification)) return false
  return true
}

/**
 * A ordem do catálogo: o nome como uma pessoa lê (sem acento e sem caixa) e,
 * quando dois nomes empatam, o id.
 *
 * A ordem tem de ser TOTAL e estável, senão a paginação repete ou pula
 * registros: o cursor é uma posição nesta ordem, não um número de página.
 */
export function catalogOrder(left: StudioIntegration, right: StudioIntegration): number {
  const leftName = normalizeSearch(left.name)
  const rightName = normalizeSearch(right.name)
  if (leftName !== rightName) return leftName < rightName ? -1 : 1
  return left.integration_id < right.integration_id ? -1 : left.integration_id > right.integration_id ? 1 : 0
}

/**
 * O cursor é opaco de propósito: é uma posição nesta ordem, não uma API.
 *
 * O separador é NUL, e não um espaço, porque nome de integração TEM espaço:
 * cortar por espaço partia "E-mail do aplicativo" no primeiro deles e devolvia
 * uma posição que não era a de ninguém.
 */
export function encodeCatalogCursor(integration: StudioIntegration): string {
  return Buffer.from(`${normalizeSearch(integration.name)}\u0000${integration.integration_id}`, 'utf8').toString('base64url')
}

/** A posição que o cursor guarda, ou `undefined` quando ele não é legível. */
export function decodeCatalogCursor(cursor: string): { readonly name: string; readonly integrationId: string } | undefined {
  const [name, integrationId] = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000')
  if (name === undefined || integrationId === undefined || integrationId === '') return undefined
  return { name, integrationId }
}

/**
 * Uma página do catálogo já filtrada, ordenada e cortada.
 *
 * O corte é por CHAVE (nome + id), não por deslocamento: registrar ou apagar
 * uma integração enquanto alguém pagina não faz a página seguinte repetir nem
 * pular linhas, que é o defeito clássico do `offset`.
 * @param rows - as integrações do escopo, como o repositório as devolveu.
 * @param query - busca, filtros e posição.
 * @returns a página, a próxima posição e os dois totais.
 * @throws RangeError quando o cursor apresentado não é legível.
 */
export function pageOfIntegrations(rows: readonly StudioIntegration[], query: IntegrationQuery = {}): IntegrationPage {
  const needle = normalizeSearch(query.search ?? '')
  const matching = rows.filter(row => matchesFilters(row, query) && matchesSearch(row, needle)).sort(catalogOrder)
  const after = query.cursor === undefined ? undefined : decodeCatalogCursor(query.cursor)
  // Um cursor ilegível viraria, calado, a primeira página: quem chamou pediu uma
  // posição, e devolver outra sem dizer nada é pior do que recusar.
  if (query.cursor !== undefined && after === undefined) throw new RangeError('INTEGRATION_CURSOR_INVALID')
  const start = after === undefined
    ? 0
    : matching.findIndex(row => {
      const name = normalizeSearch(row.name)
      return name > after.name || (name === after.name && row.integration_id > after.integrationId)
    })
  const window = start < 0 ? [] : matching.slice(start, start + boundedLimit(query.limit))
  const last = window.at(-1)
  const consumed = start < 0 ? matching.length : start + window.length
  return {
    integrations: window,
    // Só existe cursor enquanto ainda há algo depois dele: sem isto o cliente dá
    // uma volta a mais só para descobrir que a lista já tinha acabado.
    next_cursor: last !== undefined && consumed < matching.length ? encodeCatalogCursor(last) : null,
    total: rows.length,
    matched: matching.length,
  }
}

/** O limite pedido, preso entre 1 e o teto. Um pedido sem limite recebe o padrão. */
export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return INTEGRATIONS_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(limit), 1), INTEGRATIONS_PAGE_MAX)
}
