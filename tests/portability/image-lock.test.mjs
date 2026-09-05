import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateDockerfileBase, validateImageLock } from '../../scripts/check-image-lock.mjs'

const canonical = JSON.parse(await readFile(new URL('../../deploy/images.lock.json', import.meta.url), 'utf8'))
const dockerfile = await readFile(new URL('../../deploy/studio/Dockerfile', import.meta.url), 'utf8')
const studioLibraries = [
  'agents',
  'hello',
  'identity',
  'integration-hub',
  'policy',
  'preview',
  'preview-supervisor',
  'prompt-to-app',
  'route-health',
  'runtime-governor',
  'storage-postgres',
  'studio-web',
  'tenancy',
]

test('lock de imagens aceita somente a resolução canônica', () => {
  assert.equal(validateImageLock(structuredClone(canonical)).schemaVersion, 1)
})

test('lock de imagens recusa tag, plataforma ausente e campo inesperado', () => {
  const tag = structuredClone(canonical)
  tag.images.node.indexDigest = 'latest'
  assert.throws(() => validateImageLock(tag), /digest do índice Node inválido/u)

  const platform = structuredClone(canonical)
  delete platform.images.node.platforms['linux/arm64']
  assert.throws(() => validateImageLock(platform), /campos divergentes/u)

  const extra = structuredClone(canonical)
  extra.images.node.mutableTag = 'latest'
  assert.throws(() => validateImageLock(extra), /campos divergentes/u)

  const builderPlatform = structuredClone(canonical)
  builderPlatform.images.playwright.platforms['linux/arm64'] = builderPlatform.images.playwright.platforms['linux/amd64']
  assert.throws(() => validateImageLock(builderPlatform), /Playwright inválidos/u)

  const archive = structuredClone(canonical)
  archive.tools.nodeArchives.platforms['linux/arm64'].filename = 'node-v22.23.1-linux-x64.tar.gz'
  assert.throws(() => validateImageLock(archive), /arquivo Node linux\/arm64 inválido/u)

  const postgres = structuredClone(canonical)
  postgres.tools.postgresClient.packages['postgresql-client-16'] = '16.*'
  assert.throws(() => validateImageLock(postgres), /não fixada/u)

  const missingLeaf = dockerfile.replace("test \"$(dpkg-query -W -f='${Version}' postgresql-client-16)\" = '16.15-1.pgdg12+2'", 'true')
  assert.throws(() => validateDockerfileBase(missingLeaf, canonical), /não valida postgresql-client-16/u)

  const postgresBase = structuredClone(canonical)
  postgresBase.images.postgresRuntime.platforms['linux/arm64'] = postgresBase.images.postgresRuntime.platforms['linux/amd64']
  assert.throws(() => validateImageLock(postgresBase), /plataforma PostgreSQL inválidos/u)
})

test('Dockerfile usa exatamente as bases Node e PostgreSQL fixadas no lock', () => {
  assert.equal(validateDockerfileBase(dockerfile, canonical).fromLines.length, 6)
  assert.equal(validateDockerfileBase(dockerfile, canonical).frontend, `${canonical.tools.dockerfileFrontend.reference}@${canonical.tools.dockerfileFrontend.digest}`)
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace(canonical.tools.dockerfileFrontend.digest, `sha256:${'9'.repeat(64)}`), canonical),
    /frontend do Dockerfile não está fixado/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace(canonical.images.node.indexDigest, `sha256:${'0'.repeat(64)}`), canonical),
    /não usa as imagens Node\/PostgreSQL fixadas/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace(canonical.images.postgresRuntime.indexDigest, `sha256:${'1'.repeat(64)}`), canonical),
    /não usa as imagens Node\/PostgreSQL fixadas/u,
  )
  assert.throws(
    () => validateDockerfileBase(`${dockerfile}\nFROM node:latest AS hidden\n`, canonical),
    /base externa não fixada/u,
  )
  assert.throws(
    () => validateDockerfileBase(`${dockerfile}\nFROM ubuntu AS hidden\n`, canonical),
    /base externa não fixada/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('      /workspace/plugins/*/node_modules \\\n', ''), canonical),
    /não reinjeta os pacotes compilados/u,
  )
  const install = "pnpm install --offline --frozen-lockfile --trust-lockfile --filter '@dz23-studio/*...'"
  const finalInstall = dockerfile.lastIndexOf(install)
  assert.notEqual(finalInstall, -1)
  const forced = `${dockerfile.slice(0, finalInstall)}${install} --force${dockerfile.slice(finalInstall + install.length)}`
  assert.throws(() => validateDockerfileBase(forced, canonical), /sem instalação limpa/u)
})

test('build isolado usa declarações compiladas sem enfraquecer o typecheck de desenvolvimento', async () => {
  for (const directory of studioLibraries) {
    const manifest = JSON.parse(await readFile(new URL(`../../plugins/${directory}/package.json`, import.meta.url), 'utf8'))
    assert.equal(manifest.types, './src/index.ts', `${manifest.name}: typecheck local não usa a fonte`)
    for (const [subpath, exported] of Object.entries(manifest.exports)) {
      assert.equal(typeof exported.types, 'string', `${manifest.name}${subpath}: export sem types de desenvolvimento`)
      assert.match(exported.types, /^\.\/src\/.+\.ts$/u, `${manifest.name}${subpath}: typecheck local não usa a fonte`)
      assert.match(exported['dz23-build']?.types ?? '', /^\.\/lib\/.+\.d\.ts$/u, `${manifest.name}${subpath}: build não usa declaração compilada`)
      assert.equal(exported['dz23-build']?.default, exported.default, `${manifest.name}${subpath}: JS do build diverge do runtime`)
    }
    const buildConfig = JSON.parse(await readFile(new URL(`../../plugins/${directory}/tsconfig.build.json`, import.meta.url), 'utf8'))
    assert.equal(buildConfig.extends, '../../tsconfig.package-build.json', `${manifest.name}: build não ativa dz23-build`)
  }
})
