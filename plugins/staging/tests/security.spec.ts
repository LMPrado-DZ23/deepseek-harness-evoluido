import { describe, expect, it, vi } from 'vitest'
import { isStagingAuthorized } from '../src/security.js'

describe('staging authorization boundary', () => {
  it('requires both an auditable session and the exact policy permission', () => {
    const authorization = { allows: vi.fn(() => true) }
    expect(isStagingAuthorized({ role: 'builder', sessionId: 'session-1' }, 'project.publish_staging', authorization)).toBe(true)
    expect(authorization.allows).toHaveBeenCalledWith('builder', 'project.publish_staging')
    expect(isStagingAuthorized({ role: 'builder', sessionId: '   ' }, 'project.publish_staging', authorization)).toBe(false)
    expect(authorization.allows).toHaveBeenCalledTimes(1)

    authorization.allows.mockReturnValue(false)
    expect(isStagingAuthorized({ role: 'viewer', sessionId: 'session-2' }, 'project.publish_staging', authorization)).toBe(false)
  })
})
