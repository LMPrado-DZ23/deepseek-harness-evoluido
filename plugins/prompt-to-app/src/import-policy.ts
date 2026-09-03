import { posix } from 'node:path'
import ts from 'typescript'
import type { GeneratedFile } from './generator.js'
import { GeneratedFileRejectedError } from './generator.js'
import { t } from './i18n.js'

const ALLOWED_MODULES = new Set([
  'react', 'react/jsx-runtime', 'next/link', 'next/navigation',
  'react-hook-form', '@hookform/resolvers/zod', 'zod',
  '@/src/components/generated', '@/components/generated',
  '@/src/lib/utils', '@/lib/utils',
])
const ALLOWED_PREFIXES = [
  '@/src/server/repositories/', '@/server/repositories/',
  '@/src/components/generated/', '@/components/generated/',
  '@/src/components/ui/', '@/components/ui/',
] as const

export function assertGeneratedImports(files: readonly GeneratedFile[]): void {
  const generatedPaths = new Set(files.map(file => normalizePath(file.path)))
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/u.test(file.path)) continue
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.path))
    visit(source, moduleName => assertAllowedModule(file.path, moduleName, generatedPaths))
  }
}

function visit(source: ts.SourceFile, inspect: (moduleName: string | undefined) => void): void {
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

function assertAllowedModule(fromPath: string, moduleName: string | undefined, generatedPaths: ReadonlySet<string>): void {
  if (moduleName === undefined) throw rejected(fromPath, '<dinâmico>')
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

function normalizePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/\.(?:[cm]?[jt]sx?)$/u, '')
}

function safeSuffix(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.split('/').some(part => part === '' || part === '.' || part === '..')
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/u.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/u.test(path)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/u.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}
