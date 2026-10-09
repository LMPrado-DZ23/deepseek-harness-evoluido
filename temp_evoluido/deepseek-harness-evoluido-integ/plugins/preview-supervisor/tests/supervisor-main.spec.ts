import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  engineOptions: [] as unknown[],
  managerOptions: [] as unknown[],
  readFile: vi.fn<(...args: unknown[]) => Promise<string>>(),
  preflight: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  drain: vi.fn<(signal: AbortSignal) => Promise<{ containers: number; networks: number; volumes: number; sockets: number }>>(),
  listen: vi.fn<(options: unknown) => Promise<{ close(): Promise<void> }>>(),
  close: vi.fn<() => Promise<void>>(),
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: state.readFile,
}))

vi.mock('../src/docker-engine.js', () => ({
  DockerEngine: class DockerEngine {
    constructor(options: unknown) { state.engineOptions.push(options) }
  },
}))

vi.mock('../src/docker-manager.js', () => ({
  DockerPreviewSupervisor: class DockerPreviewSupervisor {
    constructor(options: unknown) { state.managerOptions.push(options) }
    preflight(signal: AbortSignal): Promise<void> { return state.preflight(signal) }
    drain(signal: AbortSignal): Promise<{ containers: number; networks: number; volumes: number; sockets: number }> { return state.drain(signal) }
  },
}))

vi.mock('../src/unix-server.js', () => ({ listenSupervisorUnix: state.listen }))

const envKeys = [
  'DZ23_SUPERVISOR_TOKEN_FILE', 'DZ23_DOCKER_SOCKET', 'DZ23_ARTIFACT_ROOT', 'DZ23_PROXY_SOCKET_ROOT',
  'DZ23_PROXY_SOCKET_VOLUME', 'DZ23_RUNTIME_IMAGE_DIGEST', 'DZ23_PROXY_IMAGE_DIGEST', 'DZ23_INSTANCE_ID',
  'DZ23_SUPERVISOR_SOCKET',
] as const
const originalEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

beforeEach(() => {
  vi.resetModules()
  state.engineOptions.length = 0
  state.managerOptions.length = 0
  state.readFile.mockReset().mockResolvedValue(`${'T'.repeat(43)}\n`)
  state.preflight.mockReset().mockResolvedValue(undefined)
  state.drain.mockReset().mockResolvedValue({ containers: 0, networks: 0, volumes: 0, sockets: 0 })
  state.close.mockReset().mockResolvedValue(undefined)
  state.listen.mockReset().mockResolvedValue({ close: state.close })
  Object.assign(process.env, validEnvironment())
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of envKeys) {
    const value = originalEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('preview supervisor process bootstrap', () => {
  it('pins every dependency, preflights before listen and closes on both process signals', async () => {
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM') handlers.set(event, listener)
      return process
    }) as typeof process.once)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await import('../src/supervisor-main.js')

    expect(state.engineOptions).toEqual([{ socketPath: '/var/run/docker.sock' }])
    expect(state.managerOptions).toHaveLength(1)
    expect(state.managerOptions[0]).toMatchObject({
      artifactRoot: '/var/lib/dz23-studio/generated-runs',
      proxySocketRoot: '/run/dz23-preview-proxies',
      proxySocketMount: { type: 'volume', source: 'dz23-preview-proxy-sockets' },
      runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
      proxyImageDigest: `sha256:${'b'.repeat(64)}`,
      instanceId: 'test-instance',
    })
    expect(state.readFile).toHaveBeenCalledWith('/run/secrets/dz23-preview-supervisor-token', 'utf8')
    expect(state.preflight).toHaveBeenCalledOnce()
    expect(state.drain).toHaveBeenCalledOnce()
    expect(state.listen).toHaveBeenCalledOnce()
    expect(state.preflight.mock.invocationCallOrder[0]).toBeLessThan(state.listen.mock.invocationCallOrder[0]!)
    expect(state.drain.mock.invocationCallOrder[0]).toBeLessThan(state.listen.mock.invocationCallOrder[0]!)
    expect(state.listen).toHaveBeenCalledWith(expect.objectContaining({
      socketPath: '/run/dz23-preview/supervisor.sock',
      bearerToken: 'T'.repeat(43),
    }))
    expect(handlers.has('SIGINT')).toBe(true)
    expect(handlers.has('SIGTERM')).toBe(true)

    const signal = state.preflight.mock.calls[0]![0]
    expect(signal.aborted).toBe(false)
    handlers.get('SIGTERM')!()
    expect(signal.aborted).toBe(true)
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.drain).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it.each([
    ['DZ23_SUPERVISOR_TOKEN_FILE', undefined, 'INVALID_DZ23_SUPERVISOR_TOKEN_FILE'],
    ['DZ23_DOCKER_SOCKET', 'relative.sock', 'INVALID_DZ23_DOCKER_SOCKET'],
    ['DZ23_ARTIFACT_ROOT', '/safe\\escape', 'INVALID_DZ23_ARTIFACT_ROOT'],
    ['DZ23_PROXY_SOCKET_VOLUME', '../volume', 'INVALID_DZ23_PROXY_SOCKET_VOLUME'],
    ['DZ23_RUNTIME_IMAGE_DIGEST', `sha256:${'A'.repeat(64)}`, 'INVALID_DZ23_RUNTIME_IMAGE_DIGEST'],
    ['DZ23_PROXY_IMAGE_DIGEST', 'latest', 'INVALID_DZ23_PROXY_IMAGE_DIGEST'],
    ['DZ23_INSTANCE_ID', 'x', 'INVALID_DZ23_INSTANCE_ID'],
  ] as const)('fails closed for %s=%j before opening the control socket', async (key, value, message) => {
    vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value

    await expect(import('../src/supervisor-main.js')).rejects.toThrow(message)
    expect(state.listen).not.toHaveBeenCalled()
  })

  it('does not listen when the token file or Docker preflight fails', async () => {
    vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once)
    state.readFile.mockRejectedValueOnce(new Error('TOKEN_FILE_UNREADABLE'))
    await expect(import('../src/supervisor-main.js')).rejects.toThrow('TOKEN_FILE_UNREADABLE')
    expect(state.preflight).not.toHaveBeenCalled()
    expect(state.listen).not.toHaveBeenCalled()

    vi.resetModules()
    state.readFile.mockResolvedValueOnce('T'.repeat(43))
    state.preflight.mockRejectedValueOnce(new Error('PINNED_IMAGE_NOT_PRESENT'))
    await expect(import('../src/supervisor-main.js')).rejects.toThrow('PINNED_IMAGE_NOT_PRESENT')
    expect(state.listen).not.toHaveBeenCalled()
  })

  it('aborts work and exits unsuccessfully when listener shutdown rejects', async () => {
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM') handlers.set(event, listener)
      return process
    }) as typeof process.once)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    state.close.mockRejectedValueOnce(new Error('SOCKET_CLOSE_FAILED'))
    await import('../src/supervisor-main.js')

    const signal = state.preflight.mock.calls[0]![0]
    handlers.get('SIGINT')!()

    expect(signal.aborted).toBe(true)
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.drain).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(exit).not.toHaveBeenCalledWith(0)
  })

  it('exits unsuccessfully when shutdown garbage collection is incomplete', async () => {
    const handlers = new Map<string, () => void>()
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM') handlers.set(event, listener)
      return process
    }) as typeof process.once)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    state.drain.mockResolvedValueOnce({ containers: 0, networks: 0, volumes: 0, sockets: 0 })
      .mockRejectedValueOnce(new Error('SUPERVISOR_DRAIN_INCOMPLETE'))
    await import('../src/supervisor-main.js')

    handlers.get('SIGTERM')!()

    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.drain).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })

})

function validEnvironment(): Readonly<Record<(typeof envKeys)[number], string>> {
  return {
    DZ23_SUPERVISOR_TOKEN_FILE: '/run/secrets/dz23-preview-supervisor-token',
    DZ23_DOCKER_SOCKET: '/var/run/docker.sock',
    DZ23_ARTIFACT_ROOT: '/var/lib/dz23-studio/generated-runs',
    DZ23_PROXY_SOCKET_ROOT: '/run/dz23-preview-proxies',
    DZ23_PROXY_SOCKET_VOLUME: 'dz23-preview-proxy-sockets',
    DZ23_RUNTIME_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    DZ23_PROXY_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    DZ23_INSTANCE_ID: 'test-instance',
    DZ23_SUPERVISOR_SOCKET: '/run/dz23-preview/supervisor.sock',
  }
}

describe('DZ23_PROXY_USER: o proxy como o usuário do harness nativo', () => {
  it('sem a variável, a opção não existe e vale o padrão 10001', async () => {
    const { proxyUserOption } = await import('../src/supervisor-main.js')
    expect(proxyUserOption(undefined)).toEqual({})
    expect(proxyUserOption('')).toEqual({})
  })

  it('aceita uid:gid de usuário comum', async () => {
    const { proxyUserOption } = await import('../src/supervisor-main.js')
    expect(proxyUserOption('1000:1000')).toEqual({ proxyUser: '1000:1000' })
  })

  it.each(['0:0', '0:1000', '1000:0', 'root', '1000', '1000:1000:1', ' 1000:1000'])('recusa %s', async valor => {
    const { proxyUserOption } = await import('../src/supervisor-main.js')
    expect(() => proxyUserOption(valor)).toThrow('INVALID_DZ23_PROXY_USER')
  })

  it('o valor chega ao supervisor', async () => {
    process.env.DZ23_PROXY_USER = '1000:1000'
    vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once)
    try {
      await import('../src/supervisor-main.js')
      expect(state.managerOptions[0]).toMatchObject({ proxyUser: '1000:1000' })
    } finally { delete process.env.DZ23_PROXY_USER }
  })
})

describe('DZ23_PROXY_SOCKET_BIND: pasta em vez de volume, na instalação nativa', () => {
  it('sem a variável, continua o volume nomeado', async () => {
    const { proxySocketMountOption } = await import('../src/supervisor-main.js')
    expect(proxySocketMountOption(undefined)).toEqual({ type: 'volume', source: 'dz23-preview-proxy-sockets' })
  })

  it('com a variável, é uma pasta', async () => {
    const { proxySocketMountOption } = await import('../src/supervisor-main.js')
    expect(proxySocketMountOption('/dados/p/.frigg/preview/proxies')).toEqual({ type: 'bind', source: '/dados/p/.frigg/preview/proxies' })
  })

  it.each(['relativo/x', '/a/../b', '/a\\b'])('recusa %s', async valor => {
    const { proxySocketMountOption } = await import('../src/supervisor-main.js')
    expect(() => proxySocketMountOption(valor)).toThrow('INVALID_DZ23_PROXY_SOCKET_BIND')
  })

  it('o valor chega ao supervisor', async () => {
    process.env.DZ23_PROXY_SOCKET_BIND = '/dados/p/proxies'
    vi.spyOn(process, 'once').mockImplementation((() => process) as typeof process.once)
    try {
      await import('../src/supervisor-main.js')
      expect(state.managerOptions[0]).toMatchObject({ proxySocketMount: { type: 'bind', source: '/dados/p/proxies' } })
    } finally { delete process.env.DZ23_PROXY_SOCKET_BIND }
  })
})
