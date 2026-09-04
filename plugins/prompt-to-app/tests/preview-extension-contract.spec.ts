import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CSRF_COOKIE,
  IdentityError,
  SESSION_COOKIE,
  type SessionRecord,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { previewRecordSchema, type PreviewAdmission, type PreviewRecord } from '../../preview/src/model.js'
import { createPreviewProjectHttpExtension } from '../../preview/src/http.js'
import {
  StudioPreviewService,
  type PreviewRepository,
  type PreviewRuntimePort,
  type PreviewSessionPort,
  type PreviewSourcePort,
} from '../../preview/src/service.js'
import {
  createPromptToAppHttpHandler,
  registerPromptToAppHttpExtension,
  type PromptToAppHttpConfig,
  type PromptToAppHttpExtension,
} from '../src/http.js'

const openServers: Server[] = []
const unregisterExtensions: Array<() => void> = []

afterEach(async () => {
  for (const unregister of unregisterExtensions.splice(0)) unregister()
  await Promise.all(openServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

class MemoryPreviewRepository implements PreviewRepository {
  readonly previewRows: PreviewRecord[] = []
  readonly admissionRows: PreviewAdmission[] = []

  previews = (): readonly PreviewRecord[] => this.previewRows
  admissions = (): readonly PreviewAdmission[] => this.admissionRows
  putPreview = async (record: PreviewRecord): Promise<void> => { upsert(this.previewRows, record, 'preview_id') }
  putAdmission = async (record: PreviewAdmission): Promise<void> => { upsert(this.admissionRows, record, 'admission_id') }
}

function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): void {
  const index = rows.findIndex(row => row[key] === value[key])
  if (index === -1) rows.push(value)
  else rows[index] = value
}

const session = {
  session_id: 'session-1', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
} as SessionRecord

const readyPreview = previewRecordSchema.parse({
  preview_id: 'preview-1', org_id: 'org-1', tenant_id: 'tenant-1', project_id: 'project-1', run_id: 'run-1',
  artifact_sha256: 'a'.repeat(64), created_by: 'user-1', source_session_id: 'session-1',
  hostname: 'p-0123456789abcdef01234567.localhost', state: 'READY',
  created_at: '2026-09-03T11:30:00.000Z', ready_at: '2026-09-03T11:30:01.000Z',
  expires_at: '2026-09-03T12:30:00.000Z', stopped_at: null, stop_reason: null, failure_code: null,
  runtime_ref: 'runtime:preview-1', health: 'OK',
})

function realPreviewService(): { service: StudioPreviewService; runtime: PreviewRuntimePort } {
  const repository = new MemoryPreviewRepository()
  repository.previewRows.push(readyPreview)
  const source: PreviewSourcePort = {
    verifiedArtifact: vi.fn(() => Promise.reject(new Error('not used by heartbeat'))),
  }
  const runtime: PreviewRuntimePort = {
    start: vi.fn(() => Promise.reject(new Error('not used by heartbeat'))),
    stop: vi.fn(() => Promise.resolve()),
    health: vi.fn(() => Promise.resolve('OK' as const)),
    logs: vi.fn(() => Promise.resolve([])),
    verificationMessages: vi.fn(() => Promise.resolve([])),
    listManaged: vi.fn(() => Promise.resolve([])),
  }
  const sessions: PreviewSessionPort = {
    isActive: vi.fn(() => true),
    canRead: vi.fn(() => true),
  }
  return {
    runtime,
    service: new StudioPreviewService({
      repository, source, runtime, sessions,
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    }),
  }
}

interface HttpFixture {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly identity: { authenticate: ReturnType<typeof vi.fn>; validateCsrf: ReturnType<typeof vi.fn> }
  readonly tenancy: { authorizationFor: ReturnType<typeof vi.fn> }
}

async function httpFixture(extension: PromptToAppHttpExtension): Promise<HttpFixture> {
  unregisterExtensions.push(registerPromptToAppHttpExtension(extension))
  const identity = {
    authenticate: vi.fn(() => Promise.resolve(session)),
    validateCsrf: vi.fn((_session: SessionRecord, cookie: string | undefined, header: string | undefined) => {
      if (cookie !== 'csrf-token' || header !== 'csrf-token') throw new IdentityError('csrf', 'CSRF inválido.')
    }),
  }
  const tenancy = {
    authorizationFor: vi.fn(() => ({
      userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'builder' as const,
    })),
  }
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const config = {
    service: undefined,
    identity: identity as unknown as StudioIdentityService,
    tenancy: tenancy as unknown as StudioTenancyService,
    intake: undefined,
    planner: undefined,
    jobs: undefined,
    logos: undefined,
    generatorFor: vi.fn(),
    health: vi.fn(),
    allowedHosts,
    allowedOrigins,
  } as unknown as PromptToAppHttpConfig
  const server = createServer(createPromptToAppHttpHandler(config))
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  allowedHosts.push(host)
  allowedOrigins.push(origin)
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/apps${path}`, {
    ...init,
    headers: {
      host,
      origin,
      cookie: `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=csrf-token`,
      'x-dz23-csrf': 'csrf-token',
      ...(init.headers ?? {}),
    },
  })
  return { request, identity, tenancy }
}

const PREVIEW_SUFFIX_CONTRACT = [
  { method: 'GET', suffix: '/previews' },
  { method: 'POST', suffix: '/previews' },
  { method: 'GET', suffix: '/previews/preview-1' },
  { method: 'DELETE', suffix: '/previews/preview-1' },
  { method: 'GET', suffix: '/previews/preview-1/logs' },
  { method: 'GET', suffix: '/previews/preview-1/messages' },
  { method: 'POST', suffix: '/previews/preview-1/heartbeat' },
] as const

describe('prompt-to-app preview extension dispatcher contract', () => {
  it.each(PREVIEW_SUFFIX_CONTRACT)('forwards $method $suffix without drifting from the extension contract', async ({ method, suffix }) => {
    const received = vi.fn()
    const f = await httpFixture(async input => {
      received(input.suffix)
      input.response.writeHead(204)
      input.response.end()
      return true
    })

    const response = await f.request(`/projects/project-1${suffix}`, { method })

    expect(response.status).toBe(204)
    expect(received).toHaveBeenCalledWith(suffix)
  })

  it('renews a preview through the real dispatcher, extension and preview service', async () => {
    const preview = realPreviewService()
    const f = await httpFixture(createPreviewProjectHttpExtension(preview.service))

    const response = await f.request('/projects/project-1/previews/preview-1/heartbeat', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ preview: { preview_id: 'preview-1', state: 'READY', health: 'OK' } })
    expect(preview.runtime.health).toHaveBeenCalledWith('runtime:preview-1', expect.any(AbortSignal))
  })

  it('enforces project.write for heartbeat through the real preview service', async () => {
    const preview = realPreviewService()
    const f = await httpFixture(createPreviewProjectHttpExtension(preview.service))
    f.tenancy.authorizationFor.mockReturnValue({
      userId: 'viewer-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'viewer',
    })

    const response = await f.request('/projects/project-1/previews/preview-1/heartbeat', { method: 'POST' })

    expect(response.status).toBe(403)
    expect(preview.runtime.health).not.toHaveBeenCalled()
  })

  it('rejects heartbeat with invalid CSRF before invoking the preview service', async () => {
    const preview = realPreviewService()
    const f = await httpFixture(createPreviewProjectHttpExtension(preview.service))

    const response = await f.request('/projects/project-1/previews/preview-1/heartbeat', {
      method: 'POST', headers: { 'x-dz23-csrf': 'wrong-token' },
    })

    expect(response.status).toBe(401)
    expect(f.identity.validateCsrf).toHaveBeenCalledOnce()
    expect(preview.runtime.health).not.toHaveBeenCalled()
  })
})
