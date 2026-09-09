#!/usr/bin/env node
/**
 * Portão do artefato versionado.
 *
 * `plugins/*\/lib/` está no `.gitignore`, mas alguns plugins têm o `lib/`
 * VERSIONADO desde antes disso, e o `package.json` deles aponta `main` para
 * `./lib/index.js`. Quando um módulo novo entra em `src/` e o `lib/` gerado
 * cai no ignore, o artefato versionado passa a importar um arquivo que não
 * existe no repositório: um clone limpo quebra com `ERR_MODULE_NOT_FOUND`, e
 * nada acusa — porque na máquina de quem fez o build o arquivo está lá.
 *
 * Este portão recusa esse estado. Ele só olha o que o git tem, nunca o disco.
 *
 * Uso: node scripts/check-tracked-lib.mjs [--self-test]
 */
import { execFileSync } from 'node:child_process'

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g

/** Arquivos que o git realmente tem, por caminho completo. */
function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'plugins'], { encoding: 'utf8' })
  return new Set(output.split('\0').filter(name => /^plugins\/[^/]+\/lib\//u.test(name)))
}

function trackedContent(path) {
  // Lê do ÍNDICE, não do último commit: o portão precisa reprovar o estado
  // que está prestes a ser commitado, não o anterior.
  return execFileSync('git', ['show', `:${path}`], { encoding: 'utf8' })
}

/**
 * Resolve um import relativo do jeito que o Node resolve num pacote ESM:
 * caminho literal, sem extensão inferida.
 */
function resolveImport(fromPath, specifier) {
  const parts = fromPath.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Todos os imports relativos de `.js` versionado que não apontam para outro
 * arquivo versionado.
 * @param read - lê o conteúdo de um caminho versionado.
 * @param tracked - conjunto de caminhos que o git tem.
 * @returns lista de `{ file, specifier, resolved }` quebrados.
 */
export function brokenImports(read, tracked) {
  const findings = []
  for (const file of tracked) {
    if (!file.endsWith('.js')) continue
    const source = read(file)
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1]
      if (!specifier.endsWith('.js')) continue
      const resolved = resolveImport(file, specifier)
      if (!tracked.has(resolved)) findings.push({ file, specifier, resolved })
    }
  }
  return findings
}

/**
 * Os manifestos de plugin que divergem do padrão da casa.
 *
 * Todo plugin resolve o CÓDIGO no `lib/` e os TIPOS no `src/` — é isso que faz
 * o monorepo compilar sem build prévio — e declara, na condição `dz23-build`,
 * os tipos do `lib/` para quem consome o pacote construído. Dois plugins não
 * tinham a condição `dz23-build`: consumidos pelo artefato, cairiam nos tipos
 * do `src/`, que o pacote publicado não carrega. Ninguém via, porque no
 * monorepo o `src/` está sempre ali.
 * @param manifests - pares caminho/conteúdo dos `package.json` de plugin.
 * @returns as divergências, uma por manifesto.
 */
export function manifestFindings(manifests) {
  const findings = []
  for (const [path, raw] of manifests) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { findings.push(`${path}: package.json ilegível`); continue }
    const entry = parsed.exports?.['.']
    if (entry === undefined) { findings.push(`${path}: sem exports["."]`); continue }
    if (parsed.main !== './lib/index.js') findings.push(`${path}: main deveria ser ./lib/index.js`)
    if (parsed.types !== './src/index.ts') findings.push(`${path}: types deveria ser ./src/index.ts`)
    if (entry.default !== './lib/index.js') findings.push(`${path}: exports["."].default deveria ser ./lib/index.js`)
    if (entry.types !== './src/index.ts') findings.push(`${path}: exports["."].types deveria ser ./src/index.ts`)
    if (entry['dz23-build']?.types !== './lib/index.d.ts') findings.push(`${path}: falta a condição dz23-build apontando ./lib/index.d.ts`)
  }
  return findings
}

function selfTest() {
  const tracked = new Set(['plugins/x/lib/index.js', 'plugins/x/lib/ok.js'])
  const good = brokenImports(() => "export * from './ok.js'\n", tracked)
  const bad = brokenImports(file => file.endsWith('index.js') ? "export * from './sumido.js'\n" : '', tracked)
  const goodManifest = JSON.stringify({
    main: './lib/index.js', types: './src/index.ts',
    exports: { '.': { 'dz23-build': { types: './lib/index.d.ts', default: './lib/index.js' }, types: './src/index.ts', default: './lib/index.js' } },
  })
  const manifestOk = manifestFindings([['plugins/x/package.json', goodManifest]]).length === 0
  const manifestBad = manifestFindings([['plugins/x/package.json', goodManifest.replace('"dz23-build":{"types":"./lib/index.d.ts","default":"./lib/index.js"},', '')]]).length === 1
  const passed = good.length === 0 && bad.length === 1 && bad[0].resolved === 'plugins/x/lib/sumido.js' && manifestOk && manifestBad
  console.log(`TRACKED_LIB_SELF_TEST=${passed ? 'PASS' : 'FAIL'} negative_detected=${String(bad.length)} manifesto=${manifestOk && manifestBad ? 'PASS' : 'FAIL'}`)
  return passed
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const tracked = trackedFiles()
  if (tracked.size === 0) {
    // Um portão que passa com zero itens é uma falha, não um portão.
    console.error('TRACKED_LIB=FAIL motivo=nenhum arquivo lib versionado foi encontrado')
    process.exitCode = 1
  } else {
    const manifests = execFileSync('git', ['ls-files', '-z', '--', 'plugins/*/package.json'], { encoding: 'utf8' })
      .split('\0').filter(Boolean)
      .map(path => [path, trackedContent(path)])
    const findings = [...brokenImports(trackedContent, tracked), ...manifestFindings(manifests).map(message => ({ file: message, specifier: '', resolved: '' }))]
    for (const finding of findings) {
      console.error(finding.specifier === ''
        ? finding.file
        : `${finding.file} importa '${finding.specifier}', que não está versionado (${finding.resolved})`)
    }
    console.log(`TRACKED_LIB=${findings.length === 0 ? 'PASS' : 'FAIL'} files=${String(tracked.size)} findings=${String(findings.length)}`)
    process.exitCode = findings.length === 0 ? 0 : 1
  }
}
