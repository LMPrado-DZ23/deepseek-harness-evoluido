import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { assertRegularFileWithinRoot, assertTapSuccess } from '../../scripts/windows-contracts-lib.mjs'

const root = resolve(import.meta.dirname, '../..')
const matrix = JSON.parse(readFileSync(resolve(root, 'tests/m6/windows-contract-matrix.json'), 'utf8'))
const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8')

test('cada contrato Windows pertence exatamente a um perfil executável', () => {
  assert.equal(matrix.schema_version, 1)
  assert.deepEqual(Object.keys(matrix.profiles).sort(), ['hosted', 'windows-wsl2'])

  const discovered = readdirSync(resolve(root, 'tests/m6'))
    .filter((name) => /^windows-.*\.test\.mjs$/u.test(name))
    .map((name) => `tests/m6/${name}`)
    .sort()
  const declared = Object.values(matrix.profiles)
    .flatMap((profile) => profile.tests)
    .sort()

  assert.equal(new Set(declared).size, declared.length, 'um teste não pode pertencer a dois perfis')
  assert.deepEqual(declared, discovered, 'todo contrato Windows deve estar declarado na matriz')
  assert.deepEqual(matrix.profiles.hosted.requires, ['windows', 'powershell7'])
  assert.deepEqual(matrix.profiles['windows-wsl2'].requires, ['windows', 'powershell7', 'wsl2', 'ubuntu'])
})

test('CI hospedado usa o executor da matriz e não mantém lista parcial paralela', () => {
  assert.match(workflow, /node scripts\/run-windows-contracts\.mjs --profile hosted/u)
  assert.doesNotMatch(workflow, /tests\/m6\/windows-[\w-]+\.test\.mjs/u)
  assert.equal((workflow.match(/if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/gu) ?? []).length, 2)
})

test('resumo TAP só aceita execução integral sem pulos', () => {
  const complete = '1..3\n# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.deepEqual(assertTapSuccess(complete, 'fixture'), { tests: 3, pass: 3 })
  assert.throws(
    () => assertTapSuccess(complete.replace('# pass 3', '# pass 2').replace('# skipped 0', '# skipped 1'), 'fixture'),
    /não executou integralmente/u,
  )
  assert.throws(
    () => assertTapSuccess(complete.replace('1..3', '1..0').replace('# tests 3', '# tests 0').replace('# pass 3', '# pass 0'), 'fixture'),
    /não executou teste algum/u,
  )
  assert.throws(() => assertTapSuccess('1..1\n# tests 1\n# pass 1\n', 'fixture'), /exatamente um resumo TAP raiz/u)
  const duplicated = `1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n${complete}`
  assert.throws(() => assertTapSuccess(duplicated, 'fixture'), /exatamente um resumo TAP raiz|exatamente um plano TAP raiz/u)
})

test('executor recusa symlink e resolução física fora da raiz', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'dz23-windows-contract-path-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const repository = join(scratch, 'repository')
  const outside = join(scratch, 'outside')
  mkdirSync(repository)
  mkdirSync(outside)
  writeFileSync(join(repository, 'regular.test.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(outside, 'external.test.mjs'), 'throw new Error("external")\n', 'utf8')

  assert.equal(assertRegularFileWithinRoot(repository, 'regular.test.mjs'), join(repository, 'regular.test.mjs'))

  const linkedDirectory = join(repository, 'linked')
  symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(
    () => assertRegularFileWithinRoot(repository, 'linked/external.test.mjs'),
    /resolve fora do repositório/u,
  )
  assert.throws(() => assertRegularFileWithinRoot(repository, '../outside/external.test.mjs'), /fora do repositório/u)
})
