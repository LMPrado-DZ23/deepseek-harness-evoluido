import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WebMcpPanel, webMcpEnabled, setWebMcpEnabled, WEBMCP_STORAGE_KEY } from './WebMcpPanel'
import type { StudioPort } from './tools'

const port: StudioPort = {
  listProjects: async () => [],
  projectDetails: async () => ({ project: { state: 'DRAFT' }, plan: null }),
  createProject: async () => ({ project_id: 'p' }),
}

function render(props: { available: boolean; enabled: boolean }) {
  return renderToStaticMarkup(createElement(WebMcpPanel, { ...props, setEnabled: () => {}, port }))
}

describe('WebMCP — o controle da pessoa', () => {
  it('diz o que fica exposto E o que nunca fica, na mesma tela', () => {
    const html = render({ available: true, enabled: false })
    expect(html).toContain('dz23-listar-projetos')
    expect(html).toContain('O que ele nunca enxerga')
    expect(html).toContain('aprovar um plano')
    expect(html).toContain('parada de emergência')
  })

  it('chega DESLIGADO, e a tela diz que está desligado em vez de deixar em branco', () => {
    const html = render({ available: true, enabled: false })
    expect(html).toContain('Nenhuma ação do Studio é oferecida')
    expect(html).not.toContain('checked=""')
  })

  it('num navegador sem o recurso, não oferece um botão que não faria nada', () => {
    const html = render({ available: false, enabled: false })
    expect(html).toContain('não oferece esse recurso')
    expect(html).not.toContain('type="checkbox"')
  })
})

describe('WebMCP — o estado guardado', () => {
  it('ausente vale como desligado', () => {
    expect(webMcpEnabled({ getItem: () => null })).toBe(false)
    expect(webMcpEnabled(undefined)).toBe(false)
  })
  it('qualquer valor que não seja "on" vale como desligado', () => {
    for (const stored of ['', 'off', 'true', '1', 'ON']) expect(webMcpEnabled({ getItem: () => stored })).toBe(false)
    expect(webMcpEnabled({ getItem: () => 'on' })).toBe(true)
  })
  it('armazenamento que LANÇA vale como desligado: bloqueio não é consentimento', () => {
    expect(webMcpEnabled({ getItem: () => { throw new Error('bloqueado') } })).toBe(false)
    // E gravar num armazenamento que lança não derruba a tela.
    expect(() => setWebMcpEnabled({ setItem: () => { throw new Error('bloqueado') } }, true)).not.toThrow()
  })
  it('grava exatamente "on" e "off", na chave versionada', () => {
    const written: [string, string][] = []
    setWebMcpEnabled({ setItem: (key, value) => { written.push([key, value]) } }, true)
    setWebMcpEnabled({ setItem: (key, value) => { written.push([key, value]) } }, false)
    expect(written).toEqual([[WEBMCP_STORAGE_KEY, 'on'], [WEBMCP_STORAGE_KEY, 'off']])
  })
})
