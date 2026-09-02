import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { parseCookies, SESSION_COOKIE } from './cookies.js'

export type IdentityRateLimitBucket = 'global' | 'magic-start' | 'magic-verify' | 'passkey'

export interface IdentityRateLimitRule {
  readonly limit: number
  readonly windowMs: number
}

export interface IdentityRateLimitDecision {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly retryAfterSeconds: number
}

export const IDENTITY_RATE_LIMITS: Readonly<Record<IdentityRateLimitBucket, IdentityRateLimitRule>> = {
  global: { limit: 300, windowMs: 60_000 },
  'magic-start': { limit: 5, windowMs: 15 * 60_000 },
  'magic-verify': { limit: 10, windowMs: 60_000 },
  passkey: { limit: 20, windowMs: 60_000 },
}

/** Per-process limiter. A multi-instance deployment must replace this with a shared atomic store. */
export class InMemoryIdentityRateLimiter {
  readonly #attempts = new Map<string, number[]>()

  consume(bucket: IdentityRateLimitBucket, key: string, now = Date.now()): IdentityRateLimitDecision {
    const rule = IDENTITY_RATE_LIMITS[bucket]
    const recordKey = `${bucket}:${key}`
    const cutoff = now - rule.windowMs
    const recent = (this.#attempts.get(recordKey) ?? []).filter(timestamp => timestamp > cutoff)
    if (recent.length >= rule.limit) {
      this.#attempts.set(recordKey, recent)
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + rule.windowMs - now) / 1000)),
      }
    }
    recent.push(now)
    this.#attempts.set(recordKey, recent)
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - recent.length,
      retryAfterSeconds: 0,
    }
  }
}

export function rateLimitBuckets(route: string): readonly IdentityRateLimitBucket[] {
  if (route === '/magic/start') return ['global', 'magic-start']
  if (route === '/magic/verify') return ['global', 'magic-verify']
  if (route.startsWith('/passkey/')) return ['global', 'passkey']
  return ['global']
}

/** Stable pseudonymous key: authenticated session when present, otherwise trusted client address. */
export function rateLimitKey(
  request: IncomingMessage,
  forwardedAddress?: string,
  allowSession = true,
): string {
  const session = allowSession ? parseCookies(request.headers.cookie)[SESSION_COOKIE] : undefined
  if (session !== undefined && session !== '') return digest(`session:${session}`)
  return digest(`address:${forwardedAddress === undefined || forwardedAddress === ''
    ? request.socket.remoteAddress ?? 'unknown'
    : forwardedAddress}`)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
