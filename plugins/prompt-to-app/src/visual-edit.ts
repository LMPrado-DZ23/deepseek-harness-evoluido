/**
 * SELEÇÃO VISUAL, IMPACTO E QUALIFICAÇÃO (EVO-04/05/10, fatia E3).
 *
 * O §48 abre com a frase que decide tudo aqui: "identidade do DOM isoladamente
 * não prova uma linha no repositório". Clicar num botão da prévia e escrever no
 * arquivo que o Studio ACHA que corresponde àquele botão é a forma mais fácil
 * de editar o arquivo errado com total confiança — e quem não programa não tem
 * como perceber.
 *
 * Por isso a correspondência aqui tem TRÊS estados, e não dois. Mapa exato,
 * mapa parcial e mapa ausente pedem coisas diferentes de quem está editando, e
 * colapsá-los em "achei / não achei" transforma o parcial em exato.
 */

/** O quanto se sabe sobre a origem de um elemento da prévia (§48). */
export const MAPAS = ['EXATO', 'PARCIAL', 'AUSENTE'] as const
export type Mapa = typeof MAPAS[number]

/** O que uma edição atinge. Os três têm alcances muito diferentes. */
export const ALCANCES = ['INSTANCIA', 'COMPONENTE_COMPARTILHADO', 'MARCA'] as const
export type Alcance = typeof ALCANCES[number]

export interface Origem {
  readonly mapa: Mapa
  readonly arquivo?: string
  readonly componente?: string
  /** A impressão do build de onde a prévia saiu. */
  readonly snapshot_sha256?: string
  /** O elemento veio de um quadro de terceiro? Ele não recebe apontamento. */
  readonly externo?: boolean
}

export type Selecao =
  | { readonly estado: 'EDITAVEL'; readonly arquivo: string; readonly alcance: Alcance }
  | { readonly estado: 'SO_INSPECAO'; readonly motivo: MotivoDeRecusa }

export const MOTIVOS = [
  /** O mapa não existe: não há arquivo a apontar. */
  'MAPA_AUSENTE',
  /** O mapa é parcial: apontar um arquivo aqui seria inventar. */
  'MAPA_PARCIAL',
  /** A prévia é de um build anterior ao que está no disco. */
  'PREVIA_DESATUALIZADA',
  /** Quadro ou componente de terceiro. */
  'ELEMENTO_EXTERNO',
  /** Alguém mexeu no arquivo desde que a prévia saiu. */
  'ALTERACAO_CONCORRENTE',
] as const
export type MotivoDeRecusa = typeof MOTIVOS[number]

export interface ContextoDaEdicao {
  /** A impressão do build que está no disco AGORA. */
  readonly snapshot_atual: string
  /** Arquivos alterados por outra pessoa/agente desde a prévia. */
  readonly alterados_por_outro: readonly string[]
  readonly alcance: Alcance
}

/**
 * Este elemento pode ser EDITADO, ou só inspecionado?
 *
 * A ordem das recusas é a ordem em que elas são decidíveis com certeza, e a
 * primeira que fecha vence. `AUSENTE` e `PARCIAL` vêm antes de qualquer coisa
 * sobre o snapshot porque, sem saber QUAL arquivo é, a pergunta "esse arquivo
 * mudou?" não tem sujeito.
 *
 * O `PARCIAL` recusar a edição é a decisão central deste arquivo. A tentação é
 * editar assim mesmo e avisar que "pode não ser exatamente aqui" — mas quem lê
 * esse aviso é quem não programa, e ela não tem como julgar. Inspecionar é
 * oferecido; editar não.
 * @param origem - o que se sabe sobre o elemento.
 * @param contexto - o estado do disco e da concorrência.
 * @returns o que a tela pode oferecer.
 */
export function selecao(origem: Origem, contexto: ContextoDaEdicao): Selecao {
  if (origem.externo === true) return { estado: 'SO_INSPECAO', motivo: 'ELEMENTO_EXTERNO' }
  if (origem.mapa === 'AUSENTE') return { estado: 'SO_INSPECAO', motivo: 'MAPA_AUSENTE' }
  if (origem.mapa === 'PARCIAL') return { estado: 'SO_INSPECAO', motivo: 'MAPA_PARCIAL' }
  const arquivo = origem.arquivo
  if (arquivo === undefined || arquivo === '') return { estado: 'SO_INSPECAO', motivo: 'MAPA_AUSENTE' }
  if (origem.snapshot_sha256 !== contexto.snapshot_atual) return { estado: 'SO_INSPECAO', motivo: 'PREVIA_DESATUALIZADA' }
  if (contexto.alterados_por_outro.includes(arquivo)) return { estado: 'SO_INSPECAO', motivo: 'ALTERACAO_CONCORRENTE' }
  return { estado: 'EDITAVEL', arquivo, alcance: contexto.alcance }
}

/**
 * O que esta edição vai atingir ALÉM do que a pessoa clicou (EVO-05, AT-121).
 *
 * Mexer numa instância muda um lugar. Mexer num componente compartilhado muda
 * todos os lugares que o usam — e mexer num valor da marca muda tudo que
 * herda dela. A pessoa clicou em UM botão nos três casos.
 *
 * `desconhecido` existe porque a análise tem limite: um componente pode ser
 * usado por um caminho que o índice não resolveu. Dizer "muda 3 lugares"
 * quando podem ser 4 é pior que dizer "muda estes 3, e pode haver outros".
 */
export interface Impacto {
  readonly alcance: Alcance
  readonly atingidos: readonly string[]
  /** A análise não alcançou tudo? */
  readonly incerto: boolean
}

export function impacto(alcance: Alcance, atingidos: readonly string[], incerto: boolean): Impacto {
  return { alcance, atingidos: [...atingidos].sort(), incerto }
}

/**
 * Esta edição exige confirmação antes de acontecer?
 *
 * Instância com alcance conhecido, não. Qualquer coisa que passe de um lugar,
 * ou cuja análise não tenha alcançado tudo, sim. O critério não é "é
 * perigoso?" — é "a pessoa consegue prever o que vai mudar?".
 * @param analise - o impacto medido.
 * @returns verdadeiro quando a pessoa precisa confirmar o alcance.
 */
export function exigeConfirmacao(analise: Impacto): boolean {
  return analise.alcance !== 'INSTANCIA' || analise.incerto || analise.atingidos.length > 1
}

/**
 * AS QUATRO QUALIFICAÇÕES, e elas NÃO se promovem (EVO-10, AT-131).
 *
 * §52, palavra por palavra: "salvar snapshot demonstra persistência; executar
 * testes demonstra resultados naquele snapshot; revisar demonstra parecer
 * independente; autorizar demonstra decisão sobre uma ação/destino específicos.
 * Essas dimensões NÃO formam uma promoção automática."
 *
 * É a mesma doença do resto desta missão: um commit vira "testado", um teste
 * vira "revisado", uma revisão vira "aprovado". Cada salto parece pequeno.
 */
export const QUALIFICACOES = ['SALVO', 'TESTADO', 'REVISADO', 'AUTORIZADO'] as const
export type Qualificacao = typeof QUALIFICACOES[number]

export interface ProvaDeQualificacao {
  readonly qualificacao: Qualificacao
  /** A que snapshot esta prova pertence. */
  readonly snapshot_sha256: string
  /** O ambiente em que ela foi obtida. */
  readonly ambiente: string
  /** Para `AUTORIZADO`: sobre QUAL ação e destino. Autorização é específica. */
  readonly acao?: string
}

/**
 * Quais qualificações ainda valem para o snapshot atual?
 *
 * Uma alteração invalida as provas do snapshot anterior — e elas NÃO são
 * apagadas: §52 manda "preservar resultados antigos como histórico, nunca
 * convertê-los em prova de código novo". Por isso esta função devolve as
 * válidas, e quem chama continua com a lista inteira na mão.
 * @param provas - tudo que já foi obtido.
 * @param snapshot - o snapshot de agora.
 * @returns só as provas daquele snapshot.
 */
export function qualificacoesValidas(
  provas: readonly ProvaDeQualificacao[], snapshot: string,
): readonly ProvaDeQualificacao[] {
  return provas.filter(prova => prova.snapshot_sha256 === snapshot)
}

/**
 * `AUTORIZADO` cobre ESTA ação?
 *
 * Uma autorização é sobre uma ação e um destino específicos. Reusá-la para
 * outra ação é o que o §52 chama de "approval consumida", e é a diferença
 * entre "ele deixou enviar aquele e-mail" e "ele deixou enviar e-mails".
 * @param provas - as provas válidas.
 * @param acao - a ação que se quer executar.
 * @returns verdadeiro só com autorização daquela ação.
 */
export function autorizadoPara(provas: readonly ProvaDeQualificacao[], acao: string): boolean {
  return provas.some(prova => prova.qualificacao === 'AUTORIZADO' && prova.acao === acao)
}
