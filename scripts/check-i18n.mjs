import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const catalogPath = resolve(root, 'apps/studio-web/src/i18n/pt-BR.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const serverCatalog = JSON.parse(readFileSync(resolve(root, 'plugins/prompt-to-app/i18n/pt-BR.json'), 'utf8'))
const appSource = readFileSync(resolve(root, 'apps/studio-web/src/App.tsx'), 'utf8')
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

const expectedSteps = ['Ideia', 'Perguntas', 'Plano', 'Criação', 'Verificação']
const actualSteps = ['idea', 'questions', 'plan', 'creation', 'verification'].map(key => catalog.progress[key])
if (JSON.stringify(actualSteps) !== JSON.stringify(expectedSteps)) failures.push('ordem visível das etapas foi alterada')

for (const [path, value] of flatten(catalog)) {
  if (/\bpront[oa]s?\b/iu.test(value)) failures.push(`alegação de prontidão proibida em ${path}`)
}
for (const [path, value] of flatten(serverCatalog)) {
  if (/\bpront[oa]s?\b/iu.test(value)) failures.push(`alegação de prontidão proibida no servidor em ${path}`)
}
if (/['"](?:READY|DONE|PUBLISHED|DEPLOYED)['"]/u.test(modelSource)) failures.push('estado absoluto proibido na máquina de estados')
if (!appSource.includes('permanentTruthKind(state)')) failures.push('aviso permanente não está condicionado ao estado real')

const sourceFile = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const directText = []
visit(sourceFile)
if (directText.length > 0) failures.push(`texto visível fora do catálogo: ${directText.join(' | ')}`)
const cssText = [...styles.matchAll(/content\s*:\s*['"]([^'"]+)['"]/gu)].map(match => match[1].trim()).filter(Boolean)
if (cssText.length > 0) failures.push(`texto visível no CSS fora do catálogo: ${cssText.join(' | ')}`)

if (failures.length > 0) {
  process.stderr.write(`I18N_GATE=FAIL\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(`I18N_GATE=PASS locale=pt-BR keys=${flatten(catalog).length + flatten(serverCatalog).length}\n`)

function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

function visit(node) {
  if (node.kind === ts.SyntaxKind.JsxText && /[\p{L}\p{N}]/u.test(node.text)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    directText.push(`linha ${line + 1}: ${node.text.trim()}`)
  }
  ts.forEachChild(node, visit)
}
