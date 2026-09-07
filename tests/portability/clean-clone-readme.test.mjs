import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
const rootPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))

function documentedCleanCloneCommands(source) {
  const section = /### Primeiro uso em um clone novo[\s\S]*?```sh\r?\n([\s\S]*?)\r?\n```/u.exec(source)
  assert.notEqual(section, null, 'README precisa declarar a sequência de clone novo')
  return section[1]
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
}

test('README fixa a mesma sequência de clone limpo executada pelo CI e pela imagem', () => {
  assert.deepEqual(documentedCleanCloneCommands(readme), [
    'node scripts/bootstrap-upstream.mjs',
    'node scripts/check-upstream-content.mjs',
    'pnpm --dir third_party/deepseek-harness install --frozen-lockfile',
    'pnpm --dir third_party/deepseek-harness build:official',
    "pnpm install --frozen-lockfile --filter '@dz23-studio/*...'",
    'pnpm build',
    'pnpm typecheck',
    'pnpm exec vitest run --maxWorkers=1',
  ])
  assert.doesNotMatch(readme, /pnpm test -- --maxWorkers/u)
})

test('build raiz seleciona os namespaces dos pacotes em vez de um filtro de caminho que vira no-op no Windows', () => {
  assert.equal(
    rootPackage.scripts.build,
    'pnpm --recursive --filter "@dz23-studio/*" --filter "@studio/*" --if-present run build',
  )
  assert.doesNotMatch(rootPackage.scripts.build, /\.\/plugins\/\*\*/u)
})
