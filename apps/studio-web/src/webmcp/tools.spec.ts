/**
 * WebMCP — as ferramentas que o Studio oferece ao agente do navegador.
 *
 * O dublê aqui é FIEL à superfície da especificação (registerTool com
 * AbortSignal, execute devolvendo `content`), e o arquivo diz isso em voz alta:
 * `document.modelContext` só existe a partir do Chrome 149 sob origin trial, e
 * o Chromium deste ambiente não a oferece. Nenhum teste deste arquivo afirma
 * que o caminho de navegador real foi exercitado — ver o P37 em
 * docs/inventory/p37/webmcp.md.
 */
import { describe, expect, it, vi } from 'vitest'
import { BRIEF_MAX, browserModelContext, NAME_MAX, registerStudioTools, studioTools, type ModelContextLike, type StudioPort, type WebMcpToolDescriptor } from './tools'

function port(overrides: Partial<StudioPort> = {}): StudioPort {
  return {
    listProjects: async () => [{ project_id: 'p-1', name: 'Agenda do salão', state: 'PLAN_PROPOSED' }],
    projectDetails: async () => ({ project: { state: 'PLAN_PROPOSED' }, plan: { slices: [{ title: 'Agenda', description: 'Marcar horário' }] } }),
    createProject: async () => ({ project_id: 'p-novo' }),
    ...overrides,
  }
}

function tool(name: string, custom: Partial<StudioPort> = {}): WebMcpToolDescriptor {
  const found = studioTools(port(custom)).find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`ferramenta ausente: ${name}`)
  return found
}

describe('WebMCP — o que NÃO é exposto', () => {
  it('nenhuma ferramenta aprova plano, manda criar, publica, mexe em integração ou em segredo', () => {
    // Esta é a lista que a arquitetura de confirmação existe para proteger. Um
    // nome novo aqui não é uma ferramenta a mais: é uma decisão da pessoa
    // transferida para um programa que não é ela.
    const proibido = ['aprovar', 'approve', 'gerar', 'criar-aplicativo', 'publicar', 'staging', 'segredo', 'secret', 'smtp', 'integracao', 'integration', 'parada', 'emergencia', 'remover', 'apagar', 'excluir']
    for (const descriptor of studioTools(port())) {
      for (const termo of proibido) expect(descriptor.name).not.toContain(termo)
    }
  })

  it('o catálogo é pequeno de propósito e cada ferramenta tem um nome só', () => {
    const tools = studioTools(port())
    expect(tools.length).toBeLessThanOrEqual(5)
    expect(new Set(tools.map(descriptor => descriptor.name)).size).toBe(tools.length)
  })

  it('todo schema recusa campo desconhecido: um argumento a mais não é ignorado em silêncio', () => {
    for (const descriptor of studioTools(port())) {
      expect(descriptor.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('toda ferramenta descreve o que faz, para o agente escolher certo em vez de adivinhar', () => {
    for (const descriptor of studioTools(port())) expect(descriptor.description.length).toBeGreaterThan(40)
  })
})

describe('WebMCP — as ferramentas', () => {
  it('lista os projetos com nome e etapa', async () => {
    const result = await tool('dz23-listar-projetos').execute({})
    expect(result.content[0]!.text).toContain('Agenda do salão')
    expect(result.content[0]!.text).toContain('PLAN_PROPOSED')
  })

  it('lista vazia é dita como vazia, e não como erro', async () => {
    const result = await tool('dz23-listar-projetos', { listProjects: async () => [] }).execute({})
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toContain('ainda não tem')
  })

  it('conta a etapa e as partes do plano', async () => {
    const result = await tool('dz23-estado-do-projeto').execute({ project_id: 'p-1' })
    expect(result.content[0]!.text).toContain('PLAN_PROPOSED')
    expect(result.content[0]!.text).toContain('Agenda')
  })

  it('sem plano ainda, diz que não há — em vez de devolver uma lista vazia que o agente leria como "sem partes"', async () => {
    const result = await tool('dz23-estado-do-projeto', { projectDetails: async () => ({ project: { state: 'DRAFT' }, plan: null }) }).execute({ project_id: 'p-1' })
    expect(result.content[0]!.text).toContain('Ainda não há plano')
  })

  it('cria RASCUNHO e diz, na própria resposta, que nada foi construído', async () => {
    const created = vi.fn(async () => ({ project_id: 'p-novo' }))
    const result = await tool('dz23-criar-projeto', { createProject: created }).execute({ name: 'Agenda', brief: 'Quero marcar horários dos clientes.' })
    expect(created).toHaveBeenCalledWith({ name: 'Agenda', brief: 'Quero marcar horários dos clientes.' })
    // O agente lê esta frase e não conclui que o aplicativo está pronto.
    expect(result.content[0]!.text).toContain('Nada foi planejado nem construído')
  })
})

describe('WebMCP — validação no CÓDIGO, não só no schema', () => {
  it('argumento faltando vira erro que diz o que corrigir, e a chamada NÃO acontece', async () => {
    const created = vi.fn(async () => ({ project_id: 'p-novo' }))
    for (const args of [{}, { name: 'Agenda' }, { brief: 'algo' }, { name: '   ', brief: 'algo' }, { name: 'Agenda', brief: '  ' }]) {
      const result = await tool('dz23-criar-projeto', { createProject: created }).execute(args)
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/Informe (name|brief)/u)
    }
    expect(created).not.toHaveBeenCalled()
  })

  it('tipo errado não vira string: um número em project_id é recusado, não convertido', async () => {
    const details = vi.fn(async () => ({ project: { state: 'DRAFT' }, plan: null }))
    const result = await tool('dz23-estado-do-projeto', { projectDetails: details }).execute({ project_id: 42 })
    expect(result.isError).toBe(true)
    expect(details).not.toHaveBeenCalled()
  })

  it('texto gigante é recusado antes de sair: o teto está no código, e o schema é só a dica', async () => {
    const created = vi.fn(async () => ({ project_id: 'p-novo' }))
    const result = await tool('dz23-criar-projeto', { createProject: created })
      .execute({ name: 'a'.repeat(NAME_MAX + 1), brief: 'b'.repeat(BRIEF_MAX + 1) })
    expect(result.isError).toBe(true)
    expect(created).not.toHaveBeenCalled()
  })
})

describe('WebMCP — registro', () => {
  it('registra cada ferramenta com o sinal de desligamento', async () => {
    const registered: { tool: WebMcpToolDescriptor; signal: AbortSignal | undefined }[] = []
    const context: ModelContextLike = { async registerTool(descriptor, options) { registered.push({ tool: descriptor, signal: options?.signal }); return undefined } }
    const controller = new AbortController()
    const count = await registerStudioTools(context, port(), controller.signal)
    expect(count).toBe(studioTools(port()).length)
    // O sinal é o desligamento de verdade: sem ele, desligar só esconderia o
    // botão e as ferramentas continuariam no catálogo do agente.
    for (const entry of registered) expect(entry.signal).toBe(controller.signal)
  })

  it('navegador sem a API: nada é registrado e nada quebra', async () => {
    expect(await registerStudioTools(undefined, port(), new AbortController().signal)).toBe(0)
  })

  it('já desligado antes de começar: NÃO registra nem por um instante', async () => {
    const registerTool = vi.fn(async () => undefined)
    const controller = new AbortController()
    controller.abort()
    expect(await registerStudioTools({ registerTool }, port(), controller.signal)).toBe(0)
    expect(registerTool).not.toHaveBeenCalled()
  })

  it('a detecção é de CAPACIDADE: um objeto qualquer chamado modelContext não serve', () => {
    expect(browserModelContext(undefined)).toBeUndefined()
    expect(browserModelContext({})).toBeUndefined()
    expect(browserModelContext({ modelContext: null })).toBeUndefined()
    expect(browserModelContext({ modelContext: 'sim' })).toBeUndefined()
    expect(browserModelContext({ modelContext: {} })).toBeUndefined()
    const real = { registerTool: async () => undefined }
    expect(browserModelContext({ modelContext: real })).toBe(real)
  })
})
