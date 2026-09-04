import t from '../i18n/pwa.pt-BR.json'
import { OFFLINE_ERROR_CODE, SERVICE_UNREACHABLE_ERROR_CODE } from './policy'

/**
 * Why a call to `/api/` did not produce an answer.
 *
 * - `OFFLINE`: the device has no network. Nothing left the machine.
 * - `SERVICE_UNREACHABLE`: the device HAS network and the Studio did not
 *   answer (turned off, restarting, behind a broken proxy). Whether the
 *   request arrived is unknown, and the interface must not pretend otherwise.
 * - `UNKNOWN`: any other failure — including a real error the server itself
 *   sent, which already carries its own sentence and must not be overwritten.
 *
 * The two first codes are produced by the service worker (`policy.ts`) and
 * reach the page as the `error` field of a 503 body; `api.ts` turns that field
 * into the message of the thrown `Error`. A page with no worker yet (first
 * load, or a browser without one) gets a bare `TypeError` from `fetch`
 * instead, and then `online` is what separates the two causes.
 */
export type ApiFailureKind = 'OFFLINE' | 'SERVICE_UNREACHABLE' | 'UNKNOWN'

/** `read` = a GET that only shows information. `mutation` = anything that would change something. */
export type ApiCallKind = 'read' | 'mutation'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return typeof cause === 'string' ? cause : ''
}

export function apiFailureKind(cause: unknown, online: boolean): ApiFailureKind {
  const message = messageOf(cause)
  if (message === OFFLINE_ERROR_CODE) return 'OFFLINE'
  if (message === SERVICE_UNREACHABLE_ERROR_CODE) return 'SERVICE_UNREACHABLE'
  // `fetch` rejects with a TypeError when the request never got an answer at all.
  // With a network that is the Studio being unreachable; without one it is the device.
  if (cause instanceof TypeError) return online ? 'SERVICE_UNREACHABLE' : 'OFFLINE'
  return 'UNKNOWN'
}

/**
 * The sentence to show the person, from the catalogue, or `undefined` when the
 * failure is not one of the two network causes — in that case the caller keeps
 * whatever the server said, which is more specific than anything written here.
 *
 * A blocked mutation gets its own sentence (`offline.blockedAction`): it says
 * what was typed is still on the screen and to try again later. It does NOT
 * say the action was queued, because there is no queue and no background sync.
 */
export function apiFailureMessage(cause: unknown, online: boolean, call: ApiCallKind): string | undefined {
  const kind = apiFailureKind(cause, online)
  if (kind === 'SERVICE_UNREACHABLE') return t.offline.serviceUnreachable
  if (kind === 'OFFLINE') return call === 'mutation' ? t.offline.blockedAction : t.offline.banner
  return undefined
}

/** The message above, falling back to whatever the failure itself said. Never empty. */
export function apiFailureText(cause: unknown, online: boolean, call: ApiCallKind, fallback: string): string {
  const known = apiFailureMessage(cause, online, call)
  if (known !== undefined) return known
  const own = messageOf(cause).trim()
  return own === '' ? fallback : own
}
