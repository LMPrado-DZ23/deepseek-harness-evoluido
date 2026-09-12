import { describe, expect, it } from 'vitest'
import {
  buildCodeIndex, dependents, findSymbol, impactOf, importCycles, isReadableSource,
  resolveSpecifier, unimported, type SourceFileInput,
} from '../src/code-intelligence.ts'

function file(path: string, text: string): SourceFileInput { return { path, text } }

describe('o indice sabe o que cada arquivo exporta', () => {
  it('funcao, classe, const, tipo e interface exportados sao NOMEADOS', () => {
    const index = buildCodeIndex([file('src/a.ts', `
      export function fazer() {}
      export class Coisa {}
      export const VALOR = 1
      export type Forma = { x: number }
      export interface Porta { y: string }
      function escondida() {}
      const interno = 2
    `)])
    expect(index.symbols.get('src/a.ts')?.map(item => `${item.kind}:${item.name}`)).toEqual([
      'function:fazer', 'class:Coisa', 'const:VALOR', 'type:Forma', 'interface:Porta',
    ])
  })

  it('o que NAO e exportado nao entra: senao "onde isso ja existe" responderia por coisa privada', () => {
    const index = buildCodeIndex([file('src/a.ts', 'function escondida() {}\nconst interno = 2\n')])
    expect(index.symbols.get('src/a.ts')).toEqual([])
  })

  it('`export default` vira o simbolo `default`, nos dois jeitos de escrever', () => {
    const declarado = buildCodeIndex([file('src/a.tsx', 'export default function Tela() { return null }\n')])
    const atribuido = buildCodeIndex([file('src/b.ts', 'const x = 1\nexport default x\n')])
    expect(declarado.symbols.get('src/a.tsx')).toEqual([{ name: 'default', kind: 'default' }])
    expect(atribuido.symbols.get('src/b.ts')).toEqual([{ name: 'default', kind: 'default' }])
  })

  it('`export * from` e registrado como reexportacao, e nao como nada', () => {
    // Registrar nada faria um arquivo de barril parecer nao expor coisa
    // alguma — e barril e exatamente o arquivo que mais expoe.
    const index = buildCodeIndex([
      file('src/index.ts', "export * from './a'\nexport { VALOR } from './a'\n"),
      file('src/a.ts', 'export const VALOR = 1\n'),
    ])
    expect(index.symbols.get('src/index.ts')).toEqual([
      { name: '*', kind: 're-export' }, { name: 'VALOR', kind: 're-export' },
    ])
  })

  it('mais de uma const na mesma declaracao vira mais de um simbolo', () => {
    const index = buildCodeIndex([file('src/a.ts', 'export const UM = 1, DOIS = 2\n')])
    expect(index.symbols.get('src/a.ts')?.map(item => item.name)).toEqual(['UM', 'DOIS'])
  })
})

describe('arquivo ilegivel e DITO, e nunca pulado', () => {
  it('arquivo que nao compila entra em `unreadable`, e nao some do indice', () => {
    // Um arquivo que some do grafo e lido como "ninguem depende dele" — que e
    // exatamente a conclusao que faz alguem apaga-lo com confianca.
    const index = buildCodeIndex([file('src/quebrado.ts', 'export function ( { <<< \n')])
    expect(index.unreadable.map(item => item.path)).toEqual(['src/quebrado.ts'])
    expect(index.files).toContain('src/quebrado.ts')
    expect(index.symbols.has('src/quebrado.ts')).toBe(false)
  })

  it('arquivo que este indice nao le NAO e ilegivel: e outro tipo de arquivo', () => {
    const index = buildCodeIndex([file('content/app.json', '{"a":1}'), file('src/a.css', 'body{}')])
    expect(index.unreadable).toEqual([])
    expect(index.files).toEqual(['content/app.json', 'src/a.css'])
    expect(isReadableSource('content/app.json')).toBe(false)
    expect(isReadableSource('src/a.tsx')).toBe(true)
  })
})

describe('o grafo liga arquivo a arquivo, e diz quando nao consegue', () => {
  const app = [
    file('src/GeneratedApp.tsx', "import { Form } from './components/Form'\nimport React from 'react'\nexport default function App() { return null }\n"),
    file('src/components/Form.tsx', "import { validar } from '../lib/validacao'\nexport function Form() { return null }\n"),
    file('src/lib/validacao.ts', 'export function validar() { return true }\n'),
  ]

  it('caminho relativo resolve, com e sem extensao', () => {
    const index = buildCodeIndex(app)
    const resolvidas = index.imports.filter(edge => edge.to !== null)
    expect(resolvidas.map(edge => `${edge.from} -> ${String(edge.to)}`)).toEqual([
      'src/GeneratedApp.tsx -> src/components/Form.tsx',
      'src/components/Form.tsx -> src/lib/validacao.ts',
    ])
  })

  it('pacote externo vira aresta com `to: null`, e NAO some', () => {
    // Um pedido de mudanca que remove uma dependencia externa precisa saber
    // que ela estava la.
    const index = buildCodeIndex(app)
    const externa = index.imports.find(edge => edge.specifier === 'react')
    expect(externa).toEqual({ from: 'src/GeneratedApp.tsx', specifier: 'react', to: null })
  })

  it('apelido de caminho nao e chutado: sem a configuracao do projeto, `null`', () => {
    const index = buildCodeIndex([file('src/a.ts', "import { x } from '@/src/lib/x'\n"), file('src/lib/x.ts', 'export const x = 1\n')])
    expect(index.imports[0]!.to).toBe(null)
  })

  it('`export ... from` tambem e dependencia', () => {
    // Esquece-la deixaria um barril parecendo nao depender de nada.
    const index = buildCodeIndex([
      file('src/index.ts', "export * from './a'\n"), file('src/a.ts', 'export const V = 1\n'),
    ])
    expect(index.imports).toEqual([{ from: 'src/index.ts', specifier: './a', to: 'src/a.ts' }])
  })

  it('`./x.js` num projeto TypeScript acha `x.ts`', () => {
    const conhecidos = new Set(['src/lib/x.ts'])
    expect(resolveSpecifier('src/a.ts', './lib/x.js', conhecidos)).toBe('src/lib/x.ts')
  })

  it('caminho que SOBE acima da raiz nao resolve para nada', () => {
    // Resolve-lo para algo dentro do aplicativo seria inventar uma dependencia.
    expect(resolveSpecifier('src/a.ts', '../../fora/x', new Set(['fora/x.ts']))).toBe(null)
  })

  it('pasta com `index` resolve pela pasta', () => {
    expect(resolveSpecifier('src/a.ts', './lib', new Set(['src/lib/index.ts']))).toBe('src/lib/index.ts')
  })
})

describe('o que quebra se eu mexer aqui', () => {
  const app = [
    file('src/GeneratedApp.tsx', "import { Form } from './components/Form'\nexport default function App() { return null }\n"),
    file('src/components/Form.tsx', "import { validar } from '../lib/validacao'\nexport function Form() { return null }\n"),
    file('src/components/Lista.tsx', "import { validar } from '../lib/validacao'\nexport function Lista() { return null }\n"),
    file('src/lib/validacao.ts', 'export function validar() { return true }\n'),
  ]

  it('o impacto e TRANSITIVO: parar no primeiro nivel tranquiliza e erra', () => {
    const index = buildCodeIndex(app)
    expect(impactOf(index, ['src/lib/validacao.ts'])).toEqual([
      'src/GeneratedApp.tsx', 'src/components/Form.tsx', 'src/components/Lista.tsx',
    ])
  })

  it('o arquivo consultado NAO aparece no proprio impacto', () => {
    const index = buildCodeIndex(app)
    expect(impactOf(index, ['src/lib/validacao.ts'])).not.toContain('src/lib/validacao.ts')
  })

  it('arquivo que ninguem importa tem impacto VAZIO, e nao o aplicativo inteiro', () => {
    const index = buildCodeIndex(app)
    expect(impactOf(index, ['src/GeneratedApp.tsx'])).toEqual([])
  })

  it('dependentes diretos sao os diretos, e nao os transitivos', () => {
    const index = buildCodeIndex(app)
    expect(dependents(index).get('src/lib/validacao.ts')).toEqual(['src/components/Form.tsx', 'src/components/Lista.tsx'])
  })
})

describe('ciclo de importacao nao trava e nao e contado duas vezes', () => {
  const ciclo = [
    file('src/a.ts', "import { b } from './b'\nexport const a = 1\n"),
    file('src/b.ts', "import { c } from './c'\nexport const b = 1\n"),
    file('src/c.ts', "import { a } from './a'\nexport const c = 1\n"),
  ]

  it('o impacto TERMINA num ciclo, em vez de estourar a pilha', () => {
    const index = buildCodeIndex(ciclo)
    expect(impactOf(index, ['src/a.ts'])).toEqual(['src/b.ts', 'src/c.ts'])
  })

  it('um ciclo de tres arquivos e UM ciclo, e nao tres', () => {
    // Quem le contaria tres problemas onde ha um. O que garante isso e a
    // travessia marcar visitado ANTES de descer: a segunda entrada para o
    // mesmo ciclo encontra tudo visitado e nao desce de novo.
    const index = buildCodeIndex(ciclo)
    const achados = importCycles(index)
    expect(achados).toHaveLength(1)
    expect([...achados[0]!.files].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('o ciclo e relatado uma vez mesmo com VARIAS portas de entrada para ele', () => {
    // Tres arquivos de fora apontando para dentro do mesmo ciclo: se a
    // travessia recomecasse por cada um, o mesmo ciclo sairia quatro vezes.
    const index = buildCodeIndex([
      ...ciclo,
      file('src/porta1.ts', "import { a } from './a'\nexport const p1 = 1\n"),
      file('src/porta2.ts', "import { b } from './b'\nexport const p2 = 1\n"),
      file('src/porta3.ts', "import { c } from './c'\nexport const p3 = 1\n"),
    ])
    expect(importCycles(index)).toHaveLength(1)
  })

  it('a ordem de descida e ORDENADA, e nao a ordem em que os imports foram escritos', () => {
    // Sem ordenar, a lista de ciclos depende da ordem das linhas dentro de um
    // arquivo — e mexer numa linha que nao muda nada trocaria o relatorio.
    const index = buildCodeIndex([
      file('src/raiz.ts', "import { z } from './z'\nimport { b } from './b'\nexport const r = 1\n"),
      file('src/z.ts', "import { raiz } from './raiz'\nexport const z = 1\n"),
      file('src/b.ts', "import { raiz } from './raiz'\nexport const b = 1\n"),
    ])
    // `b` vem antes de `z` na ordem alfabetica, e e por `b` que a descida
    // encontra o primeiro ciclo — independente de `z` estar escrito antes.
    expect(importCycles(index).map(cycle => cycle.files)).toEqual([
      ['src/b.ts', 'src/raiz.ts'], ['src/raiz.ts', 'src/z.ts'],
    ])
  })

  it('a lista de ciclos e DETERMINISTICA: mesma entrada, mesma saida', () => {
    // Um relatorio que muda sozinho entre leituras nao da para comparar com o
    // da semana passada — e comparar e o unico uso dele.
    const index = buildCodeIndex(ciclo)
    expect(importCycles(index)).toEqual(importCycles(index))
    const invertido = buildCodeIndex([...ciclo].reverse())
    expect(importCycles(invertido)).toEqual(importCycles(index))
  })

  it('auto-importacao e um ciclo de UM arquivo', () => {
    const index = buildCodeIndex([file('src/solo.ts', "import { x } from './solo'\nexport const x = 1\n")])
    expect(importCycles(index)).toEqual([{ files: ['src/solo.ts'] }])
  })

  it('aplicativo sem ciclo nao inventa ciclo nenhum', () => {
    const index = buildCodeIndex([
      file('src/a.ts', "import { b } from './b'\nexport const a = 1\n"),
      file('src/b.ts', 'export const b = 1\n'),
    ])
    expect(importCycles(index)).toEqual([])
  })

  it('dois ciclos SEPARADOS sao dois', () => {
    const index = buildCodeIndex([
      ...ciclo,
      file('src/x.ts', "import { y } from './y'\nexport const x = 1\n"),
      file('src/y.ts', "import { x } from './x'\nexport const y = 1\n"),
    ])
    expect(importCycles(index)).toHaveLength(2)
  })
})

describe('onde um simbolo ja existe', () => {
  it('acha o arquivo que exporta aquele nome', () => {
    const index = buildCodeIndex([
      file('src/lib/validacao.ts', 'export function validar() { return true }\n'),
      file('src/outro.ts', 'export const outra = 1\n'),
    ])
    expect(findSymbol(index, 'validar')).toEqual(['src/lib/validacao.ts'])
    expect(findSymbol(index, 'inexistente')).toEqual([])
  })

  it('devolve TODOS os arquivos que exportam o mesmo nome', () => {
    // Dois arquivos exportando o mesmo nome JA e o defeito, e devolver so o
    // primeiro o esconderia.
    const index = buildCodeIndex([
      file('src/a.ts', 'export function validar() { return true }\n'),
      file('src/b.ts', 'export function validar() { return false }\n'),
    ])
    expect(findSymbol(index, 'validar')).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('arquivos que ninguem importa', () => {
  it('a entrada NAO entra na lista: ela nao e importada e e o arquivo mais vivo', () => {
    const index = buildCodeIndex([
      file('src/GeneratedApp.tsx', "import { Form } from './Form'\nexport default function App() { return null }\n"),
      file('src/Form.tsx', 'export function Form() { return null }\n'),
      file('src/orfao.ts', 'export const nada = 1\n'),
    ])
    expect(unimported(index, ['src/GeneratedApp.tsx'])).toEqual(['src/orfao.ts'])
  })

  it('sem declarar a entrada, ela aparece — e por isso o nome nao promete "morto"', () => {
    const index = buildCodeIndex([
      file('src/GeneratedApp.tsx', "import { Form } from './Form'\nexport default function App() { return null }\n"),
      file('src/Form.tsx', 'export function Form() { return null }\n'),
    ])
    expect(unimported(index)).toEqual(['src/GeneratedApp.tsx'])
  })

  it('arquivo que este indice nao le nao entra na lista', () => {
    const index = buildCodeIndex([file('content/app.json', '{}'), file('src/a.ts', 'export const a = 1\n')])
    expect(unimported(index)).toEqual(['src/a.ts'])
  })
})
