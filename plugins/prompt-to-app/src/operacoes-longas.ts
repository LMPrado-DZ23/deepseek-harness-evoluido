import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * As OPERAÇÕES LONGAS: pedidos que esperam o modelo, respondidos depois.
 *
 * Medido em 19/09/2026 na jornada real (Chrome no Windows, FRIGG no WSL2,
 * qwen2.5-coder:7b): "Montar meu plano" levou mais de cinco minutos, o servidor
 * gravou o plano, e a tela nunca soube — o pedido terminou aos 308 s com
 * status 0, e a pessoa ficou olhando um botão que não mudava. O navegador
 * desiste de esperar os cabeçalhos de uma resposta por volta dos 300 s; um
 * modelo local em CPU passa disso com folga, no plano, na síntese e na leitura.
 *
 * O conserto não encurta a espera: ele a tira do pedido. Quando o cliente
 * avisa que sabe esperar (`x-dz23-espera: longa`), a rota responde 202 na hora
 * com um identificador, trabalha em segundo plano, e o cliente pergunta pelo
 * resultado. O RESULTADO é o mesmo que a rota devolveria — o mesmo status, o
 * mesmo corpo, o mesmo erro —, porque ela roda exatamente o mesmo código,
 * escrevendo numa resposta capturada.
 *
 * Um cliente que não avisa continua recebendo a resposta síncrona de antes.
 */

export const CABECALHO_DA_ESPERA = 'x-dz23-espera'

/** Quem pode perguntar pelo resultado: a mesma pessoa, no mesmo escopo e projeto. */
export interface DonoDaOperacao {
  readonly orgId: string
  readonly tenantId: string
  readonly userId: string
  readonly projectId: string
}

export type EstadoDaOperacao =
  | { readonly estado: 'EM_ANDAMENTO' }
  | { readonly estado: 'PRONTA'; readonly status: number; readonly corpo: unknown }

interface Registro {
  readonly dono: DonoDaOperacao
  resultado?: { readonly status: number; readonly corpo: unknown; readonly em: number }
}

const mesmoDono = (a: DonoDaOperacao, b: DonoDaOperacao) =>
  a.orgId === b.orgId && a.tenantId === b.tenantId && a.userId === b.userId && a.projectId === b.projectId

export class OperacoesLongas {
  readonly #registros = new Map<string, Registro>()
  readonly #agora: () => number
  readonly #validadeMs: number
  readonly #maximo: number

  constructor(opcoes: { readonly agora?: () => number; readonly validadeMs?: number; readonly maximo?: number } = {}) {
    this.#agora = opcoes.agora ?? Date.now
    this.#validadeMs = opcoes.validadeMs ?? 30 * 60_000
    this.#maximo = opcoes.maximo ?? 500
  }

  /**
   * Começa o trabalho e devolve o identificador. Uma falha INESPERADA do
   * trabalho vira 500, e não uma operação eterna.
   */
  iniciar(dono: DonoDaOperacao, trabalho: () => Promise<{ readonly status: number; readonly corpo: unknown }>): string {
    this.#limpar()
    if (this.#registros.size >= this.#maximo) throw new Error('OPERACOES_LONGAS_ESGOTADAS')
    const id = randomUUID()
    const registro: Registro = { dono }
    this.#registros.set(id, registro)
    void trabalho()
      .then(saida => { registro.resultado = { ...saida, em: this.#agora() } })
      .catch((erro: unknown) => { registro.resultado = { status: 500, corpo: { error: erro instanceof Error ? erro.message : 'FALHA' }, em: this.#agora() } })
    return id
  }

  /** O estado, para o MESMO dono; para qualquer outro, a operação não existe. */
  consultar(dono: DonoDaOperacao, id: string): EstadoDaOperacao | undefined {
    this.#limpar()
    const registro = this.#registros.get(id)
    if (registro === undefined || !mesmoDono(registro.dono, dono)) return undefined
    if (registro.resultado === undefined) return { estado: 'EM_ANDAMENTO' }
    return { estado: 'PRONTA', status: registro.resultado.status, corpo: registro.resultado.corpo }
  }

  #limpar(): void {
    const limite = this.#agora() - this.#validadeMs
    for (const [id, registro] of this.#registros) if (registro.resultado !== undefined && registro.resultado.em < limite) this.#registros.delete(id)
  }
}

/**
 * O pedido, RELIDO de um corpo já recebido.
 *
 * O corpo precisa ser lido ANTES do 202: o Node descarta o que sobrou de um
 * pedido cuja resposta terminou, e o trabalho em segundo plano leria vazio.
 */
export async function pedidoRelido(pedido: IncomingMessage): Promise<IncomingMessage> {
  const pedacos: Buffer[] = []
  for await (const pedaco of pedido) pedacos.push(Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco as string))
  const copia = Readable.from(pedacos.length === 0 ? [] : [Buffer.concat(pedacos)]) as unknown as IncomingMessage
  return Object.assign(copia, { headers: pedido.headers, method: pedido.method, url: pedido.url, socket: pedido.socket })
}

/** Uma resposta que só guarda o que a rota escreveria. */
export class RespostaCapturada {
  status = 200
  #pedacos: string[] = []
  writableEnded = false
  headersSent = false

  writeHead(status: number): this { this.status = status; this.headersSent = true; return this }
  setHeader(): this { return this }
  end(corpo?: string | Buffer): this {
    if (corpo !== undefined) this.#pedacos.push(String(corpo))
    this.writableEnded = true
    return this
  }

  resultado(): { readonly status: number; readonly corpo: unknown } {
    const texto = this.#pedacos.join('')
    let corpo: unknown = null
    try { corpo = texto === '' ? null : JSON.parse(texto) } catch { corpo = { error: 'RESPOSTA_NAO_JSON' } }
    return { status: this.status, corpo }
  }

  comoResposta(): ServerResponse { return this as unknown as ServerResponse }
}
