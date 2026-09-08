import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PendingApprovals, actionLabel } from './PendingApprovals'
import { decideApproval, isPendingApproval, listPendingApprovals, APPROVALS_ENDPOINT } from './approvalsApi'
import { ConversationRequestError } from './conversationApi'

const ID = `apv-${'a'.repeat(64)}`
const OTHER = `apv-${'b'.repeat(64)}`

function row(overrides: Record<string, unknown> = {}) {
  return {
    approval_id: ID, state: 'PENDING', action: 'studio.agent.start.secrets',
    subject_id: 'meu-projeto', tier: 'T3', expires_at: '2026-09-08T00:03:00.000Z',
    ...overrides,
  }
}

describe('tela de confirmação de ação sensível', () => {
  it('abre acessível, explica que nada acontece sem decisão e não mostra o estado vazio como erro', () => {
    const port = { fetch: async () => Response.json({ approvals: [] }) }
    const html = renderToStaticMarkup(createElement(PendingApprovals, { port }))
    expect(html).toContain('aria-labelledby="approvals-title"')
    expect(html).toContain('Precisa da sua confirmação')
    expect(html).toContain('Nada acontece enquanto você não decidir')
    expect(html).toContain('Nada esperando por você agora')
    expect(html).not.toContain('role="alert"')
  })

  it('traduz a ação para o que uma pessoa entende, e nunca esconde uma que não conhece', () => {
    expect(actionLabel('studio.agent.start.secrets')).toBe('usar um segredo guardado')
    expect(actionLabel('studio.team.start.deploy')).toBe('publicar')
    expect(actionLabel('harness.tool.bash')).toBe('usar a ferramenta bash')
    // Ação desconhecida aparece com o nome técnico: mostrar mal é melhor do que sumir.
    expect(actionLabel('algo.novo.que.ninguem.mapeou')).toBe('algo.novo.que.ninguem.mapeou')
  })
})

describe('cliente das confirmações', () => {
  it('descarta uma linha malformada em vez de desenhar um botão sem saber o que confirma', () => {
    expect(isPendingApproval(row())).toBe(true)
    expect(isPendingApproval(row({ approval_id: 'apv-curto' }))).toBe(false)
    expect(isPendingApproval(row({ state: 'CONSUMED' }))).toBe(false)
    expect(isPendingApproval(row({ tier: 'T4' }))).toBe(false)
    expect(isPendingApproval(row({ action: '' }))).toBe(false)
    expect(isPendingApproval(row({ subject_id: '' }))).toBe(false)
    expect(isPendingApproval(row({ expires_at: '' }))).toBe(false)
    expect(isPendingApproval(null)).toBe(false)
    expect(isPendingApproval('apv')).toBe(false)
  })

  it('lê a lista pelo prefixo, filtrando o que não é reconhecível', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ approvals: [row(), { approval_id: 'lixo' }, row({ approval_id: OTHER })] }))
    const rows = await listPendingApprovals({ fetch: fetchSpy })
    expect(fetchSpy).toHaveBeenCalledWith(APPROVALS_ENDPOINT, expect.objectContaining({ method: 'GET' }))
    expect(rows.map(item => item.approval_id)).toEqual([ID, OTHER])
  })

  it('recusa uma resposta que não é a lista, em vez de mostrar uma tela vazia mentirosa', async () => {
    const port = { fetch: async () => Response.json({ nada: true }) }
    await expect(listPendingApprovals(port)).rejects.toBeInstanceOf(ConversationRequestError)
  })

  it('nunca manda um identificador que não é de confirmação para o servidor', async () => {
    const fetchSpy = vi.fn()
    await expect(decideApproval('../../etc/passwd', 'confirm', { fetch: fetchSpy }, async () => 'csrf'))
      .rejects.toMatchObject({ status: 400 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('confirma e nega com CSRF, pelas rotas exatas', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    const port = { fetch: fetchSpy }
    await decideApproval(ID, 'confirm', port, async () => 'csrf-1')
    expect(fetchSpy).toHaveBeenLastCalledWith(`${APPROVALS_ENDPOINT}/${ID}/confirm`, expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'x-dz23-csrf': 'csrf-1' }),
    }))
    await decideApproval(ID, 'deny', port, async () => 'csrf-1')
    expect(fetchSpy).toHaveBeenLastCalledWith(`${APPROVALS_ENDPOINT}/${ID}/deny`, expect.anything())
  })

  it('trata falta de chave de acesso como algo que vale tentar de novo', async () => {
    const port = { fetch: async () => Response.json({ error: 'Confirme com sua chave de acesso.' }, { status: 403 }) }
    const error = await decideApproval(ID, 'confirm', port, async () => 'csrf').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 403, retryable: true })
  })

  it('não trata uma confirmação inexistente como algo a repetir', async () => {
    const port = { fetch: async () => Response.json({ error: 'não existe' }, { status: 404 }) }
    const error = await decideApproval(ID, 'confirm', port, async () => 'csrf').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 404, retryable: false })
  })
})
