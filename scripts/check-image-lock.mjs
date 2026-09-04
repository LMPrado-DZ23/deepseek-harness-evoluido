#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SHA1 = /^[0-9a-f]{40}$/u
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
  exactKeys(lock.images, ['node'], 'images')
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

  exactKeys(lock.tools, ['pnpm'], 'tools')
  const pnpm = lock.tools.pnpm
  exactKeys(pnpm, ['version', 'tarball', 'integrity', 'sha1'], 'tools.pnpm')
  if (pnpm.version !== '11.7.0') throw new Error('versão pnpm divergente')
  if (pnpm.tarball !== `https://registry.npmjs.org/pnpm/-/pnpm-${pnpm.version}.tgz`) {
    throw new Error('tarball pnpm divergente')
  }
  if (!SHA512_INTEGRITY.test(pnpm.integrity)) throw new Error('integridade pnpm inválida')
  if (!SHA1.test(pnpm.sha1)) throw new Error('sha1 pnpm inválido')
  return lock
}

export async function main(argv = process.argv.slice(2)) {
  const pathIndex = argv.indexOf('--file')
  const lockPath = resolve(pathIndex >= 0 ? argv[pathIndex + 1] : 'deploy/images.lock.json')
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'))
  const lock = validateImageLock(parsed)
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
