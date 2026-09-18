#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const KEY_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'UPSTREAM.lock'])
const EXECUTABLE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.sh', '.ps1'])
const JAVASCRIPT_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx'])
const OMIT = new Set(['scripts/check-portability.mjs'])

const MACHINE_PATH_RULES = [
  { id: 'POSIX_HOME', pattern: /\/home\/[A-Za-z0-9._-]+(?:\/|\\)/gu },
  { id: 'WINDOWS_USERS', pattern: /[A-Za-z]:[\\/]Users[\\/][^\s'"`]+/giu },
  { id: 'UNC_PATH', pattern: /\\\\[A-Za-z0-9._-]+[\\/][A-Za-z0-9$._-]+(?:[\\/][^\s'"`]*)?/gu },
]

const MANIFEST_ONLY_RULES = [
  { id: 'ABSOLUTE_LINK', pattern: /\blink:(?:\/{1,2}|[A-Za-z]:[\\/]|\\\\)/giu },
  { id: 'FILE_URL', pattern: /\bfile:(?:\/{1,3}|[A-Za-z]:[\\/])/giu },
]

const ABSOLUTE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*(['"])((?:\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:[\\/]Users[\\/]|\\\\[A-Za-z0-9._-]+[\\/])[^'"]*)\1/giu

function javascriptStringContextAt(content, target) {
  let state = 'code'
  let rawTemplate = false
  for (let index = 0; index < target; index += 1) {
    const current = content[index]
    const next = content[index + 1]
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code'
        index += 1
      }
      continue
    }
    if (state !== 'code') {
      if (current === '\\') {
        index += 1
      } else if ((state === 'single' && current === "'")
        || (state === 'double' && current === '"')
        || (state === 'template' && current === '`')) {
        state = 'code'
        rawTemplate = false
      }
      continue
    }
    if (current === '/' && next === '/') {
      state = 'line-comment'
      index += 1
    } else if (current === '/' && next === '*') {
      state = 'block-comment'
      index += 1
    } else if (current === "'") {
      state = 'single'
    } else if (current === '"') {
      state = 'double'
    } else if (current === '`') {
      state = 'template'
      rawTemplate = /(?:^|[^A-Za-z0-9_$])String\.raw\s*$/u.test(content.slice(0, index))
    }
  }
  return { state, rawTemplate }
}

function startsRegexLiteral(content, slashIndex, lineStart) {
  let previous = slashIndex - 1
  while (previous >= lineStart && /\s/u.test(content[previous])) previous -= 1
  if (previous < lineStart) return true
  if ('([{:;,=!?&|+-*%^~<>'.includes(content[previous])) return true
  const prefix = content.slice(lineStart, slashIndex)
  return /(?:^|\s)(?:return|case|throw|yield|await)\s*$/u.test(prefix)
}

function regexLiteralEnd(content, slashIndex, lineEnd) {
  let escaped = false
  let characterClass = false
  for (let index = slashIndex + 1; index < lineEnd; index += 1) {
    const current = content[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
    } else if (current === '[') {
      characterClass = true
    } else if (current === ']') {
      characterClass = false
    } else if (current === '/' && !characterClass) {
      return index
    }
  }
  return -1
}

function isInsideJavaScriptRegex(content, target) {
  const lineStart = Math.max(content.lastIndexOf('\n', target - 1), content.lastIndexOf('\r', target - 1)) + 1
  const newline = content.indexOf('\n', target)
  const carriageReturn = content.indexOf('\r', target)
  const candidates = [newline, carriageReturn].filter(index => index >= 0)
  const lineEnd = candidates.length ? Math.min(...candidates) : content.length
  for (let slash = target - 1; slash >= lineStart; slash -= 1) {
    if (content[slash] !== '/' || !startsRegexLiteral(content, slash, lineStart)) continue
    const end = regexLiteralEnd(content, slash, lineEnd)
    if (end >= target) return true
  }
  return false
}

function isEscapedJavaScriptUnc(content, matchIndex, file) {
  if (!JAVASCRIPT_EXTENSIONS.has(extname(file).toLowerCase())) return false
  let runStart = matchIndex
  let runEnd = matchIndex
  while (runStart > 0 && content[runStart - 1] === '\\') runStart -= 1
  while (runEnd < content.length && content[runEnd] === '\\') runEnd += 1
  const context = javascriptStringContextAt(content, matchIndex)
  if (context.state === 'template' && context.rawTemplate) return false
  if (context.state === 'single' || context.state === 'double' || context.state === 'template') {
    return runEnd - runStart === 2
  }
  return isInsideJavaScriptRegex(content, matchIndex)
}

function gitFiles(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git ls-files falhou')
  return result.stdout.split('\0').filter(Boolean)
}

async function allSourceFiles(root) {
  const omittedDirectories = new Set(['.git', 'node_modules', 'coverage', 'lib', 'dist', 'runtime', 'outputs'])
  const files = []
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!omittedDirectories.has(entry.name)) await visit(resolve(directory, entry.name), childRelative)
      } else {
        files.push(childRelative)
      }
    }
  }
  await visit(root)
  return files
}

function scanKind(path) {
  const normalized = path.replaceAll('\\', '/')
  if (OMIT.has(normalized)) return undefined
  if (KEY_FILES.has(basename(normalized))) return 'manifest'
  if (normalized.startsWith('scripts/') || normalized.startsWith('deploy/')) {
    return EXECUTABLE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? 'script' : undefined
  }
  if (normalized.startsWith('apps/')) {
    return EXECUTABLE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? 'script' : undefined
  }
  if (normalized.includes('/src/') || normalized.includes('/tests/')) {
    return EXECUTABLE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? 'source' : undefined
  }
  return undefined
}

export async function scanPortableSources(root, suppliedFiles) {
  const files = (suppliedFiles ?? gitFiles(root)).filter((file) => scanKind(file))
  // Quantos arquivos ESTE portão de fato abriu. Sem este número o veredito
  // dizia só `findings=0`, que é indistinguível de um portão que deixou de
  // achar o que procurar — e a cláusula 5.1 da constituição chama isso de
  // falha, não de aprovação. Foi `gate:constitution` que pegou.
  scanPortableSources.lastScanned = files.length
  const findings = []
  for (const file of files) {
    const absolute = resolve(root, file)
    const content = await readFile(absolute, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (content === undefined) continue
    const kind = scanKind(file)
    const rules = kind === 'manifest'
      ? [...MACHINE_PATH_RULES, ...MANIFEST_ONLY_RULES]
      : kind === 'script'
        ? MACHINE_PATH_RULES
        : []
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      for (const match of content.matchAll(rule.pattern)) {
        if (rule.id === 'UNC_PATH' && isEscapedJavaScriptUnc(content, match.index, file)) continue
        const line = content.slice(0, match.index).split(/\r?\n/u).length
        findings.push({ file: file.replaceAll('\\', '/'), line, rule: rule.id, value: match[0] })
      }
    }
    if (kind === 'source' || kind === 'script') {
      ABSOLUTE_IMPORT.lastIndex = 0
      for (const match of content.matchAll(ABSOLUTE_IMPORT)) {
        const line = content.slice(0, match.index).split(/\r?\n/u).length
        findings.push({
          file: file.replaceAll('\\', '/'),
          line,
          rule: 'ABSOLUTE_IMPORT',
          value: match[2],
        })
      }
    }
  }
  return findings
}

async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-portability-'))
  try {
    await mkdir(join(root, 'plugins', 'safe', 'src'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(
      join(root, 'scripts', 'safe.mjs'),
      String.raw`export const rows = value.split(/\\n/u)
export const pattern = /prefix\\server/u
export const escaped = "\\n/u"
`,
    )
    await writeFile(
      join(root, 'scripts', 'unc.ps1'),
      String.raw`$machinePath = '\\server\share\artifact.json'
$mixedMachinePath = '\\server/share/artifact.json'
`,
    )
    await writeFile(
      join(root, 'scripts', 'unc.mjs'),
      'export const machinePath = String.raw`\\\\server\\share\\artifact.json`\n',
    )
    await writeFile(
      join(root, 'plugins', 'safe', 'package.json'),
      JSON.stringify({ dependencies: { bad: 'link:/home/alice/private/pkg' } }),
    )
    const findings = await scanPortableSources(root, [
      'scripts/safe.mjs',
      'scripts/unc.ps1',
      'scripts/unc.mjs',
      'plugins/safe/package.json',
    ])
    const uncFindings = findings.filter((item) => item.file.endsWith('unc.ps1') && item.rule === 'UNC_PATH')
    if (findings.some((item) => item.file.endsWith('safe.mjs'))
      || uncFindings.length !== 2
      || !findings.some((item) => item.file.endsWith('unc.mjs') && item.rule === 'UNC_PATH')
      || !findings.some((item) => item.rule === 'ABSOLUTE_LINK')) {
      throw new Error(`self-test não separou escapes legítimos de UNC real; recebeu ${JSON.stringify(findings)}`)
    }
    const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8', windowsHide: true })
    if (gitInit.status !== 0) throw new Error(gitInit.stderr.trim() || 'git init da fixture falhou')
    await mkdir(join(root, 'apps'), { recursive: true })
    await writeFile(join(root, 'apps', 'new-entrypoint.mjs'), "export const bad = '/home/alice/private/entry.js'\n")
    const untrackedFindings = await scanPortableSources(root)
    const filesystemFindings = await scanPortableSources(root, await allSourceFiles(root))
    if (!untrackedFindings.some((item) => item.file === 'plugins/safe/package.json')
      || !filesystemFindings.some((item) => item.file === 'apps/new-entrypoint.mjs' && item.rule === 'POSIX_HOME')) {
      throw new Error(`self-test não examinou arquivo não rastreado e entrypoint; recebeu git=${JSON.stringify(untrackedFindings)} fs=${JSON.stringify(filesystemFindings)}`)
    }
    process.stdout.write('PORTABILITY_SELF_TEST=PASS negative_fixture_rejected=true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Os defeitos do COMANDO DE RETOMADA, que é a promessa mais frágil deste
 * repositório.
 *
 * O resto deste portão olha arquivos executáveis, e com razão: um documento
 * pode citar um caminho num exemplo sem que isso quebre ninguém. O comando de
 * retomada é a exceção — ele não é exemplo, é a instrução que alguém executa
 * numa máquina nova, depois de um contexto perdido. Uma revisão externa achou
 * exatamente isto: a retomada chamava um roteiro em `/tmp` que o repositório
 * não tem, e partia de um diretório que só existia numa máquina.
 *
 * A regra é estreita de propósito: vale SÓ para o bloco de código que segue o
 * título do comando de retomada, e não para o documento inteiro.
 * @param conteudo - o `PROJECT_STATUS.md`.
 * @returns as reprovações.
 */
export function achadosDaRetomada(conteudo) {
  const bloco = /(?:##+|\*\*)\s*Comando de retomada[^\n]*\n+```[a-z]*\n([\s\S]*?)```/iu.exec(conteudo)
  if (bloco === null) return [{ file: 'docs/status/PROJECT_STATUS.md', line: 0, rule: 'RETOMADA_AUSENTE', value: 'não há bloco de comando de retomada' }]
  const comandos = bloco[1]
  const achados = []
  for (const { id, pattern } of MACHINE_PATH_RULES) {
    for (const encontrado of comandos.matchAll(new RegExp(pattern.source, pattern.flags))) {
      achados.push({ file: 'docs/status/PROJECT_STATUS.md', line: 0, rule: `RETOMADA_${id}`, value: encontrado[0] })
    }
  }
  /*
    Um programa em pasta temporária não é um programa: ele some no reinício, não
    está no histórico, e ninguém pode ler o que ele fazia. Citar um ARQUIVO de
    saída temporário continua permitido — é saída, não é o programa.
  */
  for (const encontrado of comandos.matchAll(/(?:bash|sh|source|\.)\s+(\/tmp\/\S+|%TEMP%\S*)/giu)) {
    achados.push({ file: 'docs/status/PROJECT_STATUS.md', line: 0, rule: 'RETOMADA_PROGRAMA_TEMPORARIO', value: encontrado[1] })
  }
  return achados
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) await selfTest()
  const rootIndex = argv.indexOf('--root')
  const root = resolve(rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd())
  const suppliedFiles = argv.includes('--all-files') ? await allSourceFiles(root) : undefined
  const findings = await scanPortableSources(root, suppliedFiles)
  const statusPath = resolve(root, 'docs/status/PROJECT_STATUS.md')
  if (existsSync(statusPath)) findings.push(...achadosDaRetomada(await readFile(statusPath, 'utf8')))
  if (findings.length) {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.file}:${finding.line}: ${finding.rule}: ${finding.rule.startsWith('RETOMADA') ? 'a retomada depende de algo que não é do repositório' : 'caminho de máquina proibido'} (${finding.value})\n`,
      )
    }
    throw new Error(`${findings.length} referência(s) não portáteis`)
  }
  process.stdout.write(`PORTABILITY=PASS source=${suppliedFiles === undefined ? 'git' : 'filesystem'} arquivos=${String(scanPortableSources.lastScanned ?? 0)} findings=0\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`PORTABILITY=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
