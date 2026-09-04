// Writes docs/inventory/i18n-legacy-literals.json: the Portuguese literals that
// already existed when the i18n gate started scanning each source root. The gate
// reads this file so it can run on a release artifact (`git archive`), which has
// no Git history; where history IS available the gate cross-checks the file and
// refuses a baseline that grew. Regenerate with `pnpm i18n:baseline`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { legacyRevision, pluginBaselineRevisions, portugueseText } from './i18n-baseline-shared.mjs'

const root = process.cwd()
const out = resolve(root, 'docs/inventory/i18n-legacy-literals.json')

function literalsAt(repoPath, revision) {
  try {
    const source = execFileSync('git', ['show', `${revision}:${repoPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true, extname(repoPath) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const found = new Set()
    const collect = node => {
      const raw = node.getText(sourceFile)
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && portugueseText(raw)) found.add(raw)
      ts.forEachChild(node, collect)
    }
    collect(sourceFile)
    return [...found].sort()
  } catch { return [] }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'i18n' || entry.name === 'tests' ? [] : walk(path)
    return /\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

const roots = [resolve(root, 'apps/studio-web/src')]
for (const plugin of readdirSync(resolve(root, 'plugins'), { withFileTypes: true })) {
  const source = resolve(root, 'plugins', plugin.name, 'src')
  try { if (plugin.isDirectory() && statSync(source).isDirectory()) roots.push(source) } catch { /* no src/ */ }
}

const files = {}
for (const sourceRoot of roots) {
  for (const path of walk(sourceRoot)) {
    const repoPath = relative(root, path).replaceAll('\\', '/')
    const isPlugin = path.includes(`${sep}plugins${sep}`)
    // The legacy revision applies to every file the gate may scan without strict mode,
    // plugins included — computing it only for the interface made the file disagree with Git.
    const legacy = literalsAt(repoPath, legacyRevision)
    const plugins = isPlugin ? [...new Set(pluginBaselineRevisions().flatMap(revision => literalsAt(repoPath, revision)))].sort() : []
    if (legacy.length > 0 || plugins.length > 0) files[repoPath] = { ...(legacy.length > 0 ? { legacy } : {}), ...(plugins.length > 0 ? { plugins } : {}) }
  }
}

mkdirSync(resolve(root, 'docs/inventory'), { recursive: true })
const document = {
  note: 'Literais em português que já existiam quando o gate de i18n passou a varrer cada raiz. Gerado por `pnpm i18n:baseline`; o gate usa este arquivo quando não há histórico Git (artefato de release) e, quando há, recusa qualquer entrada que o Git não confirme.',
  legacyRevision,
  pluginBaselines: pluginBaselineRevisions(),
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
}
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
process.stdout.write(`I18N_BASELINE=WRITTEN files=${String(Object.keys(files).length)} ${relative(root, out)}\n`)
