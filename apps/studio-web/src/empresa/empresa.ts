/**
 * O que a tela de empresas decide ANTES de falar com o servidor.
 *
 * Tudo aqui é função pura de propósito: a decisão que mora dentro de um JSX ou
 * de um `onSubmit` não é exercitada por teste nenhum, e esta lição já apareceu
 * mais de dez vezes neste repositório.
 *
 * A tela NÃO refaz a autoridade do servidor. Ele continua sendo quem recusa —
 * papel, escopo, plano repetido, empresa arquivada. O que estas funções fazem é
 * outra coisa: transformar a recusa que já é previsível numa frase ANTES do
 * envio, para a pessoa não descobrir por um código de estado o que ela poderia
 * ter lido enquanto escrevia.
 */

/** O plano como a tela o carrega: os limites ainda em texto, um por linha. */
export interface RascunhoDoPlano {
  readonly objetivo: string
  readonly publico: string
  readonly oferta: string
  readonly limites: string
}

export interface RascunhoDaEmpresa extends RascunhoDoPlano {
  readonly nome: string
  readonly origem: 'criada' | 'vinculada'
  readonly identidade: string
}

export const RASCUNHO_VAZIO: RascunhoDaEmpresa = {
  nome: '', origem: 'criada', identidade: '', objetivo: '', publico: '', oferta: '', limites: '',
}

/** O plano como o servidor o recebe. */
export interface PlanoEnviado {
  readonly objetivo: string
  readonly publico: string
  readonly oferta: string
  readonly limites: readonly string[]
}

const ESPACOS = /\s+/gu

/** Tira espaço das pontas e junta os repetidos, sem mexer no resto. */
export function textoNormalizado(valor: string): string {
  return valor.replace(ESPACOS, ' ').trim()
}

/**
 * Os limites que a pessoa escreveu, um por linha.
 *
 * Linha em branco some em vez de virar um limite vazio, e duas linhas que só
 * diferem no espaçamento viram uma — a mesma normalização que o servidor faz,
 * para a contagem que a tela mostra ser a que ele vai gravar.
 * @param texto - o campo inteiro.
 * @returns os limites, na ordem em que foram escritos.
 */
export function limitesDoTexto(texto: string): readonly string[] {
  const vistos = new Set<string>()
  const limites: string[] = []
  for (const linha of texto.split('\n')) {
    const limpo = textoNormalizado(linha)
    if (limpo === '' || vistos.has(limpo)) continue
    vistos.add(limpo)
    limites.push(limpo)
  }
  return limites
}

/** O caminho de volta: os limites gravados viram o campo de texto de novo. */
export function textoDosLimites(limites: readonly string[]): string {
  return limites.join('\n')
}

/** O plano do rascunho, normalizado como o servidor vai gravá-lo. */
export function planoDoRascunho(rascunho: RascunhoDoPlano): PlanoEnviado {
  return {
    objetivo: textoNormalizado(rascunho.objetivo),
    publico: textoNormalizado(rascunho.publico),
    oferta: textoNormalizado(rascunho.oferta),
    limites: limitesDoTexto(rascunho.limites),
  }
}

/** A chave do texto de uma recusa da tela. */
export type RecusaDoPlano = 'erroObjetivo' | 'erroPublico' | 'erroLimiteCurto' | 'erroLimitesDemais'

/**
 * Por que este plano ainda não pode ser enviado, ou `null`.
 *
 * A ordem é a de leitura da tela: quem lê de cima para baixo conserta o
 * primeiro problema que encontra, e apontar o último seria mandá-lo procurar.
 * @param rascunho - o plano em edição.
 * @returns a chave do texto da recusa, ou `null` quando ele está pronto.
 */
export function recusaDoPlano(rascunho: RascunhoDoPlano): RecusaDoPlano | null {
  const plano = planoDoRascunho(rascunho)
  if (plano.objetivo.length < 10) return 'erroObjetivo'
  if (plano.publico.length < 3) return 'erroPublico'
  if (plano.limites.some(limite => limite.length < 3)) return 'erroLimiteCurto'
  if (plano.limites.length > 20) return 'erroLimitesDemais'
  return null
}

/**
 * Por que esta empresa ainda não pode ser cadastrada, ou `null`.
 * @param rascunho - a empresa em edição.
 * @returns a chave do texto da recusa, ou `null`.
 */
export function recusaDaEmpresa(rascunho: RascunhoDaEmpresa): 'erroNome' | RecusaDoPlano | null {
  if (textoNormalizado(rascunho.nome).length < 2) return 'erroNome'
  return recusaDoPlano(rascunho)
}

/**
 * Dois planos são o MESMO plano?
 *
 * Os limites são comparados como CONJUNTO: reordenar não é uma decisão nova, e
 * uma versão por reordenação encheria o histórico de mudanças que ninguém
 * tomou.
 *
 * Esta regra está repetida aqui, e a repetição é deliberada e contida: sem ela,
 * a única resposta a um plano repetido seria um 409 depois do envio, e a pessoa
 * não saberia que nada mudou enquanto ainda estava editando. O servidor
 * CONTINUA recusando — a cópia da tela antecipa a recusa, nunca a substitui —, e
 * é por isso que as duas divergirem não abre buraco: a divergência produziria
 * um aviso a menos, e nunca uma gravação a mais.
 * @param esquerdo - um plano.
 * @param direito - o outro.
 * @returns `true` quando não há decisão nova entre eles.
 */
export function planosIguais(esquerdo: PlanoEnviado, direito: PlanoEnviado): boolean {
  return esquerdo.objetivo === direito.objetivo
    && esquerdo.publico === direito.publico
    && esquerdo.oferta === direito.oferta
    && JSON.stringify([...esquerdo.limites].sort()) === JSON.stringify([...direito.limites].sort())
}

/**
 * Por que esta REVISÃO ainda não pode ser enviada, ou `null`.
 * @param rascunho - o plano em edição.
 * @param vigente - o plano que já está gravado.
 * @returns a chave do texto da recusa, ou `null`.
 */
export function recusaDaRevisao(
  rascunho: RascunhoDoPlano,
  vigente: PlanoEnviado,
): 'erroSemMudanca' | RecusaDoPlano | null {
  const recusa = recusaDoPlano(rascunho)
  if (recusa !== null) return recusa
  return planosIguais(planoDoRascunho(rascunho), vigente) ? 'erroSemMudanca' : null
}

/** O rascunho que abre a revisão: o plano vigente, editável. */
export function rascunhoDoPlano(plano: PlanoEnviado): RascunhoDoPlano {
  return {
    objetivo: plano.objetivo,
    publico: plano.publico,
    oferta: plano.oferta,
    limites: textoDosLimites(plano.limites),
  }
}

/**
 * A versão VIGENTE de um histórico de planos.
 *
 * É a de maior VERSÃO, e não a mais recente por data: dois registros no mesmo
 * milissegundo empatariam por data, e a ordem de leitura decidiria qual plano a
 * empresa tem. A mesma regra do servidor, pela mesma razão.
 * @param versoes - o histórico, em qualquer ordem.
 * @returns a versão vigente, ou `undefined` quando não há nenhuma.
 */
export function versaoVigente<T extends { readonly version: number }>(versoes: readonly T[]): T | undefined {
  return versoes.reduce<T | undefined>(
    (maior, atual) => (maior === undefined || atual.version > maior.version ? atual : maior),
    undefined,
  )
}

/**
 * O histórico ANTERIOR à versão vigente, da mais nova para a mais antiga.
 * @param versoes - o histórico completo.
 * @returns as versões que não são a vigente.
 */
export function versoesAnteriores<T extends { readonly version: number }>(versoes: readonly T[]): readonly T[] {
  const vigente = versaoVigente(versoes)
  if (vigente === undefined) return []
  return versoes.filter(versao => versao.version !== vigente.version)
    .sort((esquerda, direita) => direita.version - esquerda.version)
}
