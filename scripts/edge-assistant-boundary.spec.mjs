import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const caddy = readFileSync(new URL('../deploy/caddy/DZ23.common.caddy', import.meta.url), 'utf8')
const login = readFileSync(new URL('../deploy/caddy/public/assets/login/app.js', import.meta.url), 'utf8')
const edgePatch = readFileSync(new URL('../deploy/harness/edge.patch.yml', import.meta.url), 'utf8')

describe('server edge keeps the process-wide Harness browser client private', () => {
  it('allowlists only Studio HTTP surfaces and denies every unmatched Harness route', () => {
    const studio = caddy.indexOf('@studio_surface path /studio /studio/* /api/studio/*')
    const deny = caddy.indexOf('respond "not found" 404', studio)
    expect(studio).toBeGreaterThan(0)
    expect(deny).toBeGreaterThan(studio)
    expect(caddy.slice(studio, deny)).toContain('forward_auth')
    expect(caddy.slice(studio, deny)).toContain('reverse_proxy')
  })

  it('lands authenticated people in the Studio instead of minting a Harness process cookie', () => {
    expect(login).toContain("window.location.assign('/studio/')")
    expect(login).not.toContain('/harness/session')
  })

  it('keeps the server profile on the authenticated edge', () => {
    expect(edgePatch).toContain('required: true')
    expect(edgePatch).toContain('assistantRepositories:')
  })
})
