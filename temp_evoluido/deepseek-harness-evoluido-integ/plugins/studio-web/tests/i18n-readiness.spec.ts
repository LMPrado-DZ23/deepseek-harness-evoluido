import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginCatalogues, REQUIRED_CATALOGUES, scanReadinessClaims } from '../../../scripts/i18n-readiness.mjs'

const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

/** A minimal tree with every catalogue the gate must read, so a test can take exactly one away. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-i18n-gate-'))
  scratch.push(root)
  for (const target of REQUIRED_CATALOGUES) {
    await mkdir(join(root, target, '..'), { recursive: true })
    await writeFile(join(root, target), JSON.stringify({ ok: 'Tudo certo.' }))
  }
  await mkdir(join(root, 'plugins', 'exemplo', 'i18n'), { recursive: true })
  await writeFile(join(root, 'plugins', 'exemplo', 'i18n', 'pt-BR.json'), JSON.stringify({ ok: 'Tudo certo.' }))
  return root
}

describe('i18n readiness scan', () => {
  it('reads every catalogue of the real repository, including each plugin catalogue', () => {
    const { scanned, failures } = scanReadinessClaims(process.cwd())
    expect(failures).toEqual([])
    expect(scanned).toEqual(expect.arrayContaining([...REQUIRED_CATALOGUES, 'plugins/integration-hub/i18n/pt-BR.json']))
    expect(pluginCatalogues(process.cwd())).toContain('plugins/prompt-to-app/i18n/pt-BR.json')
  })

  it('fails when a catalogue is renamed away, instead of quietly scanning fewer of them', async () => {
    const root = await fixture()
    expect(scanReadinessClaims(root).failures).toEqual([])
    // Exactly the reviewer's reproduction: rename one catalogue and the old gate scanned one item
    // less, said nothing, and passed.
    await rename(join(root, 'apps/studio-web/src/i18n/hub.pt-BR.json'), join(root, 'apps/studio-web/src/i18n/hub.pt-BR.json.bak'))
    expect(scanReadinessClaims(root).failures).toEqual([expect.stringContaining('hub.pt-BR.json')])
    // And a plugin that has an i18n/ folder owes the catalogue in it.
    await rename(join(root, 'plugins/exemplo/i18n/pt-BR.json'), join(root, 'plugins/exemplo/i18n/pt-BR.json.bak'))
    expect(scanReadinessClaims(root).failures).toHaveLength(2)
  })

  it('fails when the scan ends up reading nothing at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-i18n-gate-empty-'))
    scratch.push(root)
    const { scanned, failures } = scanReadinessClaims(root)
    expect(scanned).toEqual([])
    expect(failures).toContainEqual(expect.stringContaining('zero itens é falha'))
  })

  it('finds a readiness claim inside a plugin catalogue, which nothing scanned before', async () => {
    const root = await fixture()
    await writeFile(join(root, 'plugins', 'exemplo', 'i18n', 'pt-BR.json'), JSON.stringify({ done: { label: 'Seu aplicativo está pronto.' } }))
    expect(scanReadinessClaims(root).failures).toEqual(['alegação de prontidão proibida em plugins/exemplo/i18n/pt-BR.json:done.label'])
  })
})
