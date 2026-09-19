import { describe, expect, it } from 'vitest'
import { rotasDoServico } from '../src/service.js'

describe('as rotas da linha de comando entram na escolha', () => {
  it('local primeiro, as de linha (só as registradas, em ordem), depois as por chave', () => {
    expect(rotasDoServico(new Set(['deepseek-official', 'cli-qwen', 'cli-claude', 'ollama', 'outra'])))
      .toEqual(['ollama', 'cli-claude', 'cli-qwen', 'omniroute', 'deepseek-official'])
  })

  it('sem ferramenta instalada, a lista é a de sempre', () => {
    expect(rotasDoServico(new Set())).toEqual(['ollama', 'omniroute', 'deepseek-official'])
  })
})

describe('ligar de novo também fica registrado', () => {
  it('a troca diz que a pessoa ligou', async () => {
    const { StudioRouteHealthService } = await import('../src/service.js')
    const eventos: unknown[] = []
    const rotas: { route: string; org_id: string; tenant_id: string }[] = []
    const servico = new StudioRouteHealthService({
      routes: () => rotas as never, events: () => eventos as never,
      putRoute: async registro => { rotas.push(registro) }, putEvent: async evento => { eventos.push(evento) },
    }, { routes: ['ollama'], fallbackRoute: 'ollama', fallbackModel: 'm', localRoute: 'ollama' })
    await servico.setRouteEnabled({ orgId: 'o', tenantId: 't' }, 'ollama', true)
    expect(eventos).toMatchObject([{ from_route: 'ollama', to_route: 'ollama', reason: 'Ligada pela pessoa nas Preferências.', explicit_route: true }])
  })
})
