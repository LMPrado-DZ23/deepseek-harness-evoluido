import type { IncomingMessage } from 'node:http'
import { authenticatedMutation, type StudioIdentityService } from '@dz23-studio/identity'
import { t } from './i18n.js'

/**
 * Visibilidade das execuções paradas.
 *
 * O que esta rota existe para impedir: quando o Studio não consegue PROVAR que
 * um programa externo morreu, a execução fica em `UNKNOWN` e a reserva dos
 * arquivos NÃO é liberada - de propósito, porque declarar morte sem prova seria
 * mentir. Até aqui isso acontecia em silêncio: os arquivos ficavam reservados e
 * a pessoa não tinha como saber. Agora ela vê.
 */

export const STUCK_RUNS_PATH = '/studio/assistant/stuck-runs'

export type StuckRunsRoute =
  | { readonly kind: 'list' }
  | { readonly kind: 'method-not-allowed' }

/** Roteamento puro. Só existe leitura: encerrar uma execução exige confirmação. */
export function routeStuckRuns(method: string | undefined, pathname: string): StuckRunsRoute | undefined {
  if (pathname !== STUCK_RUNS_PATH) return undefined
  return method === 'GET' ? { kind: 'list' } : { kind: 'method-not-allowed' }
}

/** Recorte do runtime de agentes que esta rota lê. Nada além disto. */
export interface StuckRunsSource {
  runs(): readonly {
    readonly run_id: string
    readonly org_id: string
    readonly tenant_id: string
    readonly workspace_id: string
    readonly status: string
    readonly provider: string
    readonly diagnostic: string | null
    readonly created_at: string
    readonly updated_at: string
  }[]
}

export interface StuckRunsConfig {
  readonly identity: StudioIdentityService
  readonly agents?: StuckRunsSource
}

/** O que o cliente vê. Caminhos absolutos e diff NUNCA atravessam. */
export interface StuckRunView {
  readonly run_id: string
  readonly workspace_id: string
  readonly provider: string
  readonly since: string
}

export class StuckRunsError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED', message: string) {
    super(message)
  }
}

export function stuckRunsStatus(error: unknown): number | undefined {
  return error instanceof StuckRunsError ? 503 : undefined
}

export async function handleStuckRuns(
  request: IncomingMessage,
  route: StuckRunsRoute,
  config: StuckRunsConfig,
): Promise<{ readonly status: number, readonly body: unknown }> {
  if (route.kind === 'method-not-allowed') {
    return { status: 405, body: { error: t('stuckRuns.methodNotAllowed') } }
  }
  // Autentica ANTES de olhar qualquer execução: a lista é escopada por quem
  // está perguntando, e o escopo sai do cookie, nunca do pedido.
  const session = await authenticatedMutation(request, config.identity)
  const agents = config.agents
  if (agents === undefined) {
    throw new StuckRunsError('NOT_CONFIGURED', t('stuckRuns.notConfigured'))
  }
  return { status: 200, body: { runs: stuckRunsFor(agents, session) } }
}

/**
 * As execuções paradas do escopo exato de quem está perguntando.
 * @param agents - runtime de agentes de onde as execuções são lidas.
 * @param scope - organização e inquilino da sessão autenticada.
 * @returns só o que está em `UNKNOWN`, da mais antiga para a mais nova.
 */
export function stuckRunsFor(
  agents: StuckRunsSource,
  scope: { readonly org_id: string, readonly tenant_id: string },
): readonly StuckRunView[] {
  return agents.runs()
    .filter(run => run.status === 'UNKNOWN'
      && run.org_id === scope.org_id
      && run.tenant_id === scope.tenant_id)
    .map(run => ({
      run_id: run.run_id,
      workspace_id: run.workspace_id,
      provider: run.provider,
      since: run.updated_at,
    }))
    .sort((left, right) => Date.parse(left.since) - Date.parse(right.since))
}
