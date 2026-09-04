import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildReleaseProvenance,
  canonicalJson,
  generateReleaseProvenance,
  verifyReleaseProvenance,
} from '../scripts/release-provenance.mjs'

const SHA = {
  arm64: `sha256:${'b'.repeat(64)}`,
  index: `sha256:${'c'.repeat(64)}`,
  amd64: `sha256:${'a'.repeat(64)}`,
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function spdx(architecture) {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `dz23-studio-${architecture}`,
    documentNamespace: `https://dz23.studio/sbom/${architecture}/fixture`,
    creationInfo: {
      created: '2026-09-04T15:30:00Z',
      creators: ['Tool: syft-1.0.0'],
    },
    packages: [{ SPDXID: 'SPDXRef-Package-runtime', name: 'runtime' }],
    files: [],
    relationships: [{
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: 'SPDXRef-Package-runtime',
    }],
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-provenance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const upstream = {
    repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
    path: 'third_party/deepseek-harness',
    commit: '6c705be1ce6774a000d061da41d1823b03a3d42c',
    tree: 'a712eec535b48badc4fefb4df5176a7002e4280b',
    manifest: '862b92782c2f5cd67f81debd1116b16150dfafd84fb4ce2602a729f9cf3d26dc',
  }
  await writeFile(join(root, 'UPSTREAM.lock'), [
    `repository=${upstream.repository}`,
    `path=${upstream.path}`,
    `commit=${upstream.commit}`,
    `tree=${upstream.tree}`,
    `manifest_sha256=${upstream.manifest}`,
    '',
  ].join('\n'), 'utf8')
  await json(join(root, 'integrity', 'deepseek-harness-tree.json'), {
    schemaVersion: 1,
    repository: upstream.repository,
    commit: upstream.commit,
    tree: upstream.tree,
    manifestSha256: upstream.manifest,
    entries: [{ mode: '100644', type: 'blob', oid: '1'.repeat(40), path: 'README.md' }],
  })
  await json(join(root, 'deploy', 'images.lock.json'), {
    schemaVersion: 1,
    images: {
      node: {
        reference: 'docker.io/library/node:22.23.1-bookworm-slim',
        indexDigest: `sha256:${'d'.repeat(64)}`,
        platforms: {
          'linux/amd64': `sha256:${'e'.repeat(64)}`,
          'linux/arm64': `sha256:${'f'.repeat(64)}`,
        },
      },
    },
  })
  await mkdir(join(root, 'deploy', 'studio'), { recursive: true })
  await writeFile(join(root, 'deploy', 'studio', 'Dockerfile'), 'FROM scratch\n', 'utf8')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
  await mkdir(join(root, 'third_party', 'deepseek-harness'), { recursive: true })
  await writeFile(join(root, 'third_party', 'deepseek-harness', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
  const metadataPath = join(root, 'release-metadata.json')
  const descriptorPath = join(root, 'oci-descriptor.json')
  const sbomAmd64Path = join(root, 'sbom-amd64.spdx.json')
  const sbomArm64Path = join(root, 'sbom-arm64.spdx.json')
  await json(metadataPath, {
    schemaVersion: 1,
    studioCommit: '17e79aa80bb40bdc206123dfffe31cc84060643c',
    image: {
      name: 'ghcr.io/dz23/studio:fixture',
      indexDigest: SHA.index,
      platforms: { 'linux/amd64': SHA.amd64, 'linux/arm64': SHA.arm64 },
    },
  })
  await json(descriptorPath, {
    'containerimage.digest': SHA.index,
    'containerimage.descriptor': {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      digest: SHA.index,
      size: 741,
    },
  })
  await json(sbomAmd64Path, spdx('amd64'))
  await json(sbomArm64Path, spdx('arm64'))
  return {
    root,
    metadataPath,
    ociDescriptorPath: descriptorPath,
    outputPath: join(root, 'release-provenance.json'),
    provenancePath: join(root, 'release-provenance.json'),
    sbomAmd64Path,
    sbomArm64Path,
  }
}

test('gera bytes canônicos determinísticos e verifica todos os materiais', async (t) => {
  const options = await fixture(t)
  const first = await buildReleaseProvenance(options)
  const second = await buildReleaseProvenance(options)
  assert.equal(canonicalJson(first), canonicalJson(second))
  const generated = await generateReleaseProvenance(options)
  const verified = await verifyReleaseProvenance(options)
  assert.equal(verified.digest, generated.digest)
  assert.equal(first.source.studioCommit, '17e79aa80bb40bdc206123dfffe31cc84060643c')
  assert.deepEqual(first.subject.platforms.map(item => item.platform), ['linux/amd64', 'linux/arm64'])
  assert.equal(first.evidenceGenerator.networkAccess, false)
  assert.deepEqual(first.buildPolicy, {
    dependencyFetchNetworkAccess: true,
    postFetchNetworkAccess: false,
  })
})

test('falha fechado quando um lock muda após a geração', async (t) => {
  const options = await fixture(t)
  await generateReleaseProvenance(options)
  await writeFile(join(options.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\npackages: {}\n', 'utf8')
  await assert.rejects(() => verifyReleaseProvenance(options), /proveniência divergente/u)
})

test('rejeita digest OCI divergente e plataformas duplicadas', async (t) => {
  const options = await fixture(t)
  const descriptor = JSON.parse(await readFile(options.ociDescriptorPath, 'utf8'))
  descriptor['containerimage.descriptor'].digest = `sha256:${'9'.repeat(64)}`
  await json(options.ociDescriptorPath, descriptor)
  await assert.rejects(() => buildReleaseProvenance(options), /digest diverge/u)

  const metadata = JSON.parse(await readFile(options.metadataPath, 'utf8'))
  metadata.image.platforms['linux/arm64'] = metadata.image.platforms['linux/amd64']
  await json(options.metadataPath, metadata)
  await assert.rejects(() => buildReleaseProvenance(options), /digests precisam ser distintos/u)
})

test('rejeita SBOM que não cumpre o cabeçalho SPDX', async (t) => {
  const options = await fixture(t)
  const invalid = spdx('arm64')
  invalid.dataLicense = 'NOASSERTION'
  await json(options.sbomArm64Path, invalid)
  await assert.rejects(() => buildReleaseProvenance(options), /cabeçalho SPDX inválido/u)
})

test('rejeita SBOM vazio ou sem relação DESCRIBES', async (t) => {
  const options = await fixture(t)
  const empty = spdx('arm64')
  empty.packages = []
  await json(options.sbomArm64Path, empty)
  await assert.rejects(() => buildReleaseProvenance(options), /nenhum pacote descrito/u)

  const optionsWithoutRoot = await fixture(t)
  const unrelated = spdx('arm64')
  unrelated.relationships = []
  await json(optionsWithoutRoot.sbomArm64Path, unrelated)
  await assert.rejects(() => buildReleaseProvenance(optionsWithoutRoot), /não descreve nenhum pacote raiz/u)
})

test('rejeita proveniência adulterada ou não canônica', async (t) => {
  const options = await fixture(t)
  await generateReleaseProvenance(options)
  const bytes = await readFile(options.provenancePath)
  await writeFile(options.provenancePath, Buffer.concat([bytes, Buffer.from(' ')]))
  await assert.rejects(() => verifyReleaseProvenance(options), /proveniência divergente/u)
})

test('implementação e teste não importam APIs de rede', async () => {
  for (const relative of ['scripts/release-provenance.mjs', 'tests/release-provenance.spec.mjs']) {
    const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /node:(?:http|https|http2|net|tls|dns|dgram)/u)
  }
  assert.match(digest('offline'), /^[0-9a-f]{64}$/u)
})
