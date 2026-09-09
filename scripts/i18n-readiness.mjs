/**
 * The catalogues the i18n gate has to READ, and the readiness claims it refuses to find in them.
 *
 * It lives on its own because the list used to be a literal inside the gate, walked with
 * `if (!exists(full)) continue`: renaming a catalogue — or moving one plugin's `i18n/` folder —
 * turned that scan into zero items and the gate still printed PASS. A gate that inspected nothing
 * has not approved anything, so a catalogue that is expected and missing is a FAILURE here, and so
 * is a scan that ends up reading no catalogue at all.
 *
 * `plugins/<name>/i18n/pt-BR.json` was never scanned for readiness claims at all: a plugin could
 * promise the person that something was "pronto" and no gate ever looked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** "pronto", "pronta", "prontos", "prontas": a claim about readiness this product does not make. */
const READY_CLAIM = /\bpront[oa]s?\b/iu

/** Catalogues that must exist. Absence is a failure, never a skipped item. */
export const REQUIRED_CATALOGUES = [
  'apps/studio-web/src/i18n/pwa.pt-BR.json',
  'apps/studio-web/src/i18n/hub.pt-BR.json',
  // O vocabulário do palpite de categoria também é texto de idioma: renomeá-lo
  // não pode encolher o portão em silêncio.
  'apps/studio-web/src/i18n/categorySignals.pt-BR.json',
  'apps/studio-web/src/i18n/help.pt-BR.json',
  'apps/studio-web/public/manifest.json',
]

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Every plugin that HAS an `i18n/` folder owes a `pt-BR.json` in it; the path is returned either way. */
export function pluginCatalogues(root) {
  let entries = []
  try { entries = readdirSync(resolve(root, 'plugins'), { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(entry => entry.isDirectory() && isDirectory(resolve(root, 'plugins', entry.name, 'i18n')))
    .map(entry => `plugins/${entry.name}/i18n/pt-BR.json`)
    .sort()
}

function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

/**
 * Reads every catalogue that must be read and reports what it found. `scanned` is the evidence the
 * gate prints: a run whose count is zero, or lower than it was, is a run that stopped looking.
 */
export function scanReadinessClaims(root) {
  const failures = []
  const scanned = []
  for (const target of [...REQUIRED_CATALOGUES, ...pluginCatalogues(root)]) {
    const full = resolve(root, target)
    if (!isFile(full)) {
      failures.push(`catálogo obrigatório ausente: ${target} (renomear um catálogo não pode reduzir o escopo do portão em silêncio)`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      failures.push(`catálogo ilegível: ${target}`)
      continue
    }
    scanned.push(target)
    for (const [path, value] of flatten(parsed)) {
      if (READY_CLAIM.test(value)) failures.push(`alegação de prontidão proibida em ${target}:${path}`)
    }
  }
  if (scanned.length === 0) failures.push('nenhum catálogo foi lido: um portão que inspeciona zero itens é falha, não aprovação')
  return { scanned, failures }
}
