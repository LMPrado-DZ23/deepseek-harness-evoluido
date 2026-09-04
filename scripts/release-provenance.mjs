#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA40 = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const EXPECTED_PLATFORMS = [
  { architecture: 'amd64', id: 'linux/amd64' },
  { architecture: 'arm64', id: 'linux/arm64' },
]
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const FIXED_INPUTS = Object.freeze({
  dockerfile: 'deploy/studio/Dockerfile',
  imagesLock: 'deploy/images.lock.json',
  integrityManifest: 'integrity/deepseek-harness-tree.json',
  packageLock: 'pnpm-lock.yaml',
  upstreamLock: 'UPSTREAM.lock',
})

function fail(message) {
  throw new Error(message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}: objeto esperado`)
  }
  return value
}

function exactKeys(value, expected, label) {
  object(value, label)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join('\0') !== wanted.join('\0')) {
    fail(`${label}: campos divergentes (${actual.join(', ')})`)
  }
}

function nonEmptyString(value, label, maximum = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    fail(`${label}: texto inválido`)
  }
  return value
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

async function readRegularFile(filePath, label) {
  const absolute = resolve(filePath)
  const stat = await lstat(absolute).catch(() => undefined)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`${label}: arquivo regular ausente`)
  if (stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) fail(`${label}: tamanho fora do limite`)
  const bytes = await readFile(absolute)
  if (bytes.length !== stat.size) fail(`${label}: arquivo mudou durante a leitura`)
  return { absolute, bytes, digest: sha256(bytes) }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(`${label}: JSON inválido`)
  }
}

function parseUpstreamLock(bytes) {
  const entries = new Map()
  for (const line of bytes.toString('utf8').split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail('UPSTREAM.lock: linha inválida')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (entries.has(key)) fail(`UPSTREAM.lock: chave duplicada ${key}`)
    entries.set(key, value)
  }
  const expected = ['repository', 'path', 'commit', 'tree', 'manifest_sha256']
  if ([...entries.keys()].sort().join('\0') !== expected.sort().join('\0')) {
    fail('UPSTREAM.lock: campos divergentes')
  }
  const repository = entries.get('repository')
  const path = entries.get('path')
  const commit = entries.get('commit')
  const tree = entries.get('tree')
  const manifestSha256 = entries.get('manifest_sha256')
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(repository)) {
    fail('UPSTREAM.lock: repositório inválido')
  }
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(path)) fail('UPSTREAM.lock: caminho inválido')
  if (!SHA40.test(commit) || !SHA40.test(tree)) fail('UPSTREAM.lock: commit ou tree inválido')
  if (!/^[0-9a-f]{64}$/u.test(manifestSha256)) fail('UPSTREAM.lock: manifesto inválido')
  return { commit, manifestSha256, path, repository, tree }
}

function validateMetadata(metadata) {
  exactKeys(metadata, ['schemaVersion', 'studioCommit', 'image'], 'metadata')
  if (metadata.schemaVersion !== 1) fail('metadata: schemaVersion não suportada')
  if (!SHA40.test(metadata.studioCommit)) fail('metadata: studioCommit inválido')
  exactKeys(metadata.image, ['name', 'indexDigest', 'platforms'], 'metadata.image')
  const name = nonEmptyString(metadata.image.name, 'metadata.image.name', 255)
  if (/\s|@/u.test(name)) fail('metadata.image.name: referência inválida')
  if (!SHA256.test(metadata.image.indexDigest)) fail('metadata.image.indexDigest inválido')
  exactKeys(metadata.image.platforms, EXPECTED_PLATFORMS.map(item => item.id), 'metadata.image.platforms')
  const digests = EXPECTED_PLATFORMS.map(item => metadata.image.platforms[item.id])
  if (digests.some(digest => !SHA256.test(digest))) fail('metadata.image.platforms: digest inválido')
  if (new Set(digests).size !== digests.length || digests.includes(metadata.image.indexDigest)) {
    fail('metadata.image: digests precisam ser distintos')
  }
  return metadata
}

function validateOciDescriptor(input, expectedIndexDigest) {
  const wrapper = object(input, 'descritor OCI')
  const descriptor = wrapper['containerimage.descriptor'] ?? wrapper.descriptor ?? wrapper
  object(descriptor, 'descritor OCI')
  const digestFromWrapper = wrapper['containerimage.digest']
  if (digestFromWrapper !== undefined && digestFromWrapper !== expectedIndexDigest) {
    fail('descritor OCI: containerimage.digest diverge dos metadados')
  }
  if (![
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ].includes(descriptor.mediaType)) {
    fail('descritor OCI: índice multi-arquitetura esperado')
  }
  if (descriptor.digest !== expectedIndexDigest || !SHA256.test(descriptor.digest)) {
    fail('descritor OCI: digest diverge dos metadados')
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) fail('descritor OCI: size inválido')
  return { digest: descriptor.digest, mediaType: descriptor.mediaType, size: descriptor.size }
}

function validateSpdx(input, platform) {
  const spdx = object(input, `SBOM ${platform}`)
  if (!['SPDX-2.2', 'SPDX-2.3'].includes(spdx.spdxVersion)) fail(`SBOM ${platform}: versão SPDX inválida`)
  if (spdx.dataLicense !== 'CC0-1.0' || spdx.SPDXID !== 'SPDXRef-DOCUMENT') {
    fail(`SBOM ${platform}: cabeçalho SPDX inválido`)
  }
  const name = nonEmptyString(spdx.name, `SBOM ${platform}.name`, 512)
  const namespace = nonEmptyString(spdx.documentNamespace, `SBOM ${platform}.documentNamespace`, 2048)
  if (!/^(?:https:\/\/|urn:uuid:)[^\s]+$/u.test(namespace)) fail(`SBOM ${platform}: namespace inválido`)
  const creationInfo = object(spdx.creationInfo, `SBOM ${platform}.creationInfo`)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(creationInfo.created)) {
    fail(`SBOM ${platform}: creationInfo.created precisa ser UTC canônico`)
  }
  if (!Array.isArray(creationInfo.creators) || creationInfo.creators.length === 0
    || creationInfo.creators.some(creator => typeof creator !== 'string' || creator.length === 0)) {
    fail(`SBOM ${platform}: creators inválido`)
  }
  return {
    documentNamespace: namespace,
    fileCount: Array.isArray(spdx.files) ? spdx.files.length : 0,
    name,
    packageCount: Array.isArray(spdx.packages) ? spdx.packages.length : 0,
    relationshipCount: Array.isArray(spdx.relationships) ? spdx.relationships.length : 0,
    spdxVersion: spdx.spdxVersion,
  }
}

function validateIntegrityManifest(manifest, upstream) {
  object(manifest, 'manifesto de integridade')
  if (manifest.schemaVersion !== 1 || manifest.repository !== upstream.repository
    || manifest.commit !== upstream.commit || manifest.tree !== upstream.tree
    || manifest.manifestSha256 !== upstream.manifestSha256
    || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail('manifesto de integridade: não corresponde ao UPSTREAM.lock')
  }
  return manifest.entries.length
}

function validateImagesLock(lock) {
  object(lock, 'images.lock')
  const node = object(object(lock.images, 'images.lock.images').node, 'images.lock.images.node')
  if (!SHA256.test(node.indexDigest)) fail('images.lock: digest do índice Node inválido')
  const platforms = object(node.platforms, 'images.lock.images.node.platforms')
  for (const expected of EXPECTED_PLATFORMS) {
    if (!SHA256.test(platforms[expected.id])) fail(`images.lock: digest Node ${expected.id} inválido`)
  }
  return {
    indexDigest: node.indexDigest,
    platforms: Object.fromEntries(EXPECTED_PLATFORMS.map(item => [item.id, platforms[item.id]])),
    reference: nonEmptyString(node.reference, 'images.lock.images.node.reference', 512),
  }
}

export async function buildReleaseProvenance({
  root,
  metadataPath,
  ociDescriptorPath,
  sbomAmd64Path,
  sbomArm64Path,
}) {
  const projectRoot = resolve(root)
  const fixed = Object.fromEntries(await Promise.all(Object.entries(FIXED_INPUTS).map(async ([key, relativePath]) => [
    key,
    await readRegularFile(resolve(projectRoot, relativePath), relativePath),
  ])))
  const metadataFile = await readRegularFile(metadataPath, 'metadata de release')
  const descriptorFile = await readRegularFile(ociDescriptorPath, 'descritor OCI')
  const sbomFiles = {
    'linux/amd64': await readRegularFile(sbomAmd64Path, 'SBOM linux/amd64'),
    'linux/arm64': await readRegularFile(sbomArm64Path, 'SBOM linux/arm64'),
  }

  const upstream = parseUpstreamLock(fixed.upstreamLock.bytes)
  const integrityEntries = validateIntegrityManifest(
    parseJson(fixed.integrityManifest.bytes, 'manifesto de integridade'),
    upstream,
  )
  const baseImage = validateImagesLock(parseJson(fixed.imagesLock.bytes, 'images.lock'))
  const metadata = validateMetadata(parseJson(metadataFile.bytes, 'metadata de release'))
  const descriptor = validateOciDescriptor(parseJson(descriptorFile.bytes, 'descritor OCI'), metadata.image.indexDigest)
  const spdx = Object.fromEntries(EXPECTED_PLATFORMS.map(item => [
    item.id,
    validateSpdx(parseJson(sbomFiles[item.id].bytes, `SBOM ${item.id}`), item.id),
  ]))
  if (spdx['linux/amd64'].documentNamespace === spdx['linux/arm64'].documentNamespace) {
    fail('SBOMs: documentNamespace precisa ser único por arquitetura')
  }

  return {
    schemaVersion: 1,
    predicateType: 'https://dz23.studio/provenance/release/v1',
    evidenceGenerator: {
      id: 'dz23-studio/m6.1-offline-provenance@1',
      networkAccess: false,
    },
    buildPolicy: {
      dependencyFetchNetworkAccess: true,
      postFetchNetworkAccess: false,
    },
    source: {
      studioCommit: metadata.studioCommit,
      deepseekHarness: {
        commit: upstream.commit,
        manifestSha256: `sha256:${upstream.manifestSha256}`,
        path: upstream.path,
        repository: upstream.repository,
        tree: upstream.tree,
      },
    },
    inputs: {
      dockerfile: { path: FIXED_INPUTS.dockerfile, sha256: fixed.dockerfile.digest },
      imagesLock: {
        baseImages: { node: baseImage },
        path: FIXED_INPUTS.imagesLock,
        sha256: fixed.imagesLock.digest,
      },
      integrityManifest: {
        entries: integrityEntries,
        path: FIXED_INPUTS.integrityManifest,
        sha256: fixed.integrityManifest.digest,
      },
      packageLock: { path: FIXED_INPUTS.packageLock, sha256: fixed.packageLock.digest },
      releaseMetadata: { logicalName: 'release-metadata.json', sha256: metadataFile.digest },
      upstreamLock: { path: FIXED_INPUTS.upstreamLock, sha256: fixed.upstreamLock.digest },
    },
    subject: {
      image: metadata.image.name,
      index: {
        descriptor: {
          mediaType: descriptor.mediaType,
          sha256: descriptorFile.digest,
          size: descriptor.size,
        },
        digest: metadata.image.indexDigest,
      },
      platforms: EXPECTED_PLATFORMS.map(item => ({
        architecture: item.architecture,
        digest: metadata.image.platforms[item.id],
        os: 'linux',
        platform: item.id,
        sbom: {
          ...spdx[item.id],
          logicalName: `sbom-${item.architecture}.spdx.json`,
          sha256: sbomFiles[item.id].digest,
        },
      })),
    },
  }
}

export async function generateReleaseProvenance(options) {
  const provenance = await buildReleaseProvenance(options)
  const output = Buffer.from(canonicalJson(provenance), 'utf8')
  const destination = resolve(options.outputPath)
  if (await lstat(destination).catch(() => undefined)) fail('saída já existe; não será sobrescrita')
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}`
  try {
    await writeFile(temporary, output, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return { digest: sha256(output), outputPath: destination, provenance }
}

export async function verifyReleaseProvenance(options) {
  const actual = await readRegularFile(options.provenancePath, 'proveniência')
  const expected = Buffer.from(canonicalJson(await buildReleaseProvenance(options)), 'utf8')
  if (!actual.bytes.equals(expected)) {
    fail(`proveniência divergente (esperado ${sha256(expected)}, recebido ${actual.digest})`)
  }
  return { digest: actual.digest, provenance: parseJson(actual.bytes, 'proveniência') }
}

function usage() {
  return [
    'Uso:',
    '  node scripts/release-provenance.mjs generate --root <repo> --metadata <json> --oci-descriptor <json> --sbom-amd64 <spdx.json> --sbom-arm64 <spdx.json> --out <json>',
    '  node scripts/release-provenance.mjs verify   --root <repo> --metadata <json> --oci-descriptor <json> --sbom-amd64 <spdx.json> --sbom-arm64 <spdx.json> --provenance <json>',
  ].join('\n')
}

function parseCli(argv) {
  const [command, ...rest] = argv
  if (!['generate', 'verify'].includes(command)) fail(usage())
  const allowed = new Set([
    '--root', '--metadata', '--oci-descriptor', '--sbom-amd64', '--sbom-arm64',
    command === 'generate' ? '--out' : '--provenance',
  ])
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!allowed.has(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      fail(`argumentos inválidos\n${usage()}`)
    }
    values.set(key, value)
  }
  for (const required of ['--metadata', '--oci-descriptor', '--sbom-amd64', '--sbom-arm64']) {
    if (!values.has(required)) fail(`argumento obrigatório ausente: ${required}`)
  }
  const outputFlag = command === 'generate' ? '--out' : '--provenance'
  if (!values.has(outputFlag)) fail(`argumento obrigatório ausente: ${outputFlag}`)
  return {
    command,
    options: {
      root: resolve(values.get('--root') ?? process.cwd()),
      metadataPath: resolve(values.get('--metadata')),
      ociDescriptorPath: resolve(values.get('--oci-descriptor')),
      outputPath: command === 'generate' ? resolve(values.get('--out')) : undefined,
      provenancePath: command === 'verify' ? resolve(values.get('--provenance')) : undefined,
      sbomAmd64Path: resolve(values.get('--sbom-amd64')),
      sbomArm64Path: resolve(values.get('--sbom-arm64')),
    },
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv)
  const result = command === 'generate'
    ? await generateReleaseProvenance(options)
    : await verifyReleaseProvenance(options)
  process.stdout.write(`RELEASE_PROVENANCE=PASS mode=${command} sha256=${result.digest}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`RELEASE_PROVENANCE=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
