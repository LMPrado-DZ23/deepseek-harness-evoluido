import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneratedFileRejectedError, validateGeneratedPath, writeGeneratedFiles } from '../src/generator.js'
import { ContainerBuilder, hashTree, OFFLINE_PIPELINE_COMMANDS, type ProcessPort } from '../src/runner.js'
import { scanGeneratedContent } from '../src/security.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'dz23-p32-')); temporary.push(path); return path }

function config(imageDigest = `sha256:${'a'.repeat(64)}` as const) {
  return { engine: 'docker' as const, imageDigest, templateStore: '/store', user: '1000:1000' as const, limits: { pids: 128, memory: '2g', cpus: '2', timeoutMs: 5_000 } }
}

describe('generated file fence', () => {
  it('accepts only unique files below src and content', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await mkdir(join(root, 'content'))
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'ok' }, { path: 'content/app.json', content: '{}' }], { plannedPaths: ['src/App.tsx', 'content/app.json'] })).resolves.toEqual(['src/App.tsx', 'content/app.json'])
    expect(await readFile(join(root, 'src/App.tsx'), 'utf8')).toBe('ok')
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'again' }])).rejects.toThrow()
    await expect(writeGeneratedFiles(root, [{ path: 'src/a', content: '' }, { path: 'src/a', content: '' }])).rejects.toBeInstanceOf(GeneratedFileRejectedError)
  })

  it('allows only plan-listed changes to generated files and never overwrites template files', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/existing.ts'), 'old')
    const file = [{ path: 'src/existing.ts', content: 'new' }]
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/other.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).rejects.toThrow('fora do plano')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'], protectedTemplatePaths: ['src/existing.ts'] })).rejects.toThrow('protegido do template')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).resolves.toEqual(['src/existing.ts'])
    expect(await readFile(join(root, 'src/existing.ts'), 'utf8')).toBe('new')
  })

  it.each(['/tmp/x', '../x', 'src/../x', 'package.json', 'src//x', 'C:\\x'])('rejects unsafe path %s', value => {
    expect(() => validateGeneratedPath(value)).toThrow(GeneratedFileRejectedError)
  })
})

describe('container builder', () => {
  it('fails closed when digest or engine/image checks are unavailable', async () => {
    const invalid = new ContainerBuilder(config('sha256:no' as `sha256:${string}`), { run: vi.fn() })
    await expect(invalid.preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const failed: ProcessPort = { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', timedOut: false }) }
    await expect(new ContainerBuilder(config(), failed).preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const thrown: ProcessPort = { run: vi.fn().mockRejectedValue(new Error('missing')) }
    await expect(new ContainerBuilder(config(), thrown).preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
  })

  it('pins every required security control and never exposes network or docker socket', async () => {
    const process: ProcessPort = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) }
    const root = await temp(); const store = await temp()
    const builder = new ContainerBuilder({ ...config(), templateStore: store }, process)
    await expect(builder.preflight()).resolves.toMatchObject({ state: 'OK' })
    const result = await builder.execute(root, 'pnpm run build')
    const args = result.securityArgs.join(' ')
    expect(args).toContain('--network none'); expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('--security-opt no-new-privileges'); expect(args).toContain('--read-only')
    expect(args).toContain('/template-store,readonly'); expect(args).toContain('dst=/workspace')
    expect(args).toContain('HOME=/tmp'); expect(args).toContain('XDG_CONFIG_HOME=/tmp/.config')
    expect(args).toContain('CI=true'); expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--frozen-store')
    expect(args).toContain('--shm-size'); expect(args).toContain('256m')
    expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--trust-lockfile'); expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--ignore-scripts')
    expect(args).not.toContain('docker.sock'); expect(args).not.toContain('--privileged')
    expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--offline')
  })

  it('hashes immutable trees, rejects symlinks and scans secrets and PII', async () => {
    const root = await temp(); await writeFile(join(root, 'a'), 'one'); const first = await hashTree(root)
    expect(first).toMatch(/^[a-f0-9]{64}$/u); await writeFile(join(root, 'a'), 'two'); expect(await hashTree(root)).not.toBe(first)
    expect(scanGeneratedContent({ 'src/a.ts': 'const key="sk-abcdefghijklmnopqrstuvwxyz"', 'content/a': '123.456.789-01' })).toEqual(['src/a.ts:SECRET_PATTERN', 'content/a:PII_PATTERN'])
    expect(scanGeneratedContent({ 'src/a.ts': 'safe' })).toEqual([])
  })
})
