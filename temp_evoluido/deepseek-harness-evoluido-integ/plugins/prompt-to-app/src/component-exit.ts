import { t } from './i18n.js'

/**
 * SAÍDA DE COMPONENTE E MEDIÇÃO DE GANHO (EVO-12, fatia E4).
 *
 * O §46 exige "estratégia de saída" como CAMPO do registro de candidatos, e a
 * E0 já recusa promover um candidato sem ela. Isto é a outra metade: o que
 * acontece quando a saída é EXECUTADA.
 *
 * A AT-135 nomeia o que não pode acontecer na retirada, e os três são formas de
 * a saída custar mais do que a entrada:
 *
 * - **perder ativo** — sair de um componente e perder o que foi feito com ele
 *   transforma qualquer experimento numa decisão só de ida;
 * - **exportar segredo** — a saída é o momento em que tudo é empacotado, e é
 *   onde uma credencial vai junto sem ninguém olhar;
 * - **fingir que cancelou contrato externo** — desligar a integração não
 *   encerra a assinatura, e dizer que sim faz alguém parar de pagar atenção a
 *   uma cobrança que continua chegando.
 *
 * E a AT-136 cobra a medição: **ganho não é presumido.** Trocar uma ferramenta
 * e declarar melhora porque "parece mais rápido" é o tipo de conclusão que este
 * produto inteiro existe para não aceitar de si mesmo.
 */

/** As etapas de uma retirada, na ordem em que precisam acontecer. */
export const ETAPAS_DE_SAIDA = [
  /** Parar de aceitar trabalho novo. Sem isto, a fila cresce durante a saída. */
  'SUSPENDER_ADMISSOES',
  /** Fechar o que está aberto — ou declarar desconhecido, nunca repetir. */
  'RECONCILIAR_EXECUCOES',
  /** Tirar os dados e artefatos, legíveis sem a ferramenta que saiu. */
  'EXPORTAR_ATIVOS',
  /** A capacidade continua existindo por outro caminho. */
  'ATIVAR_ALTERNATIVA',
  /** As credenciais deixam de existir daquele lado. */
  'RETIRAR_CREDENCIAIS',
] as const
export type EtapaDeSaida = typeof ETAPAS_DE_SAIDA[number]

export interface PlanoDeSaida {
  readonly candidato: string
  readonly capacidade: string
  /** Quem assume a capacidade depois. Vazio invalida o plano. */
  readonly alternativa: string
  readonly etapas: Readonly<Record<EtapaDeSaida, boolean>>
  /** Execuções cujo desfecho ficou desconhecido. */
  readonly execucoes_desconhecidas: readonly string[]
  /** O que sai da máquina no pacote exportado. */
  readonly exportado: readonly string[]
  /** Contratos externos que continuam valendo depois da retirada. */
  readonly contratos_externos_abertos: readonly string[]
}

export const PROBLEMAS_DE_SAIDA = [
  'SEM_ALTERNATIVA',
  'ETAPA_PENDENTE',
  'SEGREDO_NO_PACOTE',
  'EXECUCAO_ABERTA',
  'CONTRATO_FINGIDO_ENCERRADO',
] as const
export type ProblemaDeSaida = typeof PROBLEMAS_DE_SAIDA[number]

/**
 * Como se reconhece um segredo dentro do que está sendo exportado.
 *
 * Por PREFIXO de referência, e não por conteúdo: o produto nunca teve o valor,
 * só a referência ao cofre, então o que pode vazar no pacote é o NOME. Procurar
 * por padrão de chave aqui daria a impressão de uma varredura que este caminho
 * não faz — quem faz isso é o `gate:secrets`, sobre a árvore inteira.
 */
export const PREFIXOS_DE_SEGREDO = ['DZ23_', 'SECRET_', 'TOKEN_', 'API_KEY']

/**
 * Este plano de saída está pronto para ser executado?
 *
 * Devolve TODOS os problemas: uma saída pela metade descoberta em etapas é
 * pior que uma saída recusada, porque a ferramenta já parou de aceitar trabalho
 * quando o segundo problema aparece.
 * @param plano - o plano.
 * @returns os problemas, vazio quando a saída pode acontecer.
 */
export function problemasDaSaida(plano: PlanoDeSaida): readonly ProblemaDeSaida[] {
  const achados = new Set<ProblemaDeSaida>()
  if (plano.alternativa.trim() === '') achados.add('SEM_ALTERNATIVA')
  if (ETAPAS_DE_SAIDA.some(etapa => !plano.etapas[etapa])) achados.add('ETAPA_PENDENTE')
  if (plano.exportado.some(item => PREFIXOS_DE_SEGREDO.some(prefixo => item.startsWith(prefixo)))) achados.add('SEGREDO_NO_PACOTE')
  if (plano.execucoes_desconhecidas.length > 0) achados.add('EXECUCAO_ABERTA')
  // Declarar a etapa de credenciais feita com contrato externo ainda aberto é
  // dizer que a relação acabou. Ela não acabou: a cobrança continua.
  if (plano.contratos_externos_abertos.length > 0 && plano.etapas.RETIRAR_CREDENCIAIS) achados.add('CONTRATO_FINGIDO_ENCERRADO')
  return PROBLEMAS_DE_SAIDA.filter(problema => achados.has(problema))
}

/**
 * A capacidade sobreviveu à retirada?
 *
 * É a mesma pergunta da AT-114, agora do outro lado: lá, recusar um candidato
 * não podia apagar a capacidade; aqui, RETIRAR um que já estava em uso também
 * não pode. É o mesmo defeito, e ele é mais provável na saída — porque sair dá
 * trabalho, e "a gente não faz mais isso" é a forma mais barata de terminar.
 * @param plano - o plano de saída.
 * @returns verdadeiro quando capacidade e alternativa continuam nomeadas.
 */
export function capacidadeSobrevive(plano: PlanoDeSaida): boolean {
  return plano.capacidade.trim() !== '' && plano.alternativa.trim() !== ''
}

/** Uma medição de jornada, com e sem o candidato (AT-136). */
export interface Medicao {
  readonly jornada: string
  readonly aceites_passados: number
  readonly aceites_totais: number
  readonly custo: number
  readonly intervencoes: number
  /** Quantas vezes a jornada foi medida. Uma vez não é medida. */
  readonly repeticoes: number
}

export type VereditoDeGanho =
  | { readonly ganho: 'MELHOR' | 'PIOR' | 'IGUAL'; readonly declaracao: string }
  | { readonly ganho: 'NAO_MEDIDO'; readonly motivo: 'POUCAS_REPETICOES' | 'JORNADAS_DIFERENTES' | 'ACEITES_INCOMPARAVEIS' }

/** O mínimo de repetições para a comparação dizer algo. */
export const MINIMO_DE_REPETICOES = 3

/**
 * O candidato melhorou a jornada?
 *
 * `NAO_MEDIDO` é um resultado de primeira classe aqui, e é o mais comum. As
 * três razões para ele são as três formas de uma comparação enganar:
 *
 * - **poucas repetições** — uma execução a mais rápida não é uma ferramenta
 *   mais rápida;
 * - **jornadas diferentes** — comparar a criação de um cadastro com a de um
 *   painel mede o trabalho, não a ferramenta;
 * - **aceites incomparáveis** — se o total de critérios mudou, a taxa de
 *   aprovação de um não é a do outro.
 *
 * E a regra do §53: "smoke test não prova liderança universal; nenhum teste
 * técnico demonstra lucro garantido". Por isso o veredito vem com uma DECLARAÇÃO
 * do que ele não cobre, e não sozinho.
 * @param semCandidato - a linha de base.
 * @param comCandidato - a medição com o candidato.
 * @returns o veredito, ou por que não dá para medir.
 */
export function ganho(semCandidato: Medicao, comCandidato: Medicao): VereditoDeGanho {
  if (semCandidato.jornada !== comCandidato.jornada) return { ganho: 'NAO_MEDIDO', motivo: 'JORNADAS_DIFERENTES' }
  if (semCandidato.repeticoes < MINIMO_DE_REPETICOES || comCandidato.repeticoes < MINIMO_DE_REPETICOES) {
    return { ganho: 'NAO_MEDIDO', motivo: 'POUCAS_REPETICOES' }
  }
  if (semCandidato.aceites_totais !== comCandidato.aceites_totais) return { ganho: 'NAO_MEDIDO', motivo: 'ACEITES_INCOMPARAVEIS' }
  const taxa = (medicao: Medicao) => medicao.aceites_totais === 0 ? 0 : medicao.aceites_passados / medicao.aceites_totais
  const antes = taxa(semCandidato)
  const depois = taxa(comCandidato)
  const declaracao = DECLARACAO_DE_LIMITE
  if (depois > antes) return { ganho: 'MELHOR', declaracao }
  if (depois < antes) return { ganho: 'PIOR', declaracao }
  // Empate nos aceites: o desempate é por INTERVENÇÃO humana, e não por custo.
  // Custo depende de preço, que muda por fora; intervenção é trabalho de gente,
  // e é o que a pessoa de fato sente.
  if (comCandidato.intervencoes < semCandidato.intervencoes) return { ganho: 'MELHOR', declaracao }
  if (comCandidato.intervencoes > semCandidato.intervencoes) return { ganho: 'PIOR', declaracao }
  return { ganho: 'IGUAL', declaracao }
}

/**
 * O que um veredito de ganho NÃO diz.
 *
 * Grudado no resultado de propósito, como a evidência é grudada numa regra
 * validada: um número sozinho pede obediência, e um número com o limite dele
 * pede julgamento.
 */
export const DECLARACAO_DE_LIMITE = t('exit.measureLimit')
