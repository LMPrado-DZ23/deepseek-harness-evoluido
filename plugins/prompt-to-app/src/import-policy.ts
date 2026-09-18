import { posix } from 'node:path'
import ts from 'typescript'
import type { GeneratedFile } from './generator.js'
import { GeneratedFileRejectedError, validateGeneratedPath } from './generator.js'
import { prompt, t } from './i18n.js'

const ALLOWED_MODULES = new Set([
  'react', 'next/link', 'next/navigation',
  'react-hook-form', '@hookform/resolvers/zod', 'zod',
  '@/src/components/generated', '@/components/generated',
  '@/src/lib/utils', '@/lib/utils',
])
const ALLOWED_PREFIXES = [
  '@/src/server/repositories/', '@/server/repositories/',
  '@/src/components/generated/', '@/components/generated/',
  '@/src/components/ui/', '@/components/ui/',
] as const
const FORBIDDEN_GLOBALS = new Set([
  'process', 'global', 'globalThis', 'window', 'self', 'document', 'frames', 'top', 'parent',
  'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'module', 'exports', 'require', '__dirname', '__filename', 'Bun', 'Deno',
  'Reflect', 'eval', 'Function',
])
const FORBIDDEN_NETWORK_APIS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'])
const FORBIDDEN_ESCAPE_PROPERTIES = new Set(['constructor', '__proto__', 'prototype'])
const FORBIDDEN_ELEMENT_FACTORIES = new Set(['createElement', 'jsx', 'jsxs', 'jsxDEV'])
const FORBIDDEN_JSX_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'base', 'meta',
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect', 'text', 'title',
])
const SAFE_INTRINSIC_JSX_TAGS = new Set([
  'a', 'article', 'aside', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'col', 'colgroup',
  'dd', 'details', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input', 'label', 'legend',
  'li', 'main', 'mark', 'nav', 'ol', 'option', 'p', 'picture', 'pre', 'section', 'select', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'tr', 'u', 'ul',
])
const FORBIDDEN_JSX_ATTRIBUTES = new Set(['dangerouslysetinnerhtml', 'srcdoc', 'style'])
const URL_JSX_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'xlinkhref',
  'srcset', 'ping', 'background', 'cite', 'longdesc',
])
const URL_CANDIDATE_LIST_ATTRIBUTES = new Set(['srcset'])
const URL_WHITESPACE_LIST_ATTRIBUTES = new Set(['ping'])
const URL_IGNORED_CODE_POINTS = /[\u0000-\u0020]/gu
const HTTPS_URL = /^https:\/\//iu
const FIXED_COMPONENT_PATHS = [
  'src/components/generated', 'components/generated',
  'src/components/ui', 'components/ui',
] as const

export function assertGeneratedSource(files: readonly GeneratedFile[]): void {
  const validated = files.map(file => ({ ...file, path: validateGeneratedPath(file.path) }))
  const generatedPaths = new Set(validated.map(file => normalizePath(file.path)))
  for (const file of validated) {
    if (!/\.[cm]?[jt]sx?$/u.test(file.path.toLowerCase())) continue
    if (isFixedComponentPath(normalizePath(file.path))) throw rejectedSource(file.path, 'reserved Studio component path')
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.path))
    visitImports(source, moduleName => assertAllowedModule(file.path, moduleName, generatedPaths))
    assertNoServerOrUnsafeSource(file.path, source, generatedPaths)
  }
}

export const assertGeneratedImports = assertGeneratedSource

function visitImports(source: ts.SourceFile, inspect: (moduleName: string | undefined) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) inspect(literalModule(node.moduleSpecifier))
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspect(literalModule(node.moduleReference.expression as ts.Expression))
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      inspect(node.arguments.length === 1 ? literalModule(node.arguments[0]!) : undefined)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
}

function assertNoServerOrUnsafeSource(path: string, source: ts.SourceFile, generatedPaths: ReadonlySet<string>): void {
  const importedJsxBindings = importedBindings(source, generatedPaths)
  const walk = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use server') throw rejectedSource(path, 'use server')
    if (ts.isIdentifier(node) && !isPropertyLabel(node) && (FORBIDDEN_GLOBALS.has(node.text) || FORBIDDEN_NETWORK_APIS.has(node.text))) throw rejectedSource(path, node.text)
    if (ts.isIdentifier(node) && FORBIDDEN_ELEMENT_FACTORIES.has(node.text) && !isPropertyLabel(node)) throw rejectedSource(path, node.text)
    if (ts.isImportSpecifier(node) && FORBIDDEN_ELEMENT_FACTORIES.has((node.propertyName ?? node.name).text)) throw rejectedSource(path, (node.propertyName ?? node.name).text)
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_NETWORK_APIS.has(node.name.text)) throw rejectedSource(path, node.name.text)
    const elementName = ts.isElementAccessExpression(node) ? staticPropertyName(node.argumentExpression) : undefined
    if (ts.isElementAccessExpression(node) && elementName === undefined) throw rejectedSource(path, 'dynamic property access')
    if (elementName !== undefined && FORBIDDEN_NETWORK_APIS.has(elementName)) throw rejectedSource(path, elementName)
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_ELEMENT_FACTORIES.has(node.name.text)) throw rejectedSource(path, node.name.text)
    if (elementName !== undefined && FORBIDDEN_ELEMENT_FACTORIES.has(elementName)) throw rejectedSource(path, elementName)
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_ESCAPE_PROPERTIES.has(node.name.text)) throw rejectedSource(path, node.name.text)
    if (elementName !== undefined && FORBIDDEN_ESCAPE_PROPERTIES.has(elementName)) throw rejectedSource(path, elementName)
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) throw rejectedSource(path, 'import.meta')
    if (ts.isCallExpression(node) && factoryName(node.expression) !== undefined && FORBIDDEN_ELEMENT_FACTORIES.has(factoryName(node.expression)!)) throw rejectedSource(path, factoryName(node.expression)!)
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      const normalizedName = normalizeJsxAttributeName(name)
      if (/^on/iu.test(name) || name === 'ref') throw rejectedSource(path, `interactive JSX attribute ${name}`)
      if (FORBIDDEN_JSX_ATTRIBUTES.has(normalizedName)) throw rejectedSource(path, name)
      if (URL_JSX_ATTRIBUTES.has(normalizedName)) {
        const value = staticJsxAttributeValue(node)
        if (value === undefined) throw rejectedSource(path, `dynamic URL attribute ${name}`)
        const candidates = URL_CANDIDATE_LIST_ATTRIBUTES.has(normalizedName)
          ? splitCandidateList(value)
          : URL_WHITESPACE_LIST_ATTRIBUTES.has(normalizedName) ? splitWhitespaceList(value) : [value]
        for (const candidate of candidates) {
          if (!isSafeStaticUrl(candidate)) throw rejectedSource(path, `unsafe URL attribute ${name}`)
        }
      }
    }
    if (ts.isJsxSpreadAttribute(node)) throw rejectedSource(path, 'JSX spread attribute')
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source)
      if (!ts.isIdentifier(node.tagName)) throw rejectedSource(path, `compound JSX tag ${tag}`)
      if (FORBIDDEN_JSX_TAGS.has(tag)) throw rejectedSource(path, `<${tag}>`)
      if (tag === tag.toLowerCase() && !SAFE_INTRINSIC_JSX_TAGS.has(tag)) throw rejectedSource(path, `unknown JSX tag ${tag}`)
      if (tag !== tag.toLowerCase() && !importedJsxBindings.has(tag)) throw rejectedSource(path, `dynamic JSX tag ${tag}`)
    }
    ts.forEachChild(node, walk)
    if (ts.isTaggedTemplateExpression(node)) throw rejectedSource(path, 'tagged template call')
    if (ts.isCallExpression(node)) throw rejectedSource(path, 'runtime call')
    if (ts.isNewExpression(node)) throw rejectedSource(path, 'runtime constructor')
  }
  walk(source)
}

function isSafeStaticUrl(value: string): boolean {
  // JSX compilers decode character references in quoted attributes before the
  // value reaches the DOM. Refuse them at this trust boundary so an apparently
  // local path such as `/&#47;host` cannot become `//host` after compilation.
  if (value.includes('&')) return false
  if (value.includes('\\')) return false
  const normalized = value.replace(URL_IGNORED_CODE_POINTS, '')
  if (normalized === '' || normalized.startsWith('#') || normalized.startsWith('./')) return true
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return true
  return HTTPS_URL.test(normalized)
}

function splitCandidateList(value: string): string[] {
  // String#split always returns at least one item; avoid an impossible fallback
  // branch so the security-critical policy remains fully covered.
  return value.split(',').map(part => part.trim().split(/\s+/u)[0] as string).filter(part => part !== '')
}

function splitWhitespaceList(value: string): string[] {
  return value.trim().split(/\s+/u).filter(part => part !== '')
}

function normalizeJsxAttributeName(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function importedBindings(source: ts.SourceFile, generatedPaths: ReadonlySet<string>): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue
    const moduleName = literalModule(statement.moduleSpecifier)
    if (moduleName === undefined || !trustedJsxModule(moduleName) || aliasTargetsGeneratedFile(moduleName, generatedPaths)) continue
    if (statement.importClause.isTypeOnly) continue
    if (statement.importClause.name !== undefined) names.add(statement.importClause.name.text)
    if (moduleName === 'next/link') continue
    const bindings = statement.importClause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
    else for (const element of bindings.elements) if (!element.isTypeOnly) names.add(element.name.text)
  }
  return names
}

function trustedJsxModule(moduleName: string): boolean {
  return moduleName === 'next/link'
    || moduleName === '@/src/components/generated'
    || moduleName === '@/components/generated'
}

function aliasTargetsGeneratedFile(moduleName: string, generatedPaths: ReadonlySet<string>): boolean {
  if (!moduleName.startsWith('@/')) return false
  const target = normalizePath(moduleName.slice(2))
  return generatedPaths.has(target) || generatedPaths.has(`${target}/index`)
}

function isFixedComponentPath(path: string): boolean {
  const folded = path.toLowerCase()
  return FIXED_COMPONENT_PATHS.some(prefix => folded === prefix || folded.startsWith(`${prefix}/`))
}

function factoryName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return staticPropertyName(node.argumentExpression)
  return undefined
}

function staticJsxAttributeValue(node: ts.JsxAttribute): string | undefined {
  if (node.initializer === undefined) return ''
  if (ts.isStringLiteral(node.initializer)) return node.initializer.text
  if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) return staticPropertyName(node.initializer.expression)
  return undefined
}

function staticPropertyName(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNumericLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return staticPropertyName(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPropertyName(node.left)
    const right = staticPropertyName(node.right)
    return left === undefined || right === undefined ? undefined : left + right
  }
  return undefined
}

function isPropertyLabel(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node) return !ts.isShorthandPropertyAssignment(parent)
  return false
}

function assertAllowedModule(fromPath: string, moduleName: string | undefined, generatedPaths: ReadonlySet<string>): void {
  if (moduleName === undefined) throw rejected(fromPath, t('values.dynamicImport'))
  if (ALLOWED_MODULES.has(moduleName) || ALLOWED_PREFIXES.some(prefix => moduleName.startsWith(prefix) && safeSuffix(moduleName.slice(prefix.length)))) return
  if (moduleName.startsWith('.')) {
    const target = normalizePath(posix.join(posix.dirname(fromPath), moduleName))
    const candidates = [target, `${target}/index`]
    if (candidates.some(candidate => generatedPaths.has(candidate))) return
  }
  throw rejected(fromPath, moduleName)
}

function literalModule(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined
}

function rejected(path: string, moduleName: string): GeneratedFileRejectedError {
  return new GeneratedFileRejectedError(t('errors.generatedImport', { path, module: moduleName }))
}

function rejectedSource(path: string, construct: string): GeneratedFileRejectedError {
  return new GeneratedFileRejectedError(t('errors.generatedSource', { path, construct }))
}

function normalizePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/\.(?:[cm]?[jt]sx?)$/iu, '')
}

function safeSuffix(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !/[\\?#\u0000-\u001f\u007f]/u.test(value)
    && !value.split('/').some(part => part === '' || part === '.' || part === '..')
}

function scriptKind(path: string): ts.ScriptKind {
  const normalizedPath = path.toLowerCase()
  if (/\.tsx$/u.test(normalizedPath)) return ts.ScriptKind.TSX
  if (/\.jsx$/u.test(normalizedPath)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/u.test(normalizedPath)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * AS REGRAS QUE SERAO APLICADAS, DITAS AO GERADOR (T-10).
 *
 * Elas eram escritas DUAS VEZES: uma como prosa no catalogo de prompts, outra
 * como constante aqui. As duas listas nao conversavam — um modulo acrescentado
 * a `ALLOWED_MODULES` nunca chegava ao prompt, e uma tag acrescentada a
 * `FORBIDDEN_JSX_TAGS` tambem nao. O gerador continuava chutando e sendo
 * recusado, e cada chute custava uma tentativa inteira.
 *
 * Segunda verdade classica: duas descricoes do mesmo fato, que divergem no
 * primeiro conserto de uma delas — e aqui a que diverge em silencio e
 * justamente a que o modelo le.
 *
 * A prosa continua no catalogo (o portao de i18n exige), mas ela recebe A LISTA
 * como parametro. Existe UMA lista, e ela e a que recusa.
 */
/**
 * AS MESMAS REGRAS, DITAS A QUEM PLANEJA (T-10, segunda metade).
 *
 * O gerador precisa saber COMO escrever; o planejador precisa saber O QUE
 * PODE PROMETER. São duas frases diferentes sobre a mesma lista, e por isso
 * elas saem da mesma lista.
 *
 * O buraco era concreto e caro: nada impedia o plano de prometer "busca o
 * endereço pelo CEP" ou "manda um e-mail de confirmação". A pessoa lia isso,
 * APROVAVA, e só na criação o construtor recusava `fetch` — gastando tentativa
 * atrás de tentativa num plano que ele nunca poderia satisfazer. Quem pagava
 * era quem não programa: ela aprovou uma promessa que o sistema já sabia ser
 * impossível quando a mostrou.
 *
 * NÃO é uma cópia amigável das regras do gerador: repetir "importe somente
 * destes módulos" para quem escreve título e critério de aceite seria ruído
 * que empurra a evidência para fora do teto. O que o planejador recebe é a
 * CONSEQUÊNCIA — o que o aplicativo gerado consegue e não consegue fazer.
 * @returns as regras de planejamento, em português.
 */
export function planningRules(): readonly string[] {
  // Derivada da MESMA constante que RECUSA no gerador. Escrever "sem rede" à
  // mão aqui recriaria a segunda verdade que a `generationRules` acabou de
  // fechar: no dia em que a lista mudar, esta frase muda junto.
  const network = [...FORBIDDEN_NETWORK_APIS].sort()
  return [
    prompt('prompts.planNoNetwork', { apis: network.join(', ') }),
    prompt('prompts.planLocalOnly'),
  ]
}

export function generationRules(): readonly string[] {
  const modules = [...ALLOWED_MODULES].sort()
  const prefixes = [...ALLOWED_PREFIXES].sort()
  const tags = [...FORBIDDEN_JSX_TAGS].sort()
  const attributes = [...FORBIDDEN_JSX_ATTRIBUTES].sort()
  const globals = [...FORBIDDEN_GLOBALS, ...FORBIDDEN_NETWORK_APIS].sort()
  return [
    prompt('prompts.ruleModules', { modules: modules.join(', '), prefixes: prefixes.join(', ') }),
    prompt('prompts.ruleTags', { tags: tags.join(', ') }),
    prompt('prompts.ruleAttributes', { attributes: attributes.join(', ') }),
    prompt('prompts.ruleGlobals', { globals: globals.join(', ') }),
    prompt('prompts.ruleUrls'),
  ]
}
