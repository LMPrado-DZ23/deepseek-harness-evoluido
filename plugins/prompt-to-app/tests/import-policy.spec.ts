import { describe, expect, it } from 'vitest'
import { GeneratedFileRejectedError } from '../src/generator.js'
import { assertGeneratedImports, assertGeneratedSource } from '../src/import-policy.js'

describe('generated import policy', () => {
  it('accepts only public UI utilities, repositories and other generated files', () => {
    expect(() => assertGeneratedImports([
      { path: 'src/Card.tsx', content: "import Link from 'next/link'; export const Card = () => <Link href='/'>Início</Link>" },
      { path: 'src/Page.tsx', content: "export { Card } from './Card'; export { ClienteRepository } from '@/server/repositories/cliente'; import { cn } from '@/lib/utils'" },
      { path: 'src/Form.tsx', content: "import { z } from 'zod'; import { Button } from '@/src/components/ui/button'; void z; void Button" },
    ])).not.toThrow()
  })

  it.each([
    ["import { readFile } from 'node:fs'", 'node:fs'],
    ["import { openDatabase } from '@/src/db/client'", '@/src/db/client'],
    ["const name = 'node:fs'; import(name)", '<dinâmico>'],
    ["const fs = require('node:fs')", 'node:fs'],
    ["import item = require('node:fs')", 'node:fs'],
    ["export * from 'child_process'", 'child_process'],
    ["import { hidden } from '../hidden'", '../hidden'],
  ])('rejects a forbidden dependency as GENERATED_FILE_REJECTED: %s', (content, moduleName) => {
    expect(() => assertGeneratedImports([{ path: 'src/Generated.tsx', content }])).toThrow(GeneratedFileRejectedError)
    expect(() => assertGeneratedImports([{ path: 'src/Generated.tsx', content }])).toThrow(moduleName)
  })

  it('ignores non-code assets and rejects malformed module suffixes', () => {
    expect(() => assertGeneratedImports([{ path: 'content/app.json', content: '{"import":"node:fs"}' }])).not.toThrow()
    expect(() => assertGeneratedImports([{ path: 'src/a.ts', content: "import x from '@/server/repositories/../secret'" }])).toThrow(GeneratedFileRejectedError)
  })

  it('covers JavaScript variants, local index files and exports without a module', () => {
    expect(() => assertGeneratedImports([
      { path: 'src/widget/index.tsx', content: 'export const Widget = () => null' },
      { path: 'src/main.jsx', content: "import React from 'react'; export {}; import('./widget'); void React" },
      { path: 'src/legacy.mjs', content: "const React = require('react'); void React" },
      { path: 'src/module.cjs', content: "const React = require('react'); void React" },
    ])).not.toThrow()
    expect(() => assertGeneratedImports([{ path: 'src/a.ts', content: 'require()' }])).toThrow('<dinâmico>')
    expect(() => assertGeneratedImports([{ path: 'src/a.ts', content: 'import item = require()' }])).toThrow('<dinâmico>')
  })

  it.each([
    '@/server/repositories/', '@/server/repositories//item', '@/server/repositories/./item',
    '@/server/repositories/../item', '@/src/components/ui//button',
  ])('rejects unsafe allowlist suffix: %s', moduleName => {
    expect(() => assertGeneratedImports([{ path: 'src/a.ts', content: `import value from ${JSON.stringify(moduleName)}` }])).toThrow(GeneratedFileRejectedError)
  })

  it('accepts every explicit protected facade prefix with a safe suffix', () => {
    expect(() => assertGeneratedImports([{ path: 'src/a.ts', content: [
      "import a from '@/src/server/repositories/a'", "import b from '@/server/repositories/b'",
      "import c from '@/src/components/ui/c'", "import d from '@/components/ui/d'", "import e from '@/src/components/generated/contato-manager'", "import f from '@/components/generated/contato-manager'", 'void a; void b; void c; void d; void e; void f',
    ].join(';') }])).not.toThrow()
  })

  it.each([
    ['process', 'export default function App(){return <pre>{String(process.env.APP_SMTP_URL)}</pre>}'],
    ['globalThis', 'export const value = globalThis'],
    ['eval', "export const value = eval('1')"],
    ['Function', "export const value = new Function('return 1')"],
    ['import.meta', 'export const value = import.meta.url'],
    ['use server', "'use server'; export async function action(){}"],
    ['dangerouslySetInnerHTML', "export default function App(){return <div dangerouslySetInnerHTML={{__html:'x'}}/>}"],
    ['script', "export default function App(){return <script src='x'/>}"],
    ['iframe', "export default function App(){return <iframe title='x'/>}"],
    ['object', "export default function App(){return <object data='x'/>}"],
  ])('rejects unsafe generated source construct: %s', (construct, content) => {
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content }])).toThrow(GeneratedFileRejectedError)
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content }])).toThrow(construct)
  })

  it('keeps ordinary client components valid', () => {
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content: "'use client'; export default function App(){return <main><h1>Projeto</h1></main>}" }])).not.toThrow()
  })
})
