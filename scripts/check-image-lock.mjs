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
  exactKeys(lock.images, ['node', 'playwright'], 'images')
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

  const playwright = lock.images.playwright
  exactKeys(playwright, ['reference', 'indexDigest', 'platforms'], 'images.playwright')
  if (playwright.reference !== 'mcr.microsoft.com/playwright:v1.50.1-noble') throw new Error('imagem Playwright inesperada')
  if (!DIGEST.test(playwright.indexDigest)) throw new Error('digest do índice Playwright inválido')
  exactKeys(playwright.platforms, EXPECTED_PLATFORMS, 'images.playwright.platforms')
  const playwrightDigests = EXPECTED_PLATFORMS.map(platform => playwright.platforms[platform])
  if (playwrightDigests.some(digest => !DIGEST.test(digest)) || new Set(playwrightDigests).size !== 2) {
    throw new Error('digests de plataforma Playwright inválidos')
  }

  exactKeys(lock.tools, ['git', 'nodeArchives', 'pnpm'], 'tools')
  const git = lock.tools.git
  exactKeys(git, ['package', 'version', 'repository'], 'tools.git')
  if (git.package !== 'git' || git.version !== '1:2.39.5-0+deb12u3') throw new Error('pacote Git divergente')
  if (git.repository !== 'http://deb.debian.org/debian bookworm') throw new Error('repositório Git divergente')
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
  const fromLines = dockerfile
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => /^FROM\s+/iu.test(line))
  const expected = `FROM ${lock.images.node.reference}@${lock.images.node.indexDigest} AS git-runtime`
  if (fromLines[0] !== expected) {
    throw new Error(`Dockerfile do Studio não usa a imagem Node fixada (${expected})`)
  }
  const external = fromLines.filter(line => !/^FROM\s+[A-Za-z][A-Za-z0-9_.-]*\s+AS\s+/u.test(line))
  if (external.length !== 1 || external[0] !== expected) {
    throw new Error('Dockerfile do Studio contém base externa não fixada pelo images.lock')
  }
  return { base: `${lock.images.node.reference}@${lock.images.node.indexDigest}`, fromLines }
}

export async function main(argv = process.argv.slice(2)) {
  const pathIndex = argv.indexOf('--file')
  const lockPath = resolve(pathIndex >= 0 ? argv[pathIndex + 1] : 'deploy/images.lock.json')
  const dockerfileIndex = argv.indexOf('--dockerfile')
  const dockerfilePath = resolve(dockerfileIndex >= 0 ? argv[dockerfileIndex + 1] : 'deploy/studio/Dockerfile')
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'))
  const lock = validateImageLock(parsed)
  validateDockerfileBase(await readFile(dockerfilePath, 'utf8'), lock)
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
