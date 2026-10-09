import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GeneratedFileRejectedError, validateGeneratedPath, writeGeneratedFiles } from '../src/generator.js'
import { hashTree } from '../src/runner.js'
import { isValidCpf, scanGeneratedContent } from '../src/security.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'dz23-p32-')); temporary.push(path); return path }

describe('generated file fence', () => {
  it('keeps official lifecycle consumers free of direct builder and subprocess authority', async () => {
    const consumers = [
      'scripts/prove-prompt-to-app.ts',
      'scripts/prove-preview-runtime.ts',
      'scripts/prove-generated-data.ts',
      'scripts/prove-generated-auth-crud.ts',
      'scripts/prove-form-database.ts',
      'scripts/prove-design-spec.ts',
      'scripts/run-golden-set.ts',
      'scripts/prove-template-pipeline.ts',
      'scripts/prove-integration-hub.mjs',
      'plugins/integration-hub/tests/pipeline-export.integration.spec.ts',
      'apps/studio-web/tests/server.ts',
    ]
    const forbidden = [
      ['Container', 'Builder'].join(''),
      ['OFFLINE', 'PIPELINE', 'COMMANDS'].join('_'),
      ['node:', 'child_process'].join(''),
      ['docker', '.sock'].join(''),
    ]
    for (const path of consumers) {
      const source = await readFile(join(process.cwd(), path), 'utf8')
      for (const token of forbidden) expect(source, `${path} conservou autoridade ${token}`).not.toContain(token)
    }
  })

  it('accepts only unique files below src and content', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await mkdir(join(root, 'content'))
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'ok' }, { path: 'content/app.json', content: '{}' }], { plannedPaths: ['src/App.tsx', 'content/app.json'] })).resolves.toEqual(['src/App.tsx', 'content/app.json'])
    expect(await readFile(join(root, 'src/App.tsx'), 'utf8')).toBe('ok')
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'again' }])).rejects.toThrow()
    await expect(writeGeneratedFiles(root, [{ path: 'src/a.ts', content: '' }, { path: 'src/a.ts', content: '' }])).rejects.toBeInstanceOf(GeneratedFileRejectedError)
  })

  it('allows only plan-listed generated changes and never overwrites template files', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/existing.ts'), 'old')
    const file = [{ path: 'src/existing.ts', content: 'new' }]
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/other.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).rejects.toThrow('fora do plano')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'], protectedTemplatePaths: ['src/existing.ts'] })).rejects.toThrow('protegido do template')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).resolves.toEqual(['src/existing.ts'])
  })

  it.each(['/tmp/x', '../x', 'src/../x', 'package.json', 'src//x', 'C:\\x'])('rejects unsafe path %s', value => {
    expect(() => validateGeneratedPath(value)).toThrow(GeneratedFileRejectedError)
  })

  it('hashes immutable trees, rejects linked roots and scans sensitive literals precisely', async () => {
    const root = await temp(); await writeFile(join(root, 'a'), 'one'); const first = await hashTree(root)
    await writeFile(join(root, 'a'), 'two'); expect(await hashTree(root)).not.toBe(first)
    if (process.platform !== 'win32') {
      const holder = await temp(); const linkedRoot = join(holder, 'linked-root'); await symlink(root, linkedRoot, 'dir')
      await expect(hashTree(linkedRoot)).rejects.toThrow('Link simbólico')
    }
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('123')).toBe(false)
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCpf('123.456.789-00')).toBe(false)
    expect(scanGeneratedContent({ 'src/a.ts': 'const key="sk-abcdefghijklmnopqrstuvwxyz"', 'content/a': 'CPF 529.982.247-25' })).toEqual(['src/a.ts:SECRET_PATTERN', 'content/a:PII_PATTERN'])
    expect(scanGeneratedContent({ 'content/a': 'cpf: 52998224725' })).toEqual(['content/a:PII_PATTERN'])
    expect(scanGeneratedContent({ 'src/a.ts': 'Telefone 11987654321' })).toEqual([])
  })
})
