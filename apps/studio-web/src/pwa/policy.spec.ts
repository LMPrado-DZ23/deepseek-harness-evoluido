import { describe, expect, it } from 'vitest'
import { decide, OFFLINE_ERROR_CODE, offlineApiResponseBody, PRECACHE_PATHS, SERVICE_UNREACHABLE_ERROR_CODE, SW_SCOPE } from './policy'

const origin = 'http://127.0.0.1:4179'
const at = (path: string, base = origin) => new URL(path, base)

describe('service worker caching policy', () => {
  it('never caches project data: every /api/ request is network-only with an offline 503 fallback', () => {
    expect(decide('GET', at('/api/studio/apps/projects'), origin)).toBe('api')
    expect(decide('GET', at('/api/studio/identity/session'), origin)).toBe('api')
    expect(JSON.parse(offlineApiResponseBody())).toEqual({ error: OFFLINE_ERROR_CODE, offline: true })
    expect(JSON.parse(offlineApiResponseBody(false))).toEqual({ error: OFFLINE_ERROR_CODE, offline: true })
    // Com rede, a mesma falha significa outra coisa e recebe outro código.
    expect(JSON.parse(offlineApiResponseBody(true))).toEqual({ error: SERVICE_UNREACHABLE_ERROR_CODE, offline: false, serviceUnreachable: true })
  })

  it('caches only the shell: hashed assets, icons, brand and manifest are cache-first; the shell HTML is network-first', () => {
    expect(decide('GET', at('/studio/assets/main-abc123.js'), origin)).toBe('shell-asset')
    expect(decide('GET', at('/studio/icons/icon-192.png'), origin)).toBe('shell-asset')
    expect(decide('GET', at('/studio/brand/dz23-studio-logo.jpg'), origin)).toBe('shell-asset')
    expect(decide('GET', at('/studio/manifest.json'), origin)).toBe('shell-asset')
    expect(decide('GET', at('/studio/'), origin)).toBe('shell-html')
    expect(decide('GET', at('/studio/projects/abc'), origin)).toBe('shell-html')
    expect(decide('GET', at('/studio/index.html'), origin)).toBe('shell-html')
  })

  it('bypasses mutations, other origins, other paths and unknown files under the scope', () => {
    expect(decide('POST', at('/studio/'), origin)).toBe('bypass')
    expect(decide('GET', at('/studio/', 'http://evil.example'), origin)).toBe('bypass')
    expect(decide('GET', at('/healthz'), origin)).toBe('bypass')
    expect(decide('GET', at('/'), origin)).toBe('bypass')
    expect(decide('GET', at('/studio/sw.js'), origin)).toBe('bypass')
    expect(decide('GET', at('/studio/unknown.txt'), origin)).toBe('bypass')
  })

  it('precaches only shell entry points, all inside the scope and none under /api/', () => {
    expect(PRECACHE_PATHS[0]).toBe(SW_SCOPE)
    for (const path of PRECACHE_PATHS) {
      expect(path.startsWith(SW_SCOPE)).toBe(true)
      expect(path.startsWith('/api/')).toBe(false)
    }
  })
})
