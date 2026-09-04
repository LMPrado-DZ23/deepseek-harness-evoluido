import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const catalogPath = resolve(root, 'apps/studio-web/src/i18n/pt-BR.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const serverCatalog = JSON.parse(readFileSync(resolve(root, 'plugins/prompt-to-app/i18n/pt-BR.json'), 'utf8'))
const previewCatalog = JSON.parse(readFileSync(resolve(root, 'plugins/preview/i18n/pt-BR.json'), 'utf8'))
const LEGACY_PLUGIN_BASELINE = '61c96039cc506d13c1da9b053c5003a115f075cc'
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
for (const extra of ['apps/studio-web/src/i18n/pwa.pt-BR.json', 'apps/studio-web/src/i18n/hub.pt-BR.json', 'apps/studio-web/public/manifest.json']) {
  const full = resolve(root, extra)
  if (!exists(full)) continue
  for (const [path, value] of flatten(JSON.parse(readFileSync(full, 'utf8')))) {
    if (/\bpront[oa]s?\b/iu.test(value)) failures.push(`alegação de prontidão proibida em ${extra}:${path}`)
  }
}
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
// Plugin literals that already existed when the gate started scanning plugins (M5, base c0aeb53) are
// grandfathered and COUNTED, never silently accepted: the count must go down, never up, and is printed.
const PLUGIN_BASELINE = 'c0aeb53'
const grandfatheredHits = []
for (const sourceRoot of sourceRoots) for (const file of walk(sourceRoot.path)) scanSource(file, sourceRoot.strict, sourceRoot.path.includes(`${sep}plugins${sep}`) ? PLUGIN_BASELINE : undefined)
if (directText.length > 0) failures.push(`texto pt-BR fora do catálogo: ${directText.join(' | ')}`)
const cssText = [...styles.matchAll(/content\s*:\s*['"]([^'"]+)['"]/gu)].map(match => match[1].trim()).filter(Boolean)
if (cssText.length > 0) failures.push(`texto visível no CSS fora do catálogo: ${cssText.join(' | ')}`)

if (failures.length > 0) {
  process.stderr.write(`I18N_GATE=FAIL\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(`I18N_GATE=PASS locale=pt-BR keys=${flatten(catalog).length + flatten(serverCatalog).length + flatten(previewCatalog).length} plugin_literals_grandfathered=${grandfatheredHits.length}\n`)
if (grandfatheredHits.length > 0) process.stdout.write(`- pendentes de migração para catálogo (base ${PLUGIN_BASELINE}, não podem crescer):\n  ${grandfatheredHits.join('\n  ')}\n`)

function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

function scanSource(path, strict, baseline) {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const grandfathered = strict ? new Set() : legacyPortugueseLiterals(path, 'ab0fe506928dacd736262a024d202f3e96e2689d')
  const baselineLiterals = baseline === undefined ? new Set() : legacyPortugueseLiterals(path, baseline)
  visit(sourceFile, sourceFile, path, grandfathered, baselineLiterals)
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

function portugueseText(value) {
  return /[áéíóúàâêôãõç]/iu.test(value) || /\b(projeto|plano|criação|verificação|pergunta|serviços|diretório|arquivo|modelo|confirmação|solicitação|produza|caminhos|gere)\b/iu.test(value)
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

function legacyPortugueseLiterals(path, revision) {
  const repoPath = relative(root, path).replaceAll('\\', '/')
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
  } catch { return new Set() }
}

function pluginExistedAtLegacyBaseline(name) {
  try {
    execFileSync('git', ['cat-file', '-e', `${LEGACY_PLUGIN_BASELINE}:plugins/${name}/src`], { cwd: root, stdio: 'ignore' })
    return true
  } catch { return false }
}
