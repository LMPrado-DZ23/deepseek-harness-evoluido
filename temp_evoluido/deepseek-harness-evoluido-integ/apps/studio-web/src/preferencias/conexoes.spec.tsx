import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { comMudanca, lerConexoes, linhasDeConexao, mudarConexao, tipoDaRota, type RespostaDasRotas } from './conexoes'
import { ConexoesDeIa, ListaDeConexoes } from './Preferencias'
import { secoesDePreferencias } from './preferencias'

const RESPOSTA: RespostaDasRotas = {
  routes: [
    { route: 'ollama', state: 'OK', enabled: false },
    { route: 'cli-claude', state: 'OK' },
    { route: 'omniroute', state: 'NOT_CONFIGURED' },
    { route: 'deepseek-official', state: 'DOWN', enabled: true },
    { route: 'cli-claude', state: 'OK' },
  ],
  names: { 'cli-claude': 'Claude Code (sua assinatura, pela linha de comando)' },
}

describe('as conexões de IA', () => {
  it('a primeira ligada e pronta é a usada; sem repetição; nomes e tipos certos', () => {
    const linhas = linhasDeConexao(RESPOSTA)
    expect(linhas.map(linha => [linha.rota, linha.tipo, linha.estado, linha.ligada, linha.emUso])).toEqual([
      ['ollama', 'local', 'pronta', false, false],
      ['cli-claude', 'linha', 'pronta', true, true],
      ['omniroute', 'chave', 'naoConfigurada', true, false],
      ['deepseek-official', 'chave', 'comFalha', true, false],
    ])
    expect(linhas[1]!.nome).toMatch(/Claude Code/u)
    expect(linhas[0]!.nome).toBe('ollama')
    expect(tipoDaRota('cli-gemini')).toBe('linha')
  })

  it('a mudança prevista mexe só na conexão pedida', () => {
    const prevista = comMudanca(RESPOSTA, 'ollama', true)
    expect(prevista.routes[0]).toEqual({ route: 'ollama', state: 'OK', enabled: true })
    expect(prevista.routes.slice(1)).toEqual(RESPOSTA.routes.slice(1))
    expect(prevista.names).toBe(RESPOSTA.names)
    expect(linhasDeConexao(prevista)[0]!.emUso).toBe(true)
  })

  it('nenhuma pronta, nenhuma em uso', () => {
    expect(linhasDeConexao({ routes: [{ route: 'ollama', state: 'DOWN' }] }).some(linha => linha.emUso)).toBe(false)
  })

  it('a seção existe nas Preferências e está disponível', () => {
    expect(secoesDePreferencias({ autenticado: true, notificacoesSuportadas: true }).find(secao => secao.id === 'conexoes')).toMatchObject({ disponivel: true, grupo: 'configuracoes' })
  })

  it('lê e muda pelas rotas certas, com o token de escrita', async () => {
    const buscar = vi.fn(async () => new Response(JSON.stringify(RESPOSTA), { status: 200 }))
    await expect(lerConexoes(buscar as unknown as typeof fetch)).resolves.toEqual(RESPOSTA)
    expect(buscar).toHaveBeenCalledWith('/api/studio/routes/health', { credentials: 'same-origin' })
    await mudarConexao('ollama', true, buscar as unknown as typeof fetch, async () => 'tok')
    expect(buscar).toHaveBeenLastCalledWith('/api/studio/routes/enabled', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dz23-csrf': 'tok' }, body: '{"route":"ollama","enabled":true}',
    })
    const falha = vi.fn(async () => new Response('{}', { status: 404 }))
    await expect(lerConexoes(falha as unknown as typeof fetch)).rejects.toThrow('404')
    await expect(mudarConexao('x', false, falha as unknown as typeof fetch, async () => '')).rejects.toThrow('404')
  })
})

describe('a tela das conexões', () => {
  it('antes de ler, diz que está lendo', () => {
    const html = renderToStaticMarkup(<ConexoesDeIa ler={() => new Promise(() => {})} />)
    expect(html).toContain('Lendo as conexões…')
  })

  it('a lista desenhada diz qual está em uso, e cada interruptor tem nome', () => {
    const html = renderToStaticMarkup(createElement(ListaDeConexoes, { linhas: linhasDeConexao(RESPOSTA), mudando: false, erroAoMudar: true, aoAlternar: () => {} }))
    expect(html).toContain('usada agora nas criações')
    expect(html).toContain('aria-label="Usar ollama"')
    expect(html).toContain('Pela linha de comando, com a sua conta · pronta')
    expect(html).toContain('Não foi possível mudar esta conexão agora.')
    expect(html).toMatch(/instale a ferramenta/u)
    expect((html.match(/type="checkbox"/gu) ?? []).length).toBe(4)
    const semErro = renderToStaticMarkup(createElement(ListaDeConexoes, { linhas: linhasDeConexao(RESPOSTA), mudando: true, erroAoMudar: false, aoAlternar: () => {} }))
    expect(semErro).not.toContain('role="alert"')
    expect(semErro).toContain('disabled=""')
  })
})
