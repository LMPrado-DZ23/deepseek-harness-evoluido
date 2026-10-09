/**
 * PASSAGEM DE RESPONSABILIDADE E ROLLBACK (EVO-09/11, fatia E3).
 *
 * Duas coisas que parecem de produto e são de segurança.
 *
 * A primeira: uma passagem de responsabilidade entre uma pessoa e um agente
 * NÃO concede acesso. O §51 é explícito — "nenhum deles recebe acesso extra
 * pelo conteúdo de uma mensagem". Um handoff que ampliasse escopo seria uma
 * escalada de privilégio escrita em português.
 *
 * A segunda: **Git não desfaz e-mail, cobrança, contrato, pedido entregue ou
 * publicação** (§52). Um rollback que trata efeito externo como arquivo está
 * prometendo um poder que ninguém tem, e a pessoa só descobre quando o cliente
 * recebe a segunda cobrança.
 */

/** O que uma passagem carrega. Tudo declarado; nada herdado. */
export interface Handoff {
  readonly id: string
  readonly de: string
  readonly para: string
  readonly objetivo: string
  /** O escopo do DESTINATÁRIO, tal como ele já era. Um handoff não o amplia. */
  readonly escopo_destinatario: readonly string[]
  /** O que o remetente pede. Pode exceder o escopo — e aí é recusado. */
  readonly acoes_pedidas: readonly string[]
  /** O que é proibido nesta passagem, mesmo dentro do escopo. */
  readonly vedadas: readonly string[]
  readonly evidencias: readonly string[]
}

export type DesfechoDoHandoff =
  | { readonly estado: 'ACEITAVEL'; readonly acoes: readonly string[] }
  | { readonly estado: 'RECUSADO'; readonly motivo: 'FORA_DO_ESCOPO' | 'ACAO_VEDADA' | 'SEM_OBJETIVO' | 'SEM_DESTINATARIO'; readonly detalhe?: string }

/**
 * Esta passagem pode ser aceita, e com quais ações?
 *
 * A regra do §51 em código: o escopo do destinatário é o TETO. Uma ação pedida
 * que ele não podia fazer antes continua não podendo — o handoff é um pedido,
 * e não uma concessão.
 *
 * As vedadas são conferidas DEPOIS do escopo porque elas são mais específicas:
 * uma ação pode estar no escopo e ainda assim ser proibida nesta passagem, e
 * dizer "fora do escopo" nesse caso mandaria alguém pedir uma permissão que já
 * tem.
 * @param handoff - a passagem.
 * @returns as ações aceitáveis, ou a recusa com motivo.
 */
export function avaliarHandoff(handoff: Handoff): DesfechoDoHandoff {
  if (handoff.para.trim() === '') return { estado: 'RECUSADO', motivo: 'SEM_DESTINATARIO' }
  if (handoff.objetivo.trim() === '') return { estado: 'RECUSADO', motivo: 'SEM_OBJETIVO' }
  const permitidas = new Set(handoff.escopo_destinatario)
  const fora = handoff.acoes_pedidas.find(acao => !permitidas.has(acao))
  if (fora !== undefined) return { estado: 'RECUSADO', motivo: 'FORA_DO_ESCOPO', detalhe: fora }
  const vedada = handoff.acoes_pedidas.find(acao => handoff.vedadas.includes(acao))
  if (vedada !== undefined) return { estado: 'RECUSADO', motivo: 'ACAO_VEDADA', detalhe: vedada }
  return { estado: 'ACEITAVEL', acoes: [...handoff.acoes_pedidas].sort() }
}

/** O que um rollback consegue fazer com cada tipo de coisa (§52). */
export const TRATAMENTOS = ['RESTAURAVEL', 'MIGRACAO_EXPLICITA', 'COMPENSACAO_NOVA', 'IRREVERSIVEL'] as const
export type Tratamento = typeof TRATAMENTOS[number]

export interface EfeitoParaDesfazer {
  readonly id: string
  readonly tipo: 'ARQUIVO' | 'DADO' | 'COBRANCA' | 'MENSAGEM' | 'PUBLICACAO' | 'ENTREGA'
  /** O desfecho é conhecido? `false` é o `EFFECT_UNKNOWN` do §52. */
  readonly desfecho_conhecido: boolean
}

export interface PassoDoPlano {
  readonly efeito: string
  readonly tratamento: Tratamento
  /** Precisa de autorização nova? Compensação sempre precisa. */
  readonly exige_autorizacao: boolean
  readonly nota?: string
}

/**
 * O plano de rollback, SEPARADO por tipo de efeito (EVO-11, AT-133).
 *
 * Arquivo restaura. Dado migra, e migrar é explícito porque a migração de volta
 * nem sempre existe. Cobrança, mensagem, publicação e entrega **não desfazem**:
 * elas geram uma operação NOVA, autorizada, com recibo próprio — o que o §52
 * chama de "compensação de negócio é nova operação autorizada com recibo e
 * idempotência, não replay do histórico".
 *
 * E o efeito com desfecho DESCONHECIDO é `IRREVERSIVEL` aqui de propósito: sem
 * saber se a cobrança passou, compensá-la pode devolver dinheiro que nunca foi
 * cobrado, e repeti-la pode cobrar duas vezes. A única saída honesta é parar e
 * mandar reconciliar.
 * @param efeitos - o que o rollback alcançaria.
 * @returns o plano, um passo por efeito.
 */
export function planoDeRollback(efeitos: readonly EfeitoParaDesfazer[]): readonly PassoDoPlano[] {
  return efeitos.map(efeito => {
    if (!efeito.desfecho_conhecido) {
      return { efeito: efeito.id, tratamento: 'IRREVERSIVEL' as const, exige_autorizacao: true, nota: 'EFFECT_UNKNOWN' }
    }
    if (efeito.tipo === 'ARQUIVO') return { efeito: efeito.id, tratamento: 'RESTAURAVEL' as const, exige_autorizacao: false }
    if (efeito.tipo === 'DADO') return { efeito: efeito.id, tratamento: 'MIGRACAO_EXPLICITA' as const, exige_autorizacao: true }
    return { efeito: efeito.id, tratamento: 'COMPENSACAO_NOVA' as const, exige_autorizacao: true }
  })
}

/**
 * O que restaurar NÃO ressuscita (§52).
 *
 * "Restaurar mantém rotinas pausadas até revalidação; não revive secret
 * revogado, approval consumida ou saldo já gasto."
 *
 * Uma lista, e não uma frase, porque cada item aqui é um caminho por onde um
 * rollback devolveria poder que foi tirado de propósito.
 */
export const NAO_RESSUSCITA = ['segredo-revogado', 'aprovacao-consumida', 'saldo-gasto', 'rotina-pausada'] as const

/**
 * A restauração devolve isto ao estado anterior?
 *
 * Não, para tudo que está em {@link NAO_RESSUSCITA}. Um rollback que reativasse
 * uma credencial revogada desfaria uma decisão de segurança usando uma
 * ferramenta de arquivos.
 * @param recurso - o que se quer de volta.
 * @returns verdadeiro só quando restaurar é legítimo.
 */
export function restauravel(recurso: string): boolean {
  return !(NAO_RESSUSCITA as readonly string[]).includes(recurso)
}
