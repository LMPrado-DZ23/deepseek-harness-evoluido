#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const KEY_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'UPSTREAM.lock'])
const EXECUTABLE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.sh', '.ps1'])
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

function gitFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git ls-files falhou')
  return result.stdout.split('\0').filter(Boolean)
}

function scanKind(path) {
  const normalized = path.replaceAll('\\', '/')
  if (OMIT.has(normalized)) return undefined
  if (KEY_FILES.has(basename(normalized))) return 'manifest'
  if (normalized.startsWith('scripts/') || normalized.startsWith('deploy/')) {
    return EXECUTABLE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? 'script' : undefined
  }
  if (normalized.includes('/src/') || normalized.includes('/tests/')) {
    return EXECUTABLE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? 'source' : undefined
  }
  return undefined
}

export async function scanPortableSources(root, suppliedFiles) {
  const files = (suppliedFiles ?? gitFiles(root)).filter((file) => scanKind(file))
  const findings = []
  for (const file of files) {
    const absolute = resolve(root, file)
    const content = await readFile(absolute, 'utf8')
    const kind = scanKind(file)
    const rules = kind === 'manifest'
      ? [...MACHINE_PATH_RULES, ...MANIFEST_ONLY_RULES]
      : kind === 'script'
        ? MACHINE_PATH_RULES
        : []
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      for (const match of content.matchAll(rule.pattern)) {
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
    await writeFile(join(root, 'plugins', 'safe', 'src', 'safe.ts'), "export const ok = './relative.js'\n")
    await writeFile(
      join(root, 'plugins', 'safe', 'package.json'),
      JSON.stringify({ dependencies: { bad: 'link:/home/alice/private/pkg' } }),
    )
    const findings = await scanPortableSources(root, [
      'plugins/safe/src/safe.ts',
      'plugins/safe/package.json',
    ])
    if (findings.length !== 2 || !findings.some((item) => item.rule === 'ABSOLUTE_LINK')) {
      throw new Error(`self-test esperava detectar caminho e link absolutos; recebeu ${findings.length}`)
    }
    process.stdout.write('PORTABILITY_SELF_TEST=PASS negative_fixture_rejected=true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) await selfTest()
  const rootIndex = argv.indexOf('--root')
  const root = resolve(rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd())
  const findings = await scanPortableSources(root)
  if (findings.length) {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.file}:${finding.line}: ${finding.rule}: caminho de máquina proibido (${finding.value})\n`,
      )
    }
    throw new Error(`${findings.length} referência(s) não portáteis`)
  }
  process.stdout.write(`PORTABILITY=PASS files_scanned_from_git=true findings=0\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`PORTABILITY=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
