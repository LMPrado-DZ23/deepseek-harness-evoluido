#!/usr/bin/env node
/**
 * Portão da compressão Caveman/RTK.
 *
 * O requisito C-16 é verdade por AUSÊNCIA: nenhuma linha de compressão de
 * prompt/contexto existe, então nada transforma código, log ou erro pelas
 * costas de quem lê. Verdade por ausência não se defende sozinha - basta uma
 * dependência nova, um import ou um utilitário "só para caber no contexto"
 * para que a saída do modelo passe a mentir sem que ninguém tenha optado por
 * isso. Este portão versiona a ausência: enquanto ele roda, a reintrodução
 * precisa apagar o portão junto, e isso aparece no diff.
 *
 * O que ele NÃO pode fazer é confundir compressão de transporte com
 * compressão de conteúdo. `gzip`, `brotli`, `compression: gzip` e
 * `decompressedText` são legítimos e continuam por toda a base; mirar na
 * palavra "compress" transformaria o portão em ruído e ele seria desligado no
 * primeiro falso positivo. Por isso as regras miram no que é proibido:
 * NOME DE PACOTE de compressão de prompt, IMPORT desses módulos e SÍMBOLO que
 * declara compressão de prompt/contexto/código/log/erro.
 *
 * Uso: node scripts/check-no-caveman.mjs [--self-test]
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Pacotes de compressão de prompt/contexto, um a um.
 *
 * A lista é fechada de propósito. Um prefixo solto (`rtk`) reprovaria
 * `@reduxjs/toolkit`, que a casa chama de RTK por outro motivo inteiramente;
 * um nome inteiro só casa com o pacote que ele nomeia.
 */
export const FORBIDDEN_PACKAGES = [
  'caveman', 'caveman-compress', 'caveman-compressor', 'caveman-prompt',
  'rtk-compress', 'rtk-compressor', 'rtk-prompt', 'rtk-context',
  'prompt-compress', 'prompt-compressor', 'prompt-compression', 'promptzip',
  'context-compress', 'context-compressor', 'context-compression',
  'token-compressor', 'llmlingua', 'llm-lingua',
]

const PACKAGE_NAMES = FORBIDDEN_PACKAGES.join('|')

/**
 * Cada regra descreve UMA forma reconhecível de reintrodução.
 *
 * `manifest` olha declaração de dependência (`package.json` e lockfiles);
 * `source` olha código. Um pacote proibido só entra no repositório por um
 * desses dois caminhos, e nenhuma das duas formas aparece em prosa: o ledger
 * PRECISA continuar escrevendo "Compressao Caveman/RTK desligada" sem que o
 * portão o acuse.
 */
export const CAVEMAN_RULES = [
  {
    id: 'forbidden-package',
    scope: 'manifest',
    pattern: new RegExp(`(?:^|["'\\s/])(?:@[A-Za-z0-9._-]+/)?(?:${PACKAGE_NAMES})(?:["']|@\\d)`, 'iu'),
  },
  {
    id: 'compression-import',
    scope: 'source',
    pattern: new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'][^"']*(?:${PACKAGE_NAMES})[^"']*["']`, 'iu'),
  },
  {
    // `cavemanCompress`, `CAVEMAN_MODE`, `rtk_compression`. O separador aceito é
    // `_`/`-`/nada, nunca espaço: "compressão do caveman" em comentário é
    // discussão, não código que roda.
    id: 'caveman-symbol',
    scope: 'source',
    pattern: /\b(?:caveman|rtk)[_-]?(?:compress|compressor|compression|prompt|context|mode)\b/iu,
  },
  {
    // `compressPrompt`, `compress_context`, `compressCode`, `compressLog`,
    // `compressError`: o verbo aplicado justamente ao que não pode ser
    // transformado sem opt-in.
    id: 'compress-content-symbol',
    scope: 'source',
    pattern: /\b(?:de)?compress[_-]?(?:prompt|context|message|messages|code|log|logs|error|errors|token|tokens)\b/iu,
  },
  {
    // A mesma coisa na ordem inversa: `promptCompression`, `context_compressor`.
    id: 'content-compression-symbol',
    scope: 'source',
    pattern: /\b(?:prompt|context|token|message)[_-]?compress(?:or|ion|ed|es)?\b/iu,
  },
]

/** Manifestos de dependência: é aqui que um pacote novo aparece. */
const MANIFEST_PATH = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock(?:\.[a-z]+)?\.yaml|yarn\.lock)$/u

/** Código que realmente roda ou é publicado. */
const SOURCE_PATH = /\.(?:[cm]?[jt]sx?)$/u

/**
 * O próprio portão e o teste dele PRECISAM conter os termos proibidos para
 * provar que os pegam. A isenção é nominal - dois caminhos, não um padrão
 * aberto - porque uma isenção larga aqui é o mesmo que não ter portão.
 */
const GATE_PATH = /^scripts\/check-no-caveman\.(?:mjs|spec\.mjs)$/u

/**
 * Os achados de um arquivo, na ordem das linhas.
 * @param path - caminho do arquivo no repositório.
 * @param source - conteúdo do arquivo.
 * @returns achados: arquivo, linha e qual regra bateu.
 */
export function cavemanFindings(path, source) {
  if (GATE_PATH.test(path)) return []
  const manifest = MANIFEST_PATH.test(path)
  const isSource = SOURCE_PATH.test(path)
  if (!manifest && !isSource) return []
  const findings = []
  for (const [index, line] of source.split('\n').entries()) {
    for (const rule of CAVEMAN_RULES) {
      if (rule.scope === 'manifest' ? !manifest : !isSource) continue
      if (!rule.pattern.test(line)) continue
      findings.push({ path, line: index + 1, rule: rule.id })
    }
  }
  return findings
}

/** Os arquivos que o git realmente carrega. */
async function trackedFiles() {
  const { stdout } = await run('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\0').filter(path => path !== '' && (MANIFEST_PATH.test(path) || SOURCE_PATH.test(path)))
}

function selfTest() {
  const cases = [
    // Reintrodução: dependência, import e símbolo.
    ['dependência caveman reprova', cavemanFindings('package.json', '    "caveman": "^2.0.0",').length === 1],
    ['dependência com escopo reprova', cavemanFindings('package.json', '    "@acme/prompt-compressor": "1.0.0",').length === 1],
    ['dependência no lockfile reprova', cavemanFindings('pnpm-lock.yaml', '  llmlingua@0.2.1:').length === 1],
    ['import de módulo proibido reprova', cavemanFindings('a.ts', "import { squeeze } from 'caveman-compress'").length >= 1],
    ['require de módulo proibido reprova', cavemanFindings('a.cjs', "const x = require('llm-lingua')").length >= 1],
    ['símbolo cavemanCompress reprova', cavemanFindings('a.ts', 'const out = cavemanCompress(prompt)').length >= 1],
    ['constante CAVEMAN_MODE reprova', cavemanFindings('a.ts', 'const CAVEMAN_MODE = false').length === 1],
    ['compressPrompt reprova', cavemanFindings('a.ts', 'function compressPrompt(value) { return value }').length === 1],
    ['compress_log reprova', cavemanFindings('a.mjs', 'const line = compress_log(entry)').length === 1],
    ['promptCompression reprova', cavemanFindings('a.ts', 'if (promptCompression) return').length === 1],
    ['rtk-compress no manifesto reprova', cavemanFindings('plugins/x/package.json', '"rtk-compress": "workspace:*"').length === 1],
    // O que NÃO pode reprovar: a casa comprime transporte o tempo todo, e o
    // ledger precisa continuar escrevendo o nome do que está proibido.
    ['gzip de telemetria passa', cavemanFindings('a.ts', "const headers = { 'content-encoding': 'gzip' }").length === 0],
    ['compression: gzip passa', cavemanFindings('a.ts', 'const exporter = { compression: "gzip" }').length === 0],
    ['brotli e gunzip passam', cavemanFindings('a.ts', "import { brotliDecompress, gunzip } from 'node:zlib'").length === 0],
    ['decompressedText passa', cavemanFindings('a.ts', 'const plain = await decompressedText(extension, data)').length === 0],
    ['compressão de linha do sqlite passa', cavemanFindings('a.ts', 'export const rowCompression = true').length === 0],
    ['prosa do ledger passa', cavemanFindings('a.ts', '// Compressao Caveman/RTK desligada por padrao').length === 0],
    ['@reduxjs/toolkit passa', cavemanFindings('package.json', '    "@reduxjs/toolkit": "2.3.0",').length === 0],
    ['nome que apenas contém o termo passa', cavemanFindings('package.json', '    "mycaveman-ui": "1.0.0",').length === 0],
    ['markdown não é varrido', cavemanFindings('docs/x.md', 'usamos cavemanCompress em 2019').length === 0],
    ['o próprio portão é isento', cavemanFindings('scripts/check-no-caveman.mjs', 'const CAVEMAN_MODE = 1').length === 0],
    ['o teste do portão é isento', cavemanFindings('scripts/check-no-caveman.spec.mjs', 'compressPrompt()').length === 0],
    // Um símbolo proibido em manifesto e um pacote proibido em código não são
    // a forma que cada regra procura: cada regra olha o lugar onde a coisa
    // realmente entra.
    ['símbolo em manifesto não é a regra de pacote', cavemanFindings('package.json', '  "scripts": { "x": "node compressPrompt.js" }').length === 0],
  ]
  const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
  console.log(`NO_CAVEMAN_SELF_TEST=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${String(cases.length)}${failed.length === 0 ? '' : ` falhou=${failed.join(', ')}`}`)
  return failed.length === 0
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const files = await trackedFiles()
  if (files.length === 0) {
    // Um portão que passa sem ler nada é um portão que apodreceu em silêncio.
    console.error('NO_CAVEMAN=FAIL motivo=nenhum arquivo rastreado foi lido')
    process.exitCode = 1
  } else {
    const findings = []
    for (const path of files) {
      const source = await readFile(path, 'utf8').catch(() => '')
      findings.push(...cavemanFindings(path, source))
    }
    for (const finding of findings) console.error(`${finding.path}:${String(finding.line)} compressão proibida (${finding.rule})`)
    console.log(`NO_CAVEMAN=${findings.length === 0 ? 'PASS' : 'FAIL'} arquivos=${String(files.length)} achados=${String(findings.length)} regras=${String(CAVEMAN_RULES.length)}`)
    process.exitCode = findings.length === 0 ? 0 : 1
  }
}
