import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateDockerfileBase, validateImageLock, validateWorkspaceTopologies } from '../../scripts/check-image-lock.mjs'

const canonical = JSON.parse(await readFile(new URL('../../deploy/images.lock.json', import.meta.url), 'utf8'))
const dockerfile = await readFile(new URL('../../deploy/studio/Dockerfile', import.meta.url), 'utf8')
const workspaceConfig = await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8')
const releaseWorkspaceConfig = await readFile(new URL('../../pnpm-workspace.release.yaml', import.meta.url), 'utf8')
const releaseLock = await readFile(new URL('../../pnpm-lock.release.yaml', import.meta.url), 'utf8')
const runtimeManifest = JSON.parse(await readFile(new URL('../../apps/studio-runtime/package.json', import.meta.url), 'utf8'))
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
    /não prova a topologia de desenvolvimento/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('RUN --network=none pnpm typecheck', 'RUN true'), canonical),
    /sequência única/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('RUN --network=none pnpm exec vitest run --maxWorkers=1', 'RUN true'), canonical),
    /sequência única/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('--network=none pnpm build', 'echo --network=none pnpm build'), canonical),
    /sequência única/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('--network=none pnpm build', '--network=none pnpm build || true'), canonical),
    /sequência única/u,
  )
  const releaseActivation = dockerfile.lastIndexOf('RUN cp pnpm-workspace.release.yaml pnpm-workspace.yaml')
  const tests = dockerfile.indexOf('RUN --network=none pnpm exec vitest run --maxWorkers=1')
  const releaseActivationEnd = dockerfile.indexOf('\nRUN', releaseActivation) + 1
  const releaseActivationBlock = dockerfile.slice(releaseActivation, releaseActivationEnd)
  const withoutReleaseActivation = `${dockerfile.slice(0, releaseActivation)}${dockerfile.slice(releaseActivationEnd)}`
  const activatedTooEarly = `${withoutReleaseActivation.slice(0, tests)}${releaseActivationBlock}${withoutReleaseActivation.slice(tests)}`
  assert.throws(
    () => validateDockerfileBase(activatedTooEarly, canonical),
    /não prova a topologia de desenvolvimento/u,
  )
  const commentBypass = dockerfile
    .replace('RUN --network=none pnpm typecheck', '# RUN --network=none pnpm typecheck\nRUN true')
    .replace('RUN --network=none pnpm exec vitest run --maxWorkers=1', '# RUN --network=none pnpm exec vitest run --maxWorkers=1\nRUN true')
  assert.throws(
    () => validateDockerfileBase(commentBypass, canonical),
    /sequência única/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('FROM toolchain AS build', 'FROM dependency-fetch AS build'), canonical),
    /partir diretamente de toolchain/u,
  )
  const install = "pnpm install --offline --frozen-lockfile --trust-lockfile --filter '@dz23-studio/*...' --store-dir /pnpm/store"
  const finalInstall = dockerfile.lastIndexOf(install)
  assert.notEqual(finalInstall, -1)
  const forced = `${dockerfile.slice(0, finalInstall)}${install} --force${dockerfile.slice(finalInstall + install.length)}`
  assert.throws(() => validateDockerfileBase(forced, canonical), /sem instalação limpa/u)
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace('deploy --prod --offline /opt/runtime', 'deploy --legacy --prod /opt/runtime'), canonical),
    /não usa deploy moderno, congelado e offline/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace("sed -i 's#__DZ23_ABSOLUTE_FILE_ROOT__#file:///workspace#g' pnpm-workspace.yaml", 'true'), canonical),
    /não busca e instala a topologia de release congelada/u,
  )
})

test('workspace preserva identidade única de tipos e injeta somente entradas do runtime', () => {
  assert.equal(validateWorkspaceTopologies(workspaceConfig, releaseWorkspaceConfig, releaseLock), true)
  assert.throws(
    () => validateWorkspaceTopologies(workspaceConfig, releaseWorkspaceConfig.replace('true', 'false'), releaseLock),
    /workspace de release precisa injetar/u,
  )
  assert.throws(
    () => validateWorkspaceTopologies(workspaceConfig, `${releaseWorkspaceConfig}\nfoo: bar\n`, releaseLock),
    /diverge do desenvolvimento/u,
  )
  assert.throws(
    () => validateWorkspaceTopologies(workspaceConfig, releaseWorkspaceConfig, releaseLock.replace('injectWorkspacePackages: true', 'injectWorkspacePackages: false')),
    /lock de release não foi resolvido/u,
  )
  assert.throws(
    () => validateWorkspaceTopologies(workspaceConfig, releaseWorkspaceConfig, `${releaseLock}\n  '@deepseek-ai/dsh-subprocess-local@9.9.9': {}`),
    /permissão de build do subprocesso não está limitada/u,
  )
  assert.deepEqual(Object.keys(runtimeManifest.dependenciesMeta).sort(), [
    '@deepseek-ai/dsh',
    '@dz23-studio/storage-postgres',
    'dsh-profile-studio',
  ])
  for (const metadata of Object.values(runtimeManifest.dependenciesMeta)) {
    assert.deepEqual(metadata, { injected: true })
  }
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
