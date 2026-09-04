import { describe, expect, it } from 'vitest'
import t from '../i18n/hub.pt-BR.json'
import { actionLabel, canEnable, exportable, fill, formatBytes, isHubPath, kindLabel, outcomeLabel, tierLabel, verificationLabel } from './presentation'

describe('hub presentation', () => {
  it('opens the hub only at /studio/hub (with or without slash)', () => {
    expect(isHubPath('/studio/hub')).toBe(true)
    expect(isHubPath('/studio/hub/')).toBe(true)
    expect(isHubPath('/studio/')).toBe(false)
    expect(isHubPath('/studio/hubx')).toBe(false)
    expect(isHubPath('/studio/hub/extra')).toBe(false)
  })
  it('translates every kind, tier, action and outcome the server can send', () => {
    for (const kind of ['smtp', 'mcp', 'skill', 'webhook']) expect(kindLabel(kind)).not.toBe(kind)
    for (const tier of ['T0', 'T1', 'T2', 'T3']) expect(tierLabel(tier)).toMatch(new RegExp(`^${tier} — .+`, 'u'))
    for (const action of ['smtp.configured', 'smtp.tested', 'integration.registered', 'integration.enabled', 'integration.disabled', 'export.created']) expect(actionLabel(action)).not.toBe(action)
    for (const outcome of ['success', 'failure', 'not-executed']) expect(outcomeLabel(outcome)).not.toBe(outcome)
    expect(verificationLabel('verified')).toBe(t.integrations.verified)
    expect(verificationLabel('unverified')).toBe(t.integrations.unverified)
  })
  it('never offers to enable an unsigned integration', () => {
    expect(canEnable({ verification: 'unverified', enabled: false })).toBe(false)
    expect(canEnable({ verification: 'verified', enabled: false })).toBe(true)
    expect(canEnable({ verification: 'verified', enabled: true })).toBe(false)
  })
  it('only verified prototypes are exportable', () => {
    expect(exportable({ state: 'VERIFIED_PROTOTYPE' })).toBe(true)
    for (const state of ['DRAFT', 'GENERATING', 'BUILD_FAILED', 'TESTS_OK']) expect(exportable({ state })).toBe(false)
  })
  it('formats sizes and fills templates without leaking placeholders', () => {
    expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(2048)).toBe('2.0 KB'); expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB'); expect(formatBytes(-1)).toBe('0 B')
    expect(fill('Baixar {file}', { file: 'a.zip' })).toBe('Baixar a.zip')
    expect(fill('{x}', {})).toBe('{x}')
  })
})
