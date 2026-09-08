#!/usr/bin/env node
/**
 * Portão P37 de licença.
 *
 * O produto tem uma proibição inegociável - nenhum componente sob licença
 * fonte-disponível (BSL, SSPL, Elastic, Commons Clause) entra no artefato ou no
 * serviço - e não havia nada verificando isso. Este portão lê a licença de cada
 * pacote instalado e recusa a família proibida.
 *
 * Ele não julga o que "provavelmente é permissivo": o que não está na lista de
 * permitidas nem na de proibidas vai para revisão humana, registrada em
 * `docs/baselines/license-review.json`. Um pacote novo em revisão REPROVA - é
 * assim que a decisão fica com uma pessoa, e não com um regex.
 *
 * Uso: node scripts/check-release-licenses.mjs [--self-test]
 */
import { readFile, readdir } from 'node:fs/promises'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Guarda de entrada: importar este arquivo como biblioteca não pode disparar a
 * varredura inteira como efeito colateral do import.
 */
const RUN_AS_SCRIPT = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]

/**
 * Licenças aceitas para um serviço: permissivas e as de copyleft fraco, que
 * incidem sobre o próprio arquivo e não sobre o produto em volta.
 */
export const ALLOWED_LICENSES = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0',
  'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0', 'ISC', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'MIT', 'MIT-0', 'MPL-2.0', 'Python-2.0', 'Unlicense', 'WTFPL', 'Zlib',
])

/**
 * As famílias proibidas. O casamento é por trecho, e não por id exato, porque
 * `BUSL-1.1`, `Business Source License 1.1` e `BSL-1.1` são a mesma coisa
 * escrita de três jeitos.
 */
export const FORBIDDEN_LICENSE_PATTERNS = [
  /\bAGPL\b/iu, /\bSSPL\b/iu, /\bBUSL\b/iu, /\bBSL-\d/iu, /business source/iu,
  /commons clause/iu, /elastic license/iu, /\bPolyForm\b/iu, /\bProsperity\b/iu,
  /\bRSAL\b/iu, /^UNLICENSED$/u, /\bGPL-[23]\.0(?:-only|-or-later)?$/iu,
]

/** Pacotes deste repositório: a decisão de licença do produto é do Prado (C-05). */
const OWN_PACKAGE = /^(?:@dz23-studio\/|@studio\/|dsh-profile-studio$|dz23-)/u

/**
 * Avalia uma expressão SPDX contra a lista de permitidas.
 *
 * `A OR B` basta uma; `A AND B` exige as duas. Tratar `(MIT OR GPL-3.0)` como
 * proibida por causa do segundo termo recusaria um pacote que se pode usar sob
 * MIT - e tratar `(Apache-2.0 AND BSD-3-Clause)` como permitida sem checar as
 * duas seria o erro simétrico.
 * @param expression - a expressão declarada no `package.json`.
 * @returns `allowed`, `forbidden` ou `review`.
 */
export function classifyLicense(expression) {
  const value = (expression ?? '').trim()
  if (value === '') return 'review'
  const bare = value.replace(/[()]/gu, ' ').trim()
  if (bare.includes(' OR ')) {
    const parts = bare.split(' OR ').map(part => classifyLicense(part))
    if (parts.includes('allowed')) return 'allowed'
    return parts.includes('review') ? 'review' : 'forbidden'
  }
  if (bare.includes(' AND ')) {
    const parts = bare.split(' AND ').map(part => classifyLicense(part))
    if (parts.includes('forbidden')) return 'forbidden'
    return parts.includes('review') ? 'review' : 'allowed'
  }
  if (FORBIDDEN_LICENSE_PATTERNS.some(pattern => pattern.test(bare))) return 'forbidden'
  return ALLOWED_LICENSES.has(bare) ? 'allowed' : 'review'
}

/**
 * A licença declarada por um `package.json`, nas três formas que o npm aceita.
 * @param manifest - o objeto do `package.json`.
 * @returns a expressão, ou `undefined` quando o pacote não declara nenhuma.
 */
export function declaredLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (typeof manifest.license?.type === 'string') return manifest.license.type
  const first = Array.isArray(manifest.licenses) ? manifest.licenses[0] : undefined
  return typeof first?.type === 'string' ? first.type : undefined
}

/** Todos os pacotes instalados, incluindo os de escopo. */
async function installedPackages(root) {
  const found = []
  for (const name of await readdir(root).catch(() => [])) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      for (const scoped of await readdir(`${root}/${name}`).catch(() => [])) {
        found.push(`${root}/${name}/${scoped}`)
      }
      continue
    }
    found.push(`${root}/${name}`)
  }
  return found
}

function selfTest() {
  const checks = [
    ['MIT passa', classifyLicense('MIT') === 'allowed'],
    ['AGPL reprova', classifyLicense('AGPL-3.0-only') === 'forbidden'],
    ['BUSL reprova', classifyLicense('BUSL-1.1') === 'forbidden'],
    ['Business Source por extenso reprova', classifyLicense('Business Source License 1.1') === 'forbidden'],
    ['SSPL reprova', classifyLicense('SSPL-1.0') === 'forbidden'],
    ['Commons Clause reprova', classifyLicense('MIT with Commons Clause') === 'forbidden'],
    ['GPL forte reprova', classifyLicense('GPL-3.0-or-later') === 'forbidden'],
    ['LGPL passa', classifyLicense('LGPL-3.0-or-later') === 'allowed'],
    ['OR com opção permitida passa', classifyLicense('(MIT OR GPL-3.0-or-later)') === 'allowed'],
    ['OR só com proibidas reprova', classifyLicense('(AGPL-3.0-only OR SSPL-1.0)') === 'forbidden'],
    ['AND exige as duas', classifyLicense('(Apache-2.0 AND BSD-3-Clause)') === 'allowed'],
    ['AND com proibida reprova', classifyLicense('(MIT AND AGPL-3.0-only)') === 'forbidden'],
    ['desconhecida vai para revisão', classifyLicense('SEE LICENSE IN LICENSE') === 'review'],
    ['ausente vai para revisão', classifyLicense(undefined) === 'review'],
    ['UNLICENSED reprova', classifyLicense('UNLICENSED') === 'forbidden'],
    ['objeto license é lido', declaredLicense({ license: { type: 'MIT' } }) === 'MIT'],
    ['licenses[] antigo é lido', declaredLicense({ licenses: [{ type: 'ISC' }] }) === 'ISC'],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  console.log(`RELEASE_LICENSES_SELF_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${String(checks.length)}${failed.length === 0 ? '' : ` falhou=${failed.join(', ')}`}`)
  return failed.length === 0
}

if (!RUN_AS_SCRIPT) {
  // importado como biblioteca: nada acontece.
} else if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  // `--release` é o modo de PUBLICAR. Ele é mais severo de propósito: um
  // pacote que a revisão marcou como não redistribuível não impede trabalhar no
  // repositório, mas impede gerar um artefato público - o dano acontece na
  // publicação, e é lá que o portão tem de parar.
  const releaseMode = process.argv.includes('--release')
  const reviewed = await readFile('docs/baselines/license-review.json', 'utf8')
    .then(text => new Map(Object.entries(JSON.parse(text)))).catch(() => new Map())
  const paths = await installedPackages('node_modules')
  const forbidden = []
  const unreviewed = []
  const blockedForRelease = []
  let inspected = 0
  let own = 0
  for (const path of paths) {
    const manifest = await readFile(`${path}/package.json`, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
    if (manifest === undefined || typeof manifest.name !== 'string') continue
    inspected += 1
    if (OWN_PACKAGE.test(manifest.name)) { own += 1; continue }
    const license = declaredLicense(manifest)
    const verdict = classifyLicense(license)
    if (verdict === 'forbidden') forbidden.push(`${manifest.name}: ${license ?? 'sem licença'}`)
    if (verdict === 'review' && !reviewed.has(manifest.name)) unreviewed.push(`${manifest.name}: ${license ?? 'sem licença'}`)
    if (reviewed.get(manifest.name)?.decisao === 'blocked-for-release') {
      blockedForRelease.push(`${manifest.name}: ${String(reviewed.get(manifest.name)?.motivo ?? '')}`)
    }
  }
  if (inspected === 0) {
    console.error('RELEASE_LICENSES=FAIL motivo=nenhum pacote foi lido; instale as dependências antes')
    process.exitCode = 1
  } else {
    for (const entry of forbidden) console.error(`licença proibida ${entry}`)
    for (const entry of unreviewed) console.error(`licença sem revisão humana ${entry} - decida e registre em docs/baselines/license-review.json`)
    for (const entry of blockedForRelease) console.error(`${releaseMode ? 'IMPEDE PUBLICAR' : 'aviso, impedirá publicar'}: ${entry}`)
    const failed = forbidden.length + unreviewed.length + (releaseMode ? blockedForRelease.length : 0)
    console.log(`RELEASE_LICENSES=${failed === 0 ? 'PASS' : 'FAIL'} pacotes=${String(inspected)} proprios=${String(own)} proibidas=${String(forbidden.length)} sem_revisao=${String(unreviewed.length)} bloqueiam_publicacao=${String(blockedForRelease.length)} revisadas=${String(reviewed.size)} modo=${releaseMode ? 'release' : 'repositorio'}`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}
