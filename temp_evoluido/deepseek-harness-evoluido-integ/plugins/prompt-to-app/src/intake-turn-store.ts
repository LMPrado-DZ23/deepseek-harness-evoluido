import type { StudioIntakeTurn } from './model.js'

/**
 * As respostas do intake guardadas em tabela por inquilino, com RLS.
 *
 * ## Por que ESTE domínio primeiro
 *
 * Porque ele é o de menor superfície entre os cinco alcançáveis do `S-08`: no
 * serviço inteiro só existem DOIS pontos que tocam as respostas —
 * `intakeTurns()`, que lê, e `recordTurn()`, que escreve. Ele é escrito no
 * intake e lido na tela do projeto, e não participa da geração: se esta
 * travessia der errado, ela não derruba a criação do aplicativo, que é a única
 * coisa que o produto faz.
 *
 * ## O que ele NÃO faz
 *
 * Ele não substitui o isolamento por código: `intakeTurns` continua conferindo o
 * escopo do ator antes de devolver qualquer coisa. A RLS aqui é defesa em
 * profundidade — ela protege do dia em que alguém escrever uma consulta nova e
 * esquecer o `where`. As duas guardas juntas é que valem alguma coisa; trocar
 * uma pela outra seria andar de lado.
 *
 * ## Interface estrutural, de propósito
 *
 * `@dz23-studio/prompt-to-app` NÃO depende de `@dz23-studio/storage-postgres`.
 * O núcleo do produto não pode passar a exigir um banco específico para
 * compilar — uma instalação sem PostgreSQL continua funcionando na chave-valor,
 * e é isso que o seletor de autoridade garante.
 */

/** A unidade de armazenamento deste domínio. */
export const INTAKE_TURN_UNIT = 'studio_intake_turns'
/** A tabela dentro da unidade. */
export const INTAKE_TURN_TABLE = 'turns'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface IntakeTurnScope {
  readonly orgId: string
  readonly tenantId: string
}

/** O recorte do armazenamento por inquilino que este domínio usa. */
export interface IntakeTurnRecordStore {
  list<T>(scope: IntakeTurnScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  put(scope: IntakeTurnScope, unit: string, table: string, key: string, value: unknown): Promise<void>
}

/**
 * As respostas de um inquilino, mais antiga primeiro.
 *
 * A ORDEM é parte do contrato e não um detalhe: o intake decide a próxima
 * pergunta a partir das respostas já dadas, e a tela do projeto mostra a
 * conversa. Uma lista fora de ordem faria a pessoa reler a própria conversa
 * embaralhada — e faria o intake repetir uma pergunta já respondida.
 *
 * A chave-valor devolvia na ordem de inserção; a tabela não promete ordem
 * nenhuma. Por isso a ordenação é feita AQUI, por `created_at` com o
 * identificador desempatando, e não confiada ao banco.
 * @param store - o armazenamento por inquilino.
 * @param scope - organização e inquilino.
 * @returns as respostas do escopo, em ordem.
 */
export async function listIntakeTurns(store: IntakeTurnRecordStore, scope: IntakeTurnScope): Promise<readonly StudioIntakeTurn[]> {
  const rows = await store.list<StudioIntakeTurn>(scope, INTAKE_TURN_UNIT, INTAKE_TURN_TABLE)
  return rows.map(row => row.value).sort(oldestFirst)
}

/** Grava uma resposta no escopo dela — nunca no escopo de quem pediu. */
export async function putIntakeTurn(store: IntakeTurnRecordStore, value: StudioIntakeTurn): Promise<void> {
  await store.put({ orgId: value.org_id, tenantId: value.tenant_id }, INTAKE_TURN_UNIT, INTAKE_TURN_TABLE, value.turn_id, value)
}

/** Mais antiga primeiro, com o identificador desempatando. */
function oldestFirst(left: StudioIntakeTurn, right: StudioIntakeTurn): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1
  return left.turn_id < right.turn_id ? -1 : left.turn_id > right.turn_id ? 1 : 0
}
