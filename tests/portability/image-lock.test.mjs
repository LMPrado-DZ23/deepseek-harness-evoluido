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
})
