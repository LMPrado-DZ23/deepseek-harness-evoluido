import { apiFailureText } from './apiFailure'

/**
 * Starting a generation, kept out of the screen component so the one rule that
 * matters can be tested on its own:
 *
 *   the project only becomes GENERATING after the server accepted the run
 *   with 202 and gave back a `run_id`. Anything else — no network, the Studio
 *   not answering, a refusal, a 202 with no run — leaves the project exactly
 *   where it was, PLAN_APPROVED, and says why.
 *
 * Before this, the interface moved to GENERATING before the POST was even
 * sent: offline, it said it was creating an application when no run existed
 * anywhere. That is the kind of sentence this product must never show.
 */
export const GENERATION_ACCEPTED_STATUS = 202

/** What the state goes back to when the run was NOT accepted. Vocabulary of the project state machine. */
export const GENERATION_REJECTED_STATE = 'PLAN_APPROVED'
export const GENERATION_ACCEPTED_STATE = 'GENERATING'

export interface GenerationHttpResult { status: number; body: unknown }

export type StartGenerationOutcome =
  | { state: typeof GENERATION_ACCEPTED_STATE; runId: string; message: null }
  | { state: typeof GENERATION_REJECTED_STATE; runId: null; message: string }

function runIdIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as { run_id?: unknown }).run_id
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function errorIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as { error?: unknown }).error
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Never throws: every path returns a state the interface can show truthfully.
 * `fallback` is the sentence used when the failure carries none of its own.
 */
export async function startGeneration(
  post: () => Promise<GenerationHttpResult>,
  online: () => boolean,
  fallback: string,
): Promise<StartGenerationOutcome> {
  let result: GenerationHttpResult
  try {
    result = await post()
  } catch (cause) {
    return { state: GENERATION_REJECTED_STATE, runId: null, message: apiFailureText(cause, online(), 'mutation', fallback) }
  }
  if (result.status !== GENERATION_ACCEPTED_STATUS) {
    const code = errorIn(result.body)
    return { state: GENERATION_REJECTED_STATE, runId: null, message: apiFailureText(code ?? '', online(), 'mutation', fallback) }
  }
  const runId = runIdIn(result.body)
  // Accepted with no run to follow: there is nothing to show progress for, so the honest
  // answer is the same as a refusal — the state does not move.
  if (runId === null) return { state: GENERATION_REJECTED_STATE, runId: null, message: fallback }
  return { state: GENERATION_ACCEPTED_STATE, runId, message: null }
}

/**
 * The POST itself. The injected request is the shared authenticated API
 * transport, which preserves the HTTP status while keeping session, tenant,
 * role and CSRF authority outside this presentation helper.
 */
export async function postGeneration(
  projectId: string,
  request: (path: string, init: RequestInit) => Promise<GenerationHttpResult>,
): Promise<GenerationHttpResult> {
  return request(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })
}
