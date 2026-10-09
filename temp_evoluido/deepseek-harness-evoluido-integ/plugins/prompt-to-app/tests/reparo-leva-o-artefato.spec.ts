import { describe, expect, it } from 'vitest'
import { ModelCodeGenerator } from '../src/pipeline.js'
import type { AppSpecV1 } from '../src/appspec.js'
import type { StudioPlan } from '../src/model.js'
import type { ModelResult, PromptModelPort } from '../src/ports.js'

/*
  O REPARO TEM DE LEVAR O ARTEFATO.

  Medido em 18/09/2026 contra o Ollama do titular, com `qwen2.5-coder:7b`:

  1. a primeira tentativa devolveu um jogo da velha COMPLETO — alternância,
     casa ocupada, vitória nas oito linhas, empate e reinício —, recusado por
     UM atributo `style`;
  2. a rodada de reparo recebeu a causa, e só ela;
  3. o modelo, sem o arquivo anterior na mão, escreveu outro do zero: o `style`
     sumiu, e o jogo inteiro sumiu junto — o corpo da jogada voltou vazio.

  Reparo sem o artefato não é reparo: é uma segunda geração com uma instrução
  extra, e o que ela preserva é sorte.
*/

const ANTERIOR = [{
  path: 'src/GeneratedApp.tsx',
  content: "export function A() { return <div style={{ display: 'grid' }} /> }",
}]

class ModeloQueRegistra implements PromptModelPort {
  readonly prompts: string[] = []
  async complete(_scope: never, _purpose: never, _privacy: never, prompt: string): Promise<ModelResult> {
    this.prompts.push(prompt)
    return { value: JSON.stringify({ files: [{ path: 'src/GeneratedApp.tsx', content: 'export const A = () => <div />' }] }), route: 'ollama', model: 'm' }
  }
}

const spec = { schema_version: 1, problem: 'p', pages: [], entities: [], acceptance_criteria: [], language: 'pt-BR' } as unknown as AppSpecV1
const plan = { slices: [] } as unknown as StudioPlan
const ator = { orgId: 'o', tenantId: 't' } as never

describe('o que a rodada de reparo leva ao modelo', () => {
  it('sem diagnóstico, o prompt NÃO fala de tentativa anterior', async () => {
    const modelo = new ModeloQueRegistra()
    await new ModelCodeGenerator(modelo, ator, 'melhor-qualidade', 'interativo').generate(spec, plan)
    expect(modelo.prompts[0]).not.toContain('tentativa anterior')
  })

  it('com diagnóstico E arquivos, o modelo recebe o CÓDIGO que tem de consertar', async () => {
    const modelo = new ModeloQueRegistra()
    await new ModelCodeGenerator(modelo, ator, 'melhor-qualidade', 'interativo')
      .generate(spec, plan, 'construção não permitida: style', ANTERIOR)
    const enviado = modelo.prompts[0] ?? ''
    expect(enviado).toContain('construção não permitida: style')
    // O conteúdo INTEIRO do arquivo anterior, e não só o caminho: o modelo não
    // consegue preservar o que não está vendo.
    expect(enviado).toContain(ANTERIOR[0]!.content)
    expect(enviado).toMatch(/não recomece do zero/iu)
  })

  it('com diagnóstico e NENHUM arquivo, não vai lista vazia', async () => {
    /*
      Uma lista vazia diria ao modelo que a tentativa anterior não produziu
      nada — o que é uma afirmação diferente de "não há tentativa anterior", e
      falsa quando a geração falhou antes de devolver arquivo.
    */
    const modelo = new ModeloQueRegistra()
    await new ModelCodeGenerator(modelo, ator, 'melhor-qualidade', 'interativo').generate(spec, plan, 'causa', [])
    expect(modelo.prompts[0]).not.toMatch(/não recomece do zero/iu)
  })
})

describe("a saída do gerador já vem com a diretiva de cliente completada", () => {
  class ModeloContador implements PromptModelPort {
    async complete(): Promise<ModelResult> {
      return { value: JSON.stringify({ files: [{ path: 'src/GeneratedApp.tsx', content: "import { useState } from 'react'\nexport default function A(){const [n,s]=useState(0);return <button onClick={()=>{s(n+1)}}>{n}</button>}" }] }), route: 'ollama', model: 'm' }
    }
  }

  it('interativo: o arquivo com estado sai com a linha do FRIGG', async () => {
    const saida = await new ModelCodeGenerator(new ModeloContador(), ator, 'melhor-qualidade', 'interativo').generate(spec, plan)
    expect(saida.files[0]!.content.startsWith("// FRIGG: acrescentou a diretiva")).toBe(true)
  })

  it('declarativo: nada muda', async () => {
    const saida = await new ModelCodeGenerator(new ModeloContador(), ator, 'melhor-qualidade', 'declarativo').generate(spec, plan)
    expect(saida.files[0]!.content.startsWith('import')).toBe(true)
  })
})
