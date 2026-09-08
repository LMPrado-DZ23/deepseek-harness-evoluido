/**
 * O que se sabe sobre CHAMAR uma integração: saúde, teto de chamadas, tempo
 * máximo, a repetição única e o custo.
 *
 * Tudo aqui é função pura sobre o registro que já está gravado. A saúde e o
 * custo NÃO são campos guardados: eles são derivados dos contadores toda vez
 * que alguém pergunta. Um estado gravado envelhece e passa a discordar dos
 * contadores que o produziram — e a primeira coisa que ele mente é dizer `OK`
 * de uma integração que nunca foi chamada.
 */
import type { StudioIntegration } from './model.js'

/**
 * O que se pode honestamente dizer sobre uma integração.
 *
 * `NOT_EXECUTED`: nunca foi chamada. Não é `OK`: ninguém tentou.
 * `OK`: chamada e respondendo.
 * `DEGRADED`: falhando parte das vezes, ou com falhas seguidas ainda abaixo do limite.
 * `DOWN`: falhando de forma que não dá para chamar de intermitente.
 */
export type IntegrationHealthState = 'OK' | 'DEGRADED' | 'DOWN' | 'NOT_EXECUTED'

/** Contadores de que a saúde depende. Um registro gravado antes deles não tem nenhum, e isso é uma resposta. */
export type IntegrationRuntimeCounters = Pick<
  StudioIntegration, 'calls' | 'failures' | 'consecutive_failures' | 'timeouts' | 'retries' | 'total_latency_ms' | 'cost_usd' | 'unpriced_calls' | 'last_call_at' | 'last_failure'
>

/**
 * Onde a taxa de erro deixa de ser incidente e vira estado.
 *
 * São os mesmos degraus que a saúde de rotas usa (`plugins/route-health`), para
 * que "DEGRADED" queira dizer a mesma coisa nas duas telas do Studio.
 */
export const INTEGRATION_DEGRADED_RATE = 0.25
export const INTEGRATION_DOWN_RATE = 0.5

/** Falhas SEGUIDAS que já bastam para chamar de `DOWN`, mesmo com histórico bom. */
export const INTEGRATION_DOWN_STREAK = 3

/**
 * A saúde de uma integração pelo que realmente aconteceu.
 *
 * A taxa sozinha esconde o presente: uma integração com mil sucessos antigos e
 * as últimas três chamadas falhando ainda tem taxa baixíssima e está fora do ar
 * agora. Por isso as falhas seguidas decidem primeiro.
 * @param record - os contadores gravados no registro.
 * @returns o estado honesto, incluindo `NOT_EXECUTED` para quem nunca foi chamada.
 */
export function integrationHealthState(record: IntegrationRuntimeCounters): IntegrationHealthState {
  const calls = record.calls ?? 0
  if (calls === 0) return 'NOT_EXECUTED'
  const failures = record.failures ?? 0
  if ((record.consecutive_failures ?? 0) >= INTEGRATION_DOWN_STREAK) return 'DOWN'
  const rate = failures / calls
  if (rate >= INTEGRATION_DOWN_RATE) return 'DOWN'
  return rate >= INTEGRATION_DEGRADED_RATE ? 'DEGRADED' : 'OK'
}

/**
 * O que se pode honestamente dizer sobre o custo de uma integração.
 *
 * `UNKNOWN`: nenhuma chamada contada tinha preço — o número somado é zero
 * porque ninguém sabia, não porque nada foi gasto.
 * `PARTIAL`: parte teve preço; o valor é um piso, não o total.
 * `MEASURED`: toda chamada contada tinha preço informado.
 */
export type IntegrationCostState = 'MEASURED' | 'PARTIAL' | 'UNKNOWN'

/**
 * Classifica o custo pelo que realmente se sabe, seguindo `routeCostState` de
 * `plugins/route-health/src/service.ts`, com UMA diferença deliberada: sem
 * nenhuma chamada o estado aqui é `UNKNOWN`, não `MEASURED`.
 *
 * Em rotas, zero requisições é uma medição de zero — a rota existe no perfil e
 * não foi usada. Uma integração que nunca foi chamada é outra coisa: nada foi
 * medido, e apresentar `MEASURED` com `0` ao lado de `NOT_EXECUTED` diria à
 * pessoa que ela já sabe que essa integração é de graça.
 * @param record - os contadores gravados no registro.
 * @returns o estado do custo, para quem for apresentar o número.
 */
export function integrationCostState(record: Pick<IntegrationRuntimeCounters, 'calls' | 'unpriced_calls'>): IntegrationCostState {
  const calls = record.calls ?? 0
  if (calls === 0) return 'UNKNOWN'
  const unpriced = record.unpriced_calls ?? 0
  if (unpriced === 0) return 'MEASURED'
  return unpriced >= calls ? 'UNKNOWN' : 'PARTIAL'
}

/** A saúde de uma integração como ela viaja para a tela: estado, números e o que se sabe do custo. */
export interface IntegrationHealth {
  readonly state: IntegrationHealthState
  readonly calls: number
  readonly failures: number
  readonly timeouts: number
  readonly retries: number
  /** `null` quando nunca foi chamada: uma média de zero chamadas não é zero, é nada. */
  readonly average_latency_ms: number | null
  readonly last_call_at: string | null
  readonly last_failure: string | null
  readonly cost_state: IntegrationCostState
  /** O custo MEDIDO. Só significa "o total" quando `cost_state` é `MEASURED`. */
  readonly cost_usd: number
}

/**
 * A saúde de um registro, pronta para a resposta HTTP.
 * @param record - o registro da integração.
 * @returns saúde, contadores e custo, sem inventar nenhum deles.
 */
export function integrationHealth(record: IntegrationRuntimeCounters): IntegrationHealth {
  const calls = record.calls ?? 0
  return {
    state: integrationHealthState(record),
    calls,
    failures: record.failures ?? 0,
    timeouts: record.timeouts ?? 0,
    retries: record.retries ?? 0,
    average_latency_ms: calls === 0 ? null : (record.total_latency_ms ?? 0) / calls,
    last_call_at: record.last_call_at ?? null,
    last_failure: record.last_failure ?? null,
    cost_state: integrationCostState(record),
    cost_usd: record.cost_usd ?? 0,
  }
}

/**
 * Os limites de UMA chamada de integração.
 *
 * `retryOnce` é exatamente uma repetição — não uma política de tentativas. Duas
 * chamadas para um provedor que já está lento é a forma mais rápida de derrubá-lo
 * de vez, e é por isso que não existe um número aqui para alguém aumentar.
 */
export interface IntegrationCallPolicy {
  readonly timeoutMs: number
  /** Tentativas que uma integração pode fazer dentro da janela, POR ESCOPO. */
  readonly maxCallsPerWindow: number
  readonly windowMs: number
  readonly retryOnce: boolean
}

/**
 * O padrão da casa: dez segundos por chamada, sessenta tentativas por minuto e
 * uma repetição.
 *
 * Dez segundos é longo o bastante para um provedor lento responder e curto o
 * bastante para a pessoa não ficar olhando uma tela parada sem saber de quê. O
 * teto é por integração e por escopo: uma integração em laço não gasta a cota de
 * nenhuma outra, nem a de outro inquilino.
 */
export const DEFAULT_INTEGRATION_CALL_POLICY: IntegrationCallPolicy = {
  timeoutMs: 10_000, maxCallsPerWindow: 60, windowMs: 60_000, retryOnce: true,
}

/**
 * Se esta chamada pode ser repetida.
 *
 * A repetição só existe para operação IDEMPOTENTE. Repetir um envio, uma
 * cobrança ou um webhook que já pode ter chegado do outro lado é fazer a coisa
 * duas vezes — e do lado de cá parece uma falha só. Quem chama declara; na
 * dúvida, declara não idempotente e não há repetição.
 * @param policy - os limites em vigor.
 * @param idempotent - se repetir a operação é o mesmo que fazê-la uma vez.
 * @param attempts - quantas tentativas já saíram.
 * @returns `true` só para a segunda tentativa de uma operação idempotente.
 */
export function mayRetry(policy: IntegrationCallPolicy, idempotent: boolean, attempts: number): boolean {
  return policy.retryOnce && idempotent && attempts === 1
}

/**
 * Uma janela deslizante de tentativas, por integração e por escopo.
 *
 * Guarda o instante de cada tentativa e descarta o que saiu da janela. É por
 * TENTATIVA, não por chamada: a repetição única também sai pela rede, e não
 * contá-la deixaria o teto valer o dobro exatamente quando o provedor está
 * falhando — o pior momento possível para dobrar a carga em cima dele.
 */
export class IntegrationRateLimiter {
  readonly #windows = new Map<string, number[]>()

  constructor(private readonly policy: IntegrationCallPolicy = DEFAULT_INTEGRATION_CALL_POLICY) {}

  /**
   * Registra uma tentativa se ainda couber na janela.
   * @param key - integração dentro de um escopo.
   * @param now - o instante da tentativa, em milissegundos.
   * @returns `true` quando a tentativa foi admitida; `false` quando o teto foi atingido.
   */
  admit(key: string, now: number): boolean {
    const recent = (this.#windows.get(key) ?? []).filter(at => now - at < this.policy.windowMs)
    if (recent.length >= this.policy.maxCallsPerWindow) {
      // A janela podada é gravada de volta mesmo na recusa: sem isto, um escopo
      // que bate no teto nunca mais tem as tentativas velhas removidas e fica
      // barrado depois de a janela já ter passado.
      this.#windows.set(key, recent)
      return false
    }
    this.#windows.set(key, [...recent, now])
    return true
  }

  /**
   * Descarta janelas que já venceram inteiras.
   *
   * O mapa é indexado por escopo autenticado, mas um Studio de vida longa não
   * precisa carregar a janela de quem chamou uma vez no mês passado.
   * @param now - o instante da limpeza, em milissegundos.
   */
  sweep(now: number): void {
    for (const [key, attempts] of this.#windows) {
      if (attempts.every(at => now - at >= this.policy.windowMs)) this.#windows.delete(key)
    }
  }

  /** Quantas janelas estão vivas. Existe para o teste poder provar que a limpeza limpa. */
  get size(): number { return this.#windows.size }
}
