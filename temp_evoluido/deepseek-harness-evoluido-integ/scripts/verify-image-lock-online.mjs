#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateImageLock } from './check-image-lock.mjs'

const MAX_RESPONSE_BYTES = 512 * 1024
const TIMEOUT_MS = 15_000
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ')

async function boundedJson(url, options = {}) {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, { ...options, signal, redirect: 'error' })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`${url}: resposta excede o limite`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`${url}: resposta excede o limite`)
  return { response, value: JSON.parse(new TextDecoder().decode(bytes)) }
}

const lock = validateImageLock(JSON.parse(await readFile('deploy/images.lock.json', 'utf8')))
const tokenResult = await boundedJson(
  'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull',
)
const token = tokenResult.value?.token
if (typeof token !== 'string' || token.length < 100 || token.length > 8192) {
  throw new Error('Docker Registry retornou token inválido')
}

const manifestResult = await boundedJson(
  'https://registry-1.docker.io/v2/library/node/manifests/22.23.1-bookworm-slim',
  { headers: { accept: MANIFEST_ACCEPT, authorization: `Bearer ${token}` } },
)
assert.equal(
  manifestResult.response.headers.get('docker-content-digest'),
  lock.images.node.indexDigest,
  'digest atual do índice Node divergiu do lock',
)
if (!Array.isArray(manifestResult.value?.manifests)) throw new Error('índice Node sem manifests')
for (const [platform, expectedDigest] of Object.entries(lock.images.node.platforms)) {
  const [os, architecture] = platform.split('/')
  const candidate = manifestResult.value.manifests.find(item =>
    item?.platform?.os === os && item?.platform?.architecture === architecture,
  )
  assert.equal(candidate?.digest, expectedDigest, `digest ${platform} divergiu do lock`)
}

const pnpmResult = await boundedJson('https://registry.npmjs.org/pnpm/11.7.0')
assert.equal(pnpmResult.value?.version, lock.tools.pnpm.version, 'versão pnpm divergente')
assert.equal(pnpmResult.value?.dist?.tarball, lock.tools.pnpm.tarball, 'tarball pnpm divergente')
assert.equal(pnpmResult.value?.dist?.integrity, lock.tools.pnpm.integrity, 'integridade pnpm divergente')
assert.equal(pnpmResult.value?.dist?.shasum, lock.tools.pnpm.sha1, 'sha1 pnpm divergente')

process.stdout.write(
  `IMAGE_LOCK_ONLINE=PASS node=${lock.images.node.indexDigest} platforms=2 pnpm=${lock.tools.pnpm.version}\n`,
)
