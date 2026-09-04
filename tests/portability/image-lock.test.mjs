import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateImageLock } from '../../scripts/check-image-lock.mjs'

const canonical = JSON.parse(await readFile(new URL('../../deploy/images.lock.json', import.meta.url), 'utf8'))

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
})
