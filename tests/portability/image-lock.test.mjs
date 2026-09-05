import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateDockerfileBase, validateImageLock } from '../../scripts/check-image-lock.mjs'

const canonical = JSON.parse(await readFile(new URL('../../deploy/images.lock.json', import.meta.url), 'utf8'))
const dockerfile = await readFile(new URL('../../deploy/studio/Dockerfile', import.meta.url), 'utf8')

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
  postgres.tools.postgresClient.packages['postgresql-client-15'] = '15.*'
  assert.throws(() => validateImageLock(postgres), /não fixada/u)

  const missingLeaf = dockerfile.replace('postgresql-client-15=15.19-0+deb12u1', 'postgresql-client-15')
  assert.throws(() => validateDockerfileBase(missingLeaf, canonical), /não fixa postgresql-client-15/u)
})

test('Dockerfile usa exatamente a base Node fixada no lock', () => {
  assert.equal(validateDockerfileBase(dockerfile, canonical).fromLines.length, 5)
  assert.equal(validateDockerfileBase(dockerfile, canonical).frontend, `${canonical.tools.dockerfileFrontend.reference}@${canonical.tools.dockerfileFrontend.digest}`)
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace(canonical.tools.dockerfileFrontend.digest, `sha256:${'9'.repeat(64)}`), canonical),
    /frontend do Dockerfile não está fixado/u,
  )
  assert.throws(
    () => validateDockerfileBase(dockerfile.replace(canonical.images.node.indexDigest, `sha256:${'0'.repeat(64)}`), canonical),
    /não usa a imagem Node fixada/u,
  )
  assert.throws(
    () => validateDockerfileBase(`${dockerfile}\nFROM node:latest AS hidden\n`, canonical),
    /base externa não fixada/u,
  )
  assert.throws(
    () => validateDockerfileBase(`${dockerfile}\nFROM ubuntu AS hidden\n`, canonical),
    /base externa não fixada/u,
  )
})
