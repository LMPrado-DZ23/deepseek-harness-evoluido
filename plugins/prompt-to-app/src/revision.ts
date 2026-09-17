import { appSpecV1Schema, type AppSpecV1 } from './appspec.js'
import { t } from './i18n.js'

/**
 * Pedir uma alteração numa tarefa que JÁ TERMINOU, sem começar outra tarefa.
 *
 * Isto é o que faltava para a decisão visual `DZ23-VISUAL-VIDEO-20260916-R1`:
 * "Pedir uma alteração continua na MESMA tarefa e no MESMO projeto; não recomeça
 * um wizard." O compositor da conversa aceitava o texto e não tinha para onde
 * mandá-lo — `POST /plan/change` exige plano `PROPOSED`, e depois de um
 * resultado o plano está `APPROVED`. Sem este ponto de extensão, "continuar"
 * teria de criar outro projeto, que é exatamente o defeito recusado.
 *
 * A ampliação é a MENOR possível e não inventa armazenamento:
 *
 * - o pedido vira um critério de aceite a mais na especificação, que é o que
 *   ele é — a pessoa está dizendo o que precisa passar a valer;
 * - a especificação nova é gravada com `origin: 'edit'`, um valor que o
 *   esquema já tinha e que existia para este caso;
 * - a versão do domínio NÃO sobe, porque nenhum registro muda de forma.
 *
 * O que ele deliberadamente NÃO faz: aprovar coisa alguma. Depois da revisão o
 * projeto volta a `SPEC_READY` e o caminho normal segue — propor plano,
 * aprovar, criar. A política de aprovação continua inteira, e é isso que
 * separa "continuar a tarefa" de "gerar de novo sem ninguém olhar".
 */

export type RevisionFailure = 'TOO_SHORT' | 'TOO_LONG' | 'DUPLICATE' | 'TOO_MANY'

export class RevisionError extends Error {
  constructor(readonly code: RevisionFailure, message: string) { super(message) }
}

/** Os limites vêm do próprio esquema de `acceptance_criteria`, não de um palpite. */
export const MIN_PEDIDO = 5
export const MAX_PEDIDO = 300
export const MAX_CRITERIOS = 30

/**
 * O pedido como ele vai ser GRAVADO.
 *
 * Só arruma espaço: as palavras e as maiúsculas continuam sendo as da pessoa,
 * porque este texto vira critério de aceite e alguém vai lê-lo depois.
 * @param texto - o texto escrito pela pessoa.
 * @returns o texto sem espaços nas pontas e com espaços internos colapsados.
 */
export function pedidoNormalizado(texto: string): string {
  return texto.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/**
 * O pedido como ele vai ser COMPARADO.
 *
 * Separado da gravação de propósito, e não por capricho: quem reescreve o
 * mesmo pedido raramente reproduz as maiúsculas, e comparar cru deixaria
 * "o botão VERDE" e "o botão verde" entrarem como dois critérios que a
 * tentativa seguinte confere duas vezes. O que se guarda continua sendo o
 * texto da pessoa; o que se compara é esta chave.
 * @param texto - o pedido, cru ou já normalizado.
 * @returns a chave de comparação.
 */
export function chaveDoPedido(texto: string): string {
  return pedidoNormalizado(texto).toLocaleLowerCase('pt-BR')
}

/**
 * A especificação com o pedido da pessoa incorporado como critério de aceite.
 *
 * @param spec - a especificação vigente da tarefa.
 * @param texto - o que a pessoa escreveu no compositor.
 * @returns a especificação nova, válida pelo mesmo esquema da anterior.
 * @throws RevisionError quando o pedido é curto demais, longo demais, repetido
 * ou não cabe mais um critério.
 */
export function especificacaoRevisada(spec: AppSpecV1, texto: string): AppSpecV1 {
  const pedido = pedidoNormalizado(texto)
  if (pedido.length < MIN_PEDIDO) throw new RevisionError('TOO_SHORT', t('errors.revisionShort'))
  if (pedido.length > MAX_PEDIDO) throw new RevisionError('TOO_LONG', t('errors.revisionLong'))
  // Repetido é REPLAY, não erro de quem escreveu: quem apertou duas vezes não
  // errou, e a resposta certa é não gravar a segunda cópia.
  const chave = chaveDoPedido(pedido)
  if (spec.acceptance_criteria.some(criterio => chaveDoPedido(criterio) === chave)) {
    throw new RevisionError('DUPLICATE', t('errors.revisionDuplicate'))
  }
  if (spec.acceptance_criteria.length >= MAX_CRITERIOS) throw new RevisionError('TOO_MANY', t('errors.revisionFull'))
  // O esquema é reaplicado de propósito: uma especificação gravada por uma
  // versão anterior pode não validar mais, e descobrir isso AQUI é melhor do
  // que descobrir no meio da criação, com a tentativa já paga.
  return appSpecV1Schema.parse({ ...spec, acceptance_criteria: [...spec.acceptance_criteria, pedido] })
}

/** Um pedido de mudança, como a conversa precisa mostrá-lo. */
export interface PedidoDeRevisao {
  readonly spec_id: string
  readonly request: string
  readonly created_at: string
}

/**
 * Os pedidos de mudança de uma tarefa, DERIVADOS das especificações gravadas.
 *
 * A conversa precisa mostrar o que a pessoa escreveu como uma mensagem dela —
 * senão "pedir uma alteração" some da tarefa e reaparece só como um critério
 * dentro de um plano, o que é o oposto de continuar a conversa.
 *
 * Nada novo é gravado para isso existir. Cada revisão já grava uma
 * especificação com `origin: 'edit'`, e o que ela acrescentou é exatamente o
 * critério que a versão anterior não tinha. Guardar o texto uma segunda vez,
 * num campo próprio, criaria duas descrições do mesmo fato — e a que diverge
 * em silêncio costuma ser a que alguém lê.
 *
 * Uma especificação de origem `edit` sem critério novo NÃO vira pedido: ela
 * pode ter vindo de outro caminho de edição, e inventar um texto para ela seria
 * pôr palavras na boca de quem não as escreveu.
 *
 * @param specs - as especificações da tarefa, em qualquer ordem.
 * @returns os pedidos, do mais antigo para o mais recente.
 */
export function pedidosDeRevisao(
  specs: readonly { readonly spec_id: string; readonly version: number; readonly origin: string; readonly created_at: string; readonly app_spec: { readonly acceptance_criteria: readonly string[] } }[],
): readonly PedidoDeRevisao[] {
  const ordenadas = [...specs].sort((esquerda, direita) => esquerda.version - direita.version)
  const pedidos: PedidoDeRevisao[] = []
  for (let indice = 1; indice < ordenadas.length; indice += 1) {
    const atual = ordenadas[indice]!
    if (atual.origin !== 'edit') continue
    const anteriores = new Set(ordenadas[indice - 1]!.app_spec.acceptance_criteria.map(chaveDoPedido))
    const novos = atual.app_spec.acceptance_criteria.filter(criterio => !anteriores.has(chaveDoPedido(criterio)))
    // Mais de um critério novo numa revisão não acontece por este caminho, e se
    // acontecer o primeiro é o que a pessoa escreveu: ele é o que `revise`
    // acrescenta, no fim da lista da versão anterior.
    const pedido = novos[0]
    if (pedido === undefined) continue
    pedidos.push({ spec_id: atual.spec_id, request: pedido, created_at: atual.created_at })
  }
  return pedidos
}
