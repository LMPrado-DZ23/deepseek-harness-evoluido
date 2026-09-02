import { describe, expect, it } from 'vitest'
import {
  IDENTITY_RATE_LIMITS,
  InMemoryIdentityRateLimiter,
  rateLimitBuckets,
  rateLimitKey,
} from '../src/rate-limit.ts'

describe('identity application rate limits', () => {
  it('enforces a window and releases the key only after the boundary', () => {
    const limiter = new InMemoryIdentityRateLimiter()
    const { limit, windowMs } = IDENTITY_RATE_LIMITS['magic-start']
    for (let index = 0; index < limit; index += 1) {
      expect(limiter.consume('magic-start', 'client', 1_000)).toMatchObject({
        allowed: true,
        remaining: limit - index - 1,
        retryAfterSeconds: 0,
      })
    }
    expect(limiter.consume('magic-start', 'client', 1_000)).toEqual({
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    })
    expect(limiter.consume('magic-start', 'client', 1_000 + windowMs)).toMatchObject({ allowed: true })
  })

  it('maps every route to its global and specific bucket', () => {
    expect(rateLimitBuckets('/magic/start')).toEqual(['global', 'magic-start'])
    expect(rateLimitBuckets('/magic/verify')).toEqual(['global', 'magic-verify'])
    expect(rateLimitBuckets('/passkey/login/options')).toEqual(['global', 'passkey'])
    expect(rateLimitBuckets('/session')).toEqual(['global'])
  })

  it('keys trusted authenticated calls by session and anonymous calls only by address', () => {
    const request = (cookie?: string, remoteAddress?: string) => ({
      headers: cookie === undefined ? {} : { cookie },
      socket: { remoteAddress },
    }) as never
    const session = rateLimitKey(request('dz23_studio_session=session-a'), '198.51.100.1')
    expect(session).toBe(rateLimitKey(request('dz23_studio_session=session-a'), '203.0.113.1'))
    expect(session).not.toBe(rateLimitKey(request('dz23_studio_session=session-b'), '198.51.100.1'))
    expect(rateLimitKey(request('dz23_studio_session=fake-a'), '198.51.100.1', false))
      .toBe(rateLimitKey(request('dz23_studio_session=fake-b'), '198.51.100.1', false))
    expect(rateLimitKey(request('dz23_studio_session=fake-a'), '198.51.100.1', false))
      .not.toBe(rateLimitKey(request('dz23_studio_session=fake-a'), '203.0.113.1', false))
    expect(rateLimitKey(request(undefined, '127.0.0.1'), '198.51.100.1'))
      .toBe(rateLimitKey(request(undefined, '127.0.0.2'), '198.51.100.1'))
    expect(rateLimitKey(request(undefined, '127.0.0.1')))
      .not.toBe(rateLimitKey(request(undefined, '127.0.0.2')))
    expect(rateLimitKey(request())).toHaveLength(64)
  })
})
