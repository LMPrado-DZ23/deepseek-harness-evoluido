#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const EXPECTED_PLATFORMS = ['linux/amd64', 'linux/arm64']

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: objeto esperado`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join('\0') !== wanted.join('\0')) {
    throw new Error(`${label}: campos divergentes (${actual.join(', ')})`)
  }
}

export function validateImageLock(lock) {
  exactKeys(lock, ['schemaVersion', 'resolvedAt', 'images', 'tools'], 'raiz')
  if (lock.schemaVersion !== 1) throw new Error('schemaVersion não suportada')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(lock.resolvedAt)) {
    throw new Error('resolvedAt precisa ser UTC canônico')
  }
  exactKeys(lock.images, ['node', 'playwright', 'postgresRuntime'], 'images')
  const node = lock.images.node
  exactKeys(node, ['reference', 'indexDigest', 'source', 'platforms'], 'images.node')
  if (node.reference !== 'docker.io/library/node:22.23.1-bookworm-slim') {
    throw new Error('imagem Node inesperada')
  }
  if (!DIGEST.test(node.indexDigest)) throw new Error('digest do índice Node inválido')
  if (!/^https:\/\/github\.com\/nodejs\/docker-node\.git#[0-9a-f]{40}:22\/bookworm-slim$/u.test(node.source)) {
    throw new Error('origem da imagem Node inválida')
  }
  exactKeys(node.platforms, EXPECTED_PLATFORMS, 'images.node.platforms')
  const platformDigests = EXPECTED_PLATFORMS.map(platform => node.platforms[platform])
  if (platformDigests.some(digest => !DIGEST.test(digest))) throw new Error('digest de plataforma inválido')
  if (new Set(platformDigests).size !== platformDigests.length) throw new Error('digests de plataforma duplicados')

  const postgresRuntime = lock.images.postgresRuntime
  exactKeys(postgresRuntime, ['reference', 'indexDigest', 'source', 'platforms'], 'images.postgresRuntime')
  if (postgresRuntime.reference !== 'docker.io/library/postgres:16.15-bookworm') {
    throw new Error('imagem PostgreSQL de runtime inesperada')
  }
  if (!DIGEST.test(postgresRuntime.indexDigest)) throw new Error('digest do índice PostgreSQL inválido')
  if (!/^https:\/\/github\.com\/docker-library\/postgres\.git#[0-9a-f]{40}:16\/bookworm$/u.test(postgresRuntime.source)) {
    throw new Error('origem da imagem PostgreSQL inválida')
  }
  exactKeys(postgresRuntime.platforms, EXPECTED_PLATFORMS, 'images.postgresRuntime.platforms')
  const postgresPlatformDigests = EXPECTED_PLATFORMS.map(platform => postgresRuntime.platforms[platform])
  if (postgresPlatformDigests.some(digest => !DIGEST.test(digest)) || new Set(postgresPlatformDigests).size !== 2) {
    throw new Error('digests de plataforma PostgreSQL inválidos')
  }

  const playwright = lock.images.playwright
  exactKeys(playwright, ['reference', 'indexDigest', 'platforms'], 'images.playwright')
  if (playwright.reference !== 'mcr.microsoft.com/playwright:v1.50.1-noble') throw new Error('imagem Playwright inesperada')
  if (!DIGEST.test(playwright.indexDigest)) throw new Error('digest do índice Playwright inválido')
  exactKeys(playwright.platforms, EXPECTED_PLATFORMS, 'images.playwright.platforms')
  const playwrightDigests = EXPECTED_PLATFORMS.map(platform => playwright.platforms[platform])
  if (playwrightDigests.some(digest => !DIGEST.test(digest)) || new Set(playwrightDigests).size !== 2) {
    throw new Error('digests de plataforma Playwright inválidos')
  }

  exactKeys(lock.tools, ['dockerfileFrontend', 'git', 'nodeArchives', 'pnpm', 'postgresClient'], 'tools')
  const dockerfileFrontend = lock.tools.dockerfileFrontend
  exactKeys(dockerfileFrontend, ['reference', 'digest'], 'tools.dockerfileFrontend')
  if (dockerfileFrontend.reference !== 'docker.io/docker/dockerfile:1.7' || !DIGEST.test(dockerfileFrontend.digest)) {
    throw new Error('frontend do Dockerfile divergente')
  }
  const git = lock.tools.git
  exactKeys(git, ['package', 'version', 'repository'], 'tools.git')
  if (git.package !== 'git' || git.version !== '1:2.39.5-0+deb12u3') throw new Error('pacote Git divergente')
  if (git.repository !== 'http://snapshot.debian.org/archive/debian/20260904T000000Z bookworm') throw new Error('repositório Git divergente')
  const postgres = lock.tools.postgresClient
  exactKeys(postgres, ['sourceImage', 'packages', 'pgDumpVersion', 'pgRestoreVersion'], 'tools.postgresClient')
  const expectedPostgresImage = `${postgresRuntime.reference}@${postgresRuntime.indexDigest}`
  if (postgres.sourceImage !== expectedPostgresImage) throw new Error('origem do cliente PostgreSQL divergente')
  exactKeys(postgres.packages, ['postgresql-client-16', 'postgresql-client-common', 'libpq5'], 'tools.postgresClient.packages')
  for (const [name, version] of Object.entries(postgres.packages)) {
    if (typeof version !== 'string' || version === '' || version.includes('*')) throw new Error(`versão PostgreSQL não fixada: ${name}`)
  }
  if (postgres.pgDumpVersion !== 'pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)' ||
      postgres.pgRestoreVersion !== 'pg_restore (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)') {
    throw new Error('binários PostgreSQL divergentes')
  }
  const nodeArchives = lock.tools.nodeArchives
  exactKeys(nodeArchives, ['version', 'baseUrl', 'platforms'], 'tools.nodeArchives')
  if (nodeArchives.version !== '22.23.1' || nodeArchives.baseUrl !== 'https://nodejs.org/dist/v22.23.1') {
    throw new Error('arquivos Node divergentes')
  }
  exactKeys(nodeArchives.platforms, EXPECTED_PLATFORMS, 'tools.nodeArchives.platforms')
  for (const platform of EXPECTED_PLATFORMS) {
    const archive = nodeArchives.platforms[platform]
    exactKeys(archive, ['filename', 'sha256'], `tools.nodeArchives.platforms.${platform}`)
    const expectedFilename = platform === 'linux/amd64'
      ? 'node-v22.23.1-linux-x64.tar.gz'
      : 'node-v22.23.1-linux-arm64.tar.gz'
    if (archive.filename !== expectedFilename || !SHA256_HEX.test(archive.sha256)) {
      throw new Error(`arquivo Node ${platform} inválido`)
    }
  }
  const pnpm = lock.tools.pnpm
  exactKeys(pnpm, ['version', 'tarball', 'integrity', 'sha1', 'sha256'], 'tools.pnpm')
  if (pnpm.version !== '11.7.0') throw new Error('versão pnpm divergente')
  if (pnpm.tarball !== `https://registry.npmjs.org/pnpm/-/pnpm-${pnpm.version}.tgz`) {
    throw new Error('tarball pnpm divergente')
  }
  if (!SHA512_INTEGRITY.test(pnpm.integrity)) throw new Error('integridade pnpm inválida')
  if (!SHA1.test(pnpm.sha1)) throw new Error('sha1 pnpm inválido')
  if (!SHA256_HEX.test(pnpm.sha256)) throw new Error('sha256 pnpm inválido')
  return lock
}

export function validateDockerfileBase(dockerfile, lock) {
  if (typeof dockerfile !== 'string' || dockerfile.length === 0) throw new Error('Dockerfile do Studio vazio')
  const syntaxLine = dockerfile.split(/\r?\n/u)[0]
  const expectedSyntax = `# syntax=${lock.tools.dockerfileFrontend.reference}@${lock.tools.dockerfileFrontend.digest}`
  if (syntaxLine !== expectedSyntax) throw new Error(`frontend do Dockerfile não está fixado (${expectedSyntax})`)
  const fromLines = dockerfile
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => /^FROM\s+/iu.test(line))
  const expectedNode = `FROM ${lock.images.node.reference}@${lock.images.node.indexDigest} AS git-runtime`
  const expectedPostgres = `FROM ${lock.images.postgresRuntime.reference}@${lock.images.postgresRuntime.indexDigest} AS postgres-runtime`
  if (fromLines[0] !== expectedNode || fromLines[1] !== expectedPostgres) {
    throw new Error(`Dockerfile do Studio não usa as imagens Node/PostgreSQL fixadas (${expectedNode}; ${expectedPostgres})`)
  }
  const declaredStages = new Set()
  let externalCount = 0
  for (const line of fromLines) {
    const match = /^FROM\s+(\S+)(?:\s+AS\s+([A-Za-z][A-Za-z0-9_.-]*))?$/u.exec(line)
    if (match === null) throw new Error('Dockerfile do Studio contém FROM inválido')
    const [, source, alias] = match
    if (!declaredStages.has(source)) {
      externalCount += 1
      if (line !== expectedNode && line !== expectedPostgres) throw new Error('Dockerfile do Studio contém base externa não fixada pelo images.lock')
    }
    if (alias !== undefined) {
      if (declaredStages.has(alias)) throw new Error('Dockerfile do Studio repete nome de estágio')
      declaredStages.add(alias)
    }
  }
  if (externalCount !== 2) {
    throw new Error('Dockerfile do Studio precisa conter exatamente duas bases externas fixadas')
  }
  const postgres = lock.tools.postgresClient
  for (const [name, version] of Object.entries(postgres.packages)) {
    if (!dockerfile.includes(`dpkg-query -W -f='\${Version}' ${name}`)) throw new Error(`Dockerfile não valida ${name} instalado`)
    if (!dockerfile.includes(`= '${version}'`)) throw new Error(`Dockerfile não valida ${name}=${version}`)
  }
  if (!dockerfile.includes(`test "$(pg_dump --version)" = '${postgres.pgDumpVersion}'`) ||
      !dockerfile.includes(`test "$(pg_restore --version)" = '${postgres.pgRestoreVersion}'`)) {
    throw new Error('Dockerfile não valida versões exatas de pg_dump/pg_restore')
  }
  const releaseWorkspaceCopies = [...dockerfile.matchAll(/cp pnpm-workspace\.release\.yaml pnpm-workspace\.yaml/gu)]
  const releaseLockCopies = [...dockerfile.matchAll(/cp pnpm-lock\.release\.yaml pnpm-lock\.yaml/gu)]
  const workspaceRootSubstitutions = [...dockerfile.matchAll(/sed -i 's#__DZ23_ABSOLUTE_FILE_ROOT__#file:\/\/\/workspace#g' pnpm-workspace\.yaml/gu)]
  const releaseFetch = dockerfile.indexOf('pnpm fetch --frozen-lockfile --store-dir /pnpm/store', releaseWorkspaceCopies[0]?.index ?? 0)
  if (releaseWorkspaceCopies.length !== 2 || releaseLockCopies.length !== 2 || workspaceRootSubstitutions.length !== 2
      || releaseFetch < (releaseLockCopies[0]?.index ?? -1)) {
    throw new Error('Dockerfile não busca e instala a topologia de release congelada')
  }
  const studioBuild = dockerfile.indexOf('--network=none pnpm build')
  const injectionReset = dockerfile.indexOf('RUN rm -rf', studioBuild)
  const finalInstall = dockerfile.indexOf("pnpm install --offline --frozen-lockfile --trust-lockfile --filter '@dz23-studio/*...'", injectionReset)
  const deploy = dockerfile.indexOf('pnpm --store-dir /pnpm/store --filter @dz23-studio/runtime deploy', finalInstall)
  const resetBlock = injectionReset < 0 || finalInstall < 0 ? '' : dockerfile.slice(injectionReset, finalInstall)
  const resetTargets = [
    '/workspace/node_modules',
    '/workspace/plugins/*/node_modules',
    '/workspace/apps/*/node_modules',
    '/workspace/dsh-home/profiles/studio/node_modules',
  ]
  if (studioBuild < 0 || injectionReset < studioBuild || finalInstall < injectionReset || deploy < finalInstall
      || resetTargets.some(target => !resetBlock.includes(target))) {
    throw new Error('Dockerfile não reinjeta os pacotes compilados antes do deploy')
  }
  if (dockerfile.slice(finalInstall, deploy).includes('--force')) {
    throw new Error('Dockerfile tenta atualizar cópias injetadas com --force sem instalação limpa')
  }
  const deployCommand = dockerfile.slice(deploy, dockerfile.indexOf('\n', deploy))
  if (!deployCommand.includes('--store-dir /pnpm/store') || !deployCommand.includes('deploy --prod --offline /opt/runtime') || deployCommand.includes('--legacy')) {
    throw new Error('Dockerfile não usa deploy moderno, congelado e offline')
  }
  return { base: `${lock.images.node.reference}@${lock.images.node.indexDigest}`, postgresBase: postgres.sourceImage, frontend: expectedSyntax.slice('# syntax='.length), fromLines }
}

export function validateWorkspaceTopologies(development, release, releaseLock) {
  if (!/(?:^|\n)injectWorkspacePackages:\s+false(?:\n|$)/u.test(development)) {
    throw new Error('workspace de desenvolvimento precisa preservar links canônicos')
  }
  if (!/(?:^|\n)injectWorkspacePackages:\s+true(?:\n|$)/u.test(release)) {
    throw new Error('workspace de release precisa injetar pacotes')
  }
  if (!/(?:^|\n)\s{2}injectWorkspacePackages:\s+true(?:\n|$)/u.test(releaseLock)) {
    throw new Error('lock de release não foi resolvido com injeção de pacotes')
  }
  const localSubprocessResolution = "'@deepseek-ai/dsh-subprocess-local@file:third_party/deepseek-harness/packages/subprocess/subprocess-local"
  if (!releaseLock.includes(localSubprocessResolution) || /'@deepseek-ai\/dsh-subprocess-local@[0-9]/u.test(releaseLock)) {
    throw new Error('permissão de build do subprocesso não está limitada ao pacote local fixado')
  }
  const normalizedDevelopment = development.replace('injectWorkspacePackages: false', 'injectWorkspacePackages: true')
  if (normalizedDevelopment !== release) {
    throw new Error('workspace de release diverge do desenvolvimento além da injeção')
  }
  return true
}

export async function main(argv = process.argv.slice(2)) {
  const pathIndex = argv.indexOf('--file')
  const lockPath = resolve(pathIndex >= 0 ? argv[pathIndex + 1] : 'deploy/images.lock.json')
  const dockerfileIndex = argv.indexOf('--dockerfile')
  const dockerfilePath = resolve(dockerfileIndex >= 0 ? argv[dockerfileIndex + 1] : 'deploy/studio/Dockerfile')
  const developmentWorkspacePath = resolve('pnpm-workspace.yaml')
  const releaseWorkspacePath = resolve('pnpm-workspace.release.yaml')
  const releaseLockPath = resolve('pnpm-lock.release.yaml')
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'))
  const lock = validateImageLock(parsed)
  validateDockerfileBase(await readFile(dockerfilePath, 'utf8'), lock)
  validateWorkspaceTopologies(
    await readFile(developmentWorkspacePath, 'utf8'),
    await readFile(releaseWorkspacePath, 'utf8'),
    await readFile(releaseLockPath, 'utf8'),
  )
  process.stdout.write(
    `IMAGE_LOCK=PASS node=${lock.images.node.indexDigest} platforms=${EXPECTED_PLATFORMS.length} pnpm=${lock.tools.pnpm.version}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`IMAGE_LOCK=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
