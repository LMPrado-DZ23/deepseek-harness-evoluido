import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { legacyRevision, pluginBaselineRevisions, portugueseText } from './i18n-baseline-shared.mjs'
import { scanReadinessClaims } from './i18n-readiness.mjs'

const root = process.cwd()
const catalogPath = resolve(root, 'apps/studio-web/src/i18n/pt-BR.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const serverCatalog = JSON.parse(readFileSync(resolve(root, 'plugins/prompt-to-app/i18n/pt-BR.json'), 'utf8'))
const previewCatalog = JSON.parse(readFileSync(resolve(root, 'plugins/preview/i18n/pt-BR.json'), 'utf8'))
const styles = readFileSync(resolve(root, 'apps/studio-web/src/styles.css'), 'utf8')
const modelSource = readFileSync(resolve(root, 'plugins/prompt-to-app/src/model.ts'), 'utf8')

const required = [
  'brand', 'nav.home', 'nav.projects', 'nav.progress', 'nav.result',
  'idea.title', 'idea.subtitle', 'idea.placeholder', 'idea.continue',
  'questions.title', 'questions.recommend', 'plan.title', 'plan.approve', 'plan.change', 'plan.revision',
  'creation.title', 'creation.start', 'verification.title', 'verification.success',
  'privacy.localNotice', 'privacy.routeNoticeStart', 'privacy.routeNoticeEnd', 'privacy.routeUnavailable',
  'progress.idea', 'progress.questions', 'progress.plan', 'progress.creation', 'progress.verification',
  'truth.idea', 'truth.creation', 'truth.verified', 'mobile.subtitle',
]
const failures = []
for (const path of required) {
  const value = path.split('.').reduce((current, key) => current?.[key], catalog)
  if (typeof value !== 'string' || value.trim() === '') failures.push(`chave ausente ou vazia: ${path}`)
}
for (const path of ['questions.audience', 'questions.goal', 'questions.content', 'questions.sensitive', 'errors.notFound', 'errors.crossTenant', 'pipeline.verified']) {
  const value = path.split('.').reduce((current, key) => current?.[key], serverCatalog)
  if (typeof value !== 'string' || value.trim() === '') failures.push(`chave de servidor ausente ou vazia: ${path}`)
}
for (const [path, value] of flatten(previewCatalog)) {
  if (typeof value !== 'string' || value.trim() === '') failures.push(`chave de prévia ausente ou vazia: ${path}`)
}

const expectedSteps = ['Ideia', 'Perguntas', 'Plano', 'Criação', 'Verificação']
const actualSteps = ['idea', 'questions', 'plan', 'creation', 'verification'].map(key => catalog.progress[key])
if (JSON.stringify(actualSteps) !== JSON.stringify(expectedSteps)) failures.push('ordem visível das etapas foi alterada')

for (const [path, value] of flatten(catalog)) {
  if (/\bpront[oa]s?\b/iu.test(value)) failures.push(`alegação de prontidão proibida em ${path}`)
}
for (const [path, value] of flatten(serverCatalog)) {
  if (/\bpront[oa]s?\b/iu.test(value)) failures.push(`alegação de prontidão proibida no servidor em ${path}`)
}
// Every extra catalogue — and every plugin's own — is read, and a missing one is a failure instead
// of a silently skipped item (see scripts/i18n-readiness.mjs). The count is printed as evidence.
const readiness = scanReadinessClaims(root)
failures.push(...readiness.failures)
if (/['"](?:READY|DONE|PUBLISHED|DEPLOYED)['"]/u.test(modelSource)) failures.push('estado absoluto proibido na máquina de estados')
const appSource = readFileSync(resolve(root, 'apps/studio-web/src/App.tsx'), 'utf8')
if (!appSource.includes('permanentTruthKind(state)')) failures.push('aviso permanente não está condicionado ao estado real')

const directText = []
const sourceRoots = [{ path: resolve(root, 'apps/studio-web/src'), strict: true }]
for (const plugin of readdirSync(resolve(root, 'plugins'), { withFileTypes: true })) {
  // `exists` answers for files only; a source ROOT is a directory, so it needs its own check — with `exists` here no plugin was ever scanned.
  if (plugin.isDirectory() && isDirectory(resolve(root, 'plugins', plugin.name, 'src'))) sourceRoots.push({
    path: resolve(root, 'plugins', plugin.name, 'src'),
    strict: exists(resolve(root, 'plugins', plugin.name, 'i18n', 'pt-BR.json')) && !pluginExistedAtLegacyBaseline(plugin.name),
  })
}
// Plugin literals that already existed when the gate started scanning plugins (M5) are grandfathered
// and COUNTED, never silently accepted: the count must go down, never up, and is printed. Baselines are
// the tips of the branches that existed before the gate: c0aeb53 (Claude M3/M4 stack) plus whatever the
// integrator lists in DZ23_I18N_PLUGIN_BASELINES (comma-separated revisions, e.g. the M1 branch tip) or
// appends to this array when merging. A revision unknown to this clone is skipped, never an error.
const PLUGIN_BASELINES = pluginBaselineRevisions()
/**
 * The versioned baseline (docs/inventory/i18n-legacy-literals.json, written by
 * `pnpm i18n:baseline`). Without it the gate can only run inside a Git clone —
 * on a release artifact every legacy literal would come back as new and the gate
 * would fail for the wrong reason. It is never allowed to be MORE permissive
 * than the history: where Git answers, a baseline entry the history does not
 * confirm is a failure, so the file cannot be used to grandfather new text.
 */
const baselineFile = readBaselineFile()
const inflatedBaseline = []
const grandfatheredHits = []
for (const sourceRoot of sourceRoots) for (const file of walk(sourceRoot.path)) scanSource(file, sourceRoot.strict, sourceRoot.path.includes(`${sep}plugins${sep}`) ? PLUGIN_BASELINES : undefined)
if (directText.length > 0) failures.push(`texto pt-BR fora do catálogo: ${directText.join(' | ')}`)
if (inflatedBaseline.length > 0) failures.push(`baseline de i18n contém literal que o histórico não confirma (rode \`pnpm i18n:baseline\`): ${inflatedBaseline.join(' | ')}`)
if (baselineFile === undefined && !hasGitHistory()) failures.push('sem histórico Git e sem docs/inventory/i18n-legacy-literals.json: rode `pnpm i18n:baseline` no repositório e versione o arquivo')
// "cannot grow" was printed but never checked: the ceiling is what the baseline file records.
const baselineCeiling = baselineFile === undefined
  ? undefined
  : Object.values(baselineFile.files ?? {}).reduce((total, entry) => total + (entry.plugins?.length ?? 0), 0)
if (baselineCeiling !== undefined && grandfatheredHits.length > baselineCeiling) {
  failures.push(`literais herdados cresceram (${String(grandfatheredHits.length)} > ${String(baselineCeiling)}): migre para o catálogo em vez de aumentar o baseline`)
}
const cssText = [...styles.matchAll(/content\s*:\s*['"]([^'"]+)['"]/gu)].map(match => match[1].trim()).filter(Boolean)
if (cssText.length > 0) failures.push(`texto visível no CSS fora do catálogo: ${cssText.join(' | ')}`)

if (failures.length > 0) {
  process.stderr.write(`I18N_GATE=FAIL\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(`I18N_GATE=PASS locale=pt-BR catalogs=${readiness.scanned.length} keys=${flatten(catalog).length + flatten(serverCatalog).length + flatten(previewCatalog).length} plugin_literals_grandfathered=${grandfatheredHits.length} baseline=${baselineFile === undefined ? 'git' : 'file'}\n`)
if (grandfatheredHits.length > 0) process.stdout.write(`- pendentes de migração para catálogo (bases ${PLUGIN_BASELINES.join(',')}, não podem crescer):\n  ${grandfatheredHits.join('\n  ')}\n`)

function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

function scanSource(path, strict, baselines) {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const grandfathered = strict ? new Set() : resolveBaseline(path, 'legacy', [legacyRevision])
  const baselineLiterals = baselines === undefined ? new Set() : resolveBaseline(path, 'plugins', baselines)
  visit(sourceFile, sourceFile, path, grandfathered, baselineLiterals)
}

/**
 * The literals grandfathered for one file and one kind. The file is the source
 * of truth (it also works without history); Git, when it answers, is the check:
 * anything in the file that the history does not confirm is reported, so the
 * baseline can shrink but never grow by editing JSON.
 */
function resolveBaseline(path, kind, revisions) {
  const repoPath = relative(root, path).replaceAll('\\', '/')
  const fromFile = new Set(baselineFile?.files?.[repoPath]?.[kind] ?? [])
  // `undefined` = this clone cannot answer for that revision; an EMPTY SET = the history answered
  // and the file had no such literal. Collapsing the two let a baseline entry for a file that never
  // existed pass unchecked — which is exactly how new untranslated text could be grandfathered in.
  const answers = revisions.map(revision => legacyPortugueseLiterals(path, revision))
  if (answers.every(answer => answer === undefined)) return fromFile
  const fromGit = new Set(answers.flatMap(answer => [...(answer ?? [])]))
  for (const literal of fromFile) {
    if (!fromGit.has(literal)) inflatedBaseline.push(`${repoPath}:${literal.slice(0, 60)}`)
  }
  return baselineFile === undefined ? fromGit : new Set([...fromFile].filter(literal => fromGit.has(literal)))
}

function readBaselineFile() {
  try { return JSON.parse(readFileSync(resolve(root, 'docs/inventory/i18n-legacy-literals.json'), 'utf8')) } catch { return undefined }
}

function visit(node, sourceFile, path, grandfathered, baselineLiterals) {
  if (node.kind === ts.SyntaxKind.JsxText && /[\p{L}\p{N}]/u.test(node.text)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    directText.push(`${basename(path)}:${line + 1}:${node.text.trim()}`)
  }
  const raw = node.getText(sourceFile)
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && portugueseText(raw) && !grandfathered.has(raw)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const hit = `${basename(path)}:${line + 1}:${node.getText(sourceFile).slice(0, 80)}`
    if (baselineLiterals.has(raw)) grandfatheredHits.push(hit); else directText.push(hit)
  }
  ts.forEachChild(node, child => visit(child, sourceFile, path, grandfathered, baselineLiterals))
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'i18n' || entry.name === 'tests' ? [] : walk(path)
    return /\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

function exists(path) {
  try { statSync(path); return true } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Literals of one file at one revision, or `undefined` when this clone cannot answer for it. */
function legacyPortugueseLiterals(path, revision) {
  const repoPath = relative(root, path).replaceAll('\\', '/')
  // A revision this clone does not have is "cannot answer"; a file missing AT a revision it does
  // have is an answer — the empty set — and must be treated as one.
  try { execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, stdio: 'ignore' }) } catch { return undefined }
  try {
    const source = execFileSync('git', ['show', `${revision}:${repoPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true, extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const found = new Set()
    const collect = node => {
      const raw = node.getText(sourceFile)
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && portugueseText(raw)) found.add(raw)
      ts.forEachChild(node, collect)
    }
    collect(sourceFile)
    return found
  } catch { return new Set() } // the revision exists and the file was not in it: an answer, not a shrug
}

function hasGitHistory() {
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' }); return true } catch { return false }
}
