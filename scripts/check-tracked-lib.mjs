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

function selfTest() {
  const tracked = new Set(['plugins/x/lib/index.js', 'plugins/x/lib/ok.js'])
  const good = brokenImports(() => "export * from './ok.js'\n", tracked)
  const bad = brokenImports(file => file.endsWith('index.js') ? "export * from './sumido.js'\n" : '', tracked)
  const passed = good.length === 0 && bad.length === 1 && bad[0].resolved === 'plugins/x/lib/sumido.js'
  console.log(`TRACKED_LIB_SELF_TEST=${passed ? 'PASS' : 'FAIL'} negative_detected=${String(bad.length)}`)
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
    const findings = brokenImports(trackedContent, tracked)
    for (const finding of findings) {
      console.error(`${finding.file} importa '${finding.specifier}', que não está versionado (${finding.resolved})`)
    }
    console.log(`TRACKED_LIB=${findings.length === 0 ? 'PASS' : 'FAIL'} files=${String(tracked.size)} findings=${String(findings.length)}`)
    process.exitCode = findings.length === 0 ? 0 : 1
  }
}
