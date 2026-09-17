/**
 * O USO E OS CUSTOS do espaço de trabalho, como as Preferências os mostram.
 *
 * Esta seção existia como PENDÊNCIA — "não há medição de uso" —, e a medição do
 * `T-35` provou que a frase estava errada: a medição existe, é gravada por
 * inquilino e por rota, tem teto com veredito e sobrevive a reinício. O que não
 * existia era a APRESENTAÇÃO dela fora da tarefa.
 *
 * Uma pendência que descreve errado o produto é o mesmo defeito de uma segunda
 * verdade, com outra roupa: alguém a lê e conserta o que já estava certo, ou
 * constrói de novo o que já existia.
 *
 * ## As regras do adendo valem AQUI também
 *
 * Elas já valem no painel da tarefa, e repeti-las sem função seria copiar a
 * regra para um segundo lugar. O que este módulo faz é o que só se decide na
 * apresentação do ESPAÇO: somar por rota, separar o que foi medido do que não
 * foi, e dizer o veredito do teto em palavras.
 *
 * - **ausência não vira zero.** Rota com chamadas e nenhuma precificada não diz
 *   "custou US$ 0,00": diz que não sabe.
 * - **zero medido continua zero.** Uma rota local, de graça e medida, custou
 *   zero de verdade, e apagar isso seria o erro simétrico.
 * - **o teto sem configuração não vira bloqueio.** Sem teto, o veredito é
 *   "dentro", e a tela não inventa um limite que ninguém definiu.
 */

/** Uma rota, como o servidor a devolve. */
export interface RotaDeUso {
  readonly route: string
  readonly requests: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly estimated_cost_usd: number
  readonly unpriced_requests: number
}

export interface UsoDoEspaco {
  readonly measured: boolean
  readonly routes?: readonly RotaDeUso[]
  readonly budget?: {
    readonly measuredCostUsd: number
    readonly unpricedRequests: number
    readonly verdict: string
  }
}

/** O que a tela mostra para UMA rota. */
export interface LinhaDeUso {
  readonly rota: string
  readonly chamadas: number
  readonly tokens: number
  /** `null` quando o custo daquela rota é desconhecido. NUNCA zero por ausência. */
  readonly custoUsd: number | null
  readonly naoPrecificadas: number
  /** MEDIDO, PARCIAL ou DESCONHECIDO — a mesma escala do serviço. */
  readonly estado: 'MEDIDO' | 'PARCIAL' | 'DESCONHECIDO'
}

/**
 * O estado de custo de uma rota.
 *
 * A mesma regra de `routeCostState` no servidor, e a repetição é deliberada e
 * contida: o servidor decide o que GRAVAR, esta função decide o que MOSTRAR, e
 * elas divergirem produziria um rótulo errado — nunca um número errado, porque
 * o número vem inteiro de lá.
 * @param rota - a rota lida.
 * @returns o estado do custo dela.
 */
export function estadoDoCusto(rota: Pick<RotaDeUso, 'requests' | 'unpriced_requests'>): LinhaDeUso['estado'] {
  if (rota.requests === 0 || rota.unpriced_requests === 0) return 'MEDIDO'
  return rota.unpriced_requests >= rota.requests ? 'DESCONHECIDO' : 'PARCIAL'
}

/**
 * As linhas da tabela de uso, da rota que mais foi usada para a que menos.
 *
 * Rota com ZERO chamadas fica de fora: ela existe no registro porque o Studio a
 * conhece, não porque alguém a usou, e uma linha de zeros faria a tabela
 * parecer cheia de consumo que não houve.
 * @param rotas - as rotas lidas do servidor.
 * @returns as linhas, já ordenadas.
 */
export function linhasDeUso(rotas: readonly RotaDeUso[]): readonly LinhaDeUso[] {
  return rotas
    .filter(rota => rota.requests > 0)
    .map(rota => {
      const estado = estadoDoCusto(rota)
      return {
        rota: rota.route,
        chamadas: rota.requests,
        tokens: rota.input_tokens + rota.output_tokens,
        // DESCONHECIDO vira `null`, e não 0: a tela precisa poder escrever
        // "não sei" onde o custo não foi medido.
        custoUsd: estado === 'DESCONHECIDO' ? null : rota.estimated_cost_usd,
        naoPrecificadas: rota.unpriced_requests,
        estado,
      }
    })
    .sort((esquerda, direita) => direita.chamadas - esquerda.chamadas)
}

/**
 * O total do espaço: o que foi medido, e quantas chamadas ficaram sem preço.
 *
 * O total de custo soma SÓ o que foi medido. A conta que importa ao lado dele é
 * a das não precificadas — sem ela, um espaço inteiro sem preço configurado
 * mostraria "US$ 0,00" e pareceria de graça.
 * @param linhas - as linhas da tabela.
 * @returns o custo medido, as chamadas sem preço e quantas chamadas houve.
 */
export function totalDeUso(linhas: readonly LinhaDeUso[]): {
  readonly custoMedidoUsd: number
  readonly naoPrecificadas: number
  readonly chamadas: number
} {
  return {
    custoMedidoUsd: linhas.reduce((soma, linha) => soma + (linha.custoUsd ?? 0), 0),
    naoPrecificadas: linhas.reduce((soma, linha) => soma + linha.naoPrecificadas, 0),
    chamadas: linhas.reduce((soma, linha) => soma + linha.chamadas, 0),
  }
}

/**
 * A chave do texto do veredito do teto.
 *
 * `WITHIN` sem teto configurado e `WITHIN` com teto são a MESMA resposta para o
 * servidor, e coisas diferentes para quem lê: "dentro do teto" quando não há
 * teto nenhum é uma afirmação sobre um limite que ninguém definiu. Quem sabe a
 * diferença é a tela, e é por isso que ela recebe o total e decide aqui.
 * @param veredito - o veredito do servidor.
 * @param houveConsumo - se alguma chamada foi registrada.
 * @returns a chave do catálogo.
 */
export function chaveDoVeredito(veredito: string | undefined, houveConsumo: boolean): 'semConsumo' | 'dentro' | 'custoExcedido' | 'semPrecoExcedido' | 'naoSei' {
  if (veredito === undefined) return 'naoSei'
  if (veredito === 'COST_EXCEEDED') return 'custoExcedido'
  if (veredito === 'UNPRICED_EXCEEDED') return 'semPrecoExcedido'
  return houveConsumo ? 'dentro' : 'semConsumo'
}

/**
 * Um valor em dólares, escrito como quem lê escreve.
 *
 * `toFixed` devolve `0.0042`, com PONTO decimal — e este produto é inteiro em
 * português do Brasil, onde o separador é vírgula. A divergência apareceu na
 * conferência da captura de entrega, e não em teste nenhum: a tela estava certa
 * em tudo, menos na língua em que escrevia número.
 *
 * Quatro casas porque o custo de uma chamada é da ordem de milésimos de dólar;
 * com duas, quase todo consumo real apareceria como `US$ 0,00`.
 * @param valor - o custo em dólares.
 * @returns o texto, com o símbolo.
 */
export function custoEmTexto(valor: number): string {
  return `US$ ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
}

/**
 * Uma contagem grande, com o separador de milhar de quem lê.
 * @param valor - a contagem.
 * @returns o texto.
 */
export function contagemEmTexto(valor: number): string {
  return valor.toLocaleString('pt-BR')
}
