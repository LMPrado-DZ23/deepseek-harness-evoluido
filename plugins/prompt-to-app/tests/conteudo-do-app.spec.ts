import { describe, expect, it } from 'vitest'
import { assertConteudoDoApp, completarTituloDoConteudo } from '../src/conteudo-do-app.js'
import { ModelCodeGenerator } from '../src/pipeline.js'
import type { AppSpecV1 } from '../src/appspec.js'
import type { StudioPlan } from '../src/model.js'
import type { ModelResult, PromptModelPort } from '../src/ports.js'

/*
  O TEMPLATE LÊ `appContent.title`.

  Medido em 19/09/2026 com o qwen2.5-coder:7b: o contador de copos compilou e
  parou na checagem de tipos — `Property 'title' does not exist on type
  '{ meta_copos: number; }'` —, porque o modelo não sabia que o layout lê
  esse campo.
*/

const conteudo = (content: string) => ({ path: 'content/app.json', content })

describe('completarTituloDoConteudo', () => {
  it('acrescenta o title que falta, primeiro, e preserva as chaves do modelo', () => {
    const [saida] = completarTituloDoConteudo([conteudo('{"meta_copos": 8}')], 'Contador de Copos')
    expect(JSON.parse(saida!.content)).toEqual({ title: 'Contador de Copos', meta_copos: 8 })
    expect(Object.keys(JSON.parse(saida!.content))[0]).toBe('title')
  })

  it('troca um title que não é texto, ou é vazio', () => {
    expect(JSON.parse(completarTituloDoConteudo([conteudo('{"title": 3}')], 'X')[0]!.content)).toEqual({ title: 'X' })
    expect(JSON.parse(completarTituloDoConteudo([conteudo('{"title": "  "}')], 'X')[0]!.content)).toEqual({ title: 'X' })
  })

  it('nunca troca um title de texto, nem toca em outro arquivo ou em conteúdo que não é objeto', () => {
    const certo = conteudo('{"title":"Aurora"}')
    expect(completarTituloDoConteudo([certo], 'X')[0]).toBe(certo)
    const codigo = { path: 'src/GeneratedApp.tsx', content: 'export const A = () => null' }
    expect(completarTituloDoConteudo([codigo], 'X')[0]).toBe(codigo)
    const lista = conteudo('[1,2]')
    expect(completarTituloDoConteudo([lista], 'X')[0]).toBe(lista)
    const quebrado = conteudo('{nao e json')
    expect(completarTituloDoConteudo([quebrado], 'X')[0]).toBe(quebrado)
  })
})

describe('assertConteudoDoApp', () => {
  it('recusa conteúdo que não é objeto JSON, dizendo a forma esperada', () => {
    for (const ruim of ['[1]', '"texto"', 'null', '{quebrado']) {
      expect(() => assertConteudoDoApp([conteudo(ruim)])).toThrow(/objeto entre chaves.*title/u)
    }
  })

  it('aceita objeto, e aceita a ausência do arquivo', () => {
    expect(() => assertConteudoDoApp([conteudo('{"title":"A"}')])).not.toThrow()
    expect(() => assertConteudoDoApp([{ path: 'src/A.tsx', content: '' }])).not.toThrow()
  })
})

class Modelo implements PromptModelPort {
  readonly prompts: string[] = []
  async complete(_scope: never, _purpose: never, _privacy: never, prompt: string): Promise<ModelResult> {
    this.prompts.push(prompt)
    return { value: JSON.stringify({ files: [conteudo('{"meta_copos": 8}'), { path: 'src/GeneratedApp.tsx', content: 'export const A = () => <div />' }] }), route: 'ollama', model: 'm' }
  }
}

describe('o gerador entrega o conteúdo com title', () => {
  const plan = { slices: [] } as unknown as StudioPlan
  const ator = { orgId: 'o', tenantId: 't' } as never

  it('usa o nome da primeira página da especificação, e o prompt pede o campo', async () => {
    const modelo = new Modelo()
    const spec = { schema_version: 1, problem: 'p', pages: [{ name: 'Contador de Copos', sections: ['a'] }], entities: [], acceptance_criteria: [], language: 'pt-BR' } as unknown as AppSpecV1
    const { files } = await new ModelCodeGenerator(modelo, ator, 'melhor-qualidade', 'interativo').generate(spec, plan)
    expect(JSON.parse(files.find(file => file.path === 'content/app.json')!.content).title).toBe('Contador de Copos')
    expect(modelo.prompts[0]).toMatch(/content\/app\.json é um objeto JSON e sempre tem o campo title/u)
  })

  it('sem página, cai no título do FRIGG', async () => {
    const spec = { schema_version: 1, problem: 'p', pages: [], entities: [], acceptance_criteria: [], language: 'pt-BR' } as unknown as AppSpecV1
    const { files } = await new ModelCodeGenerator(new Modelo(), ator, 'melhor-qualidade', 'interativo').generate(spec, plan)
    expect(JSON.parse(files.find(file => file.path === 'content/app.json')!.content).title).toBe('Aplicativo criado no FRIGG')
  })
})
