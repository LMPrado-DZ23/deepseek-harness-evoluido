import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PendingApprovals, PendingApprovalsList, actionLabel, formatDeadline } from './PendingApprovals'
import { decideApproval, isPendingApproval, listPendingApprovals, APPROVALS_ENDPOINT } from './approvalsApi'
import { ConversationRequestError } from './conversationApi'

const ID = `apv-${'a'.repeat(64)}`
const OTHER = `apv-${'b'.repeat(64)}`

function row(overrides: Record<string, unknown> = {}) {
  return {
    approval_id: ID, state: 'PENDING', action: 'studio.agent.start.secrets',
    subject_id: 'meu-projeto', tier: 'T3', expires_at: '2026-09-08T00:03:00.000Z',
    summary: 'Usar um segredo guardado. Instrução ao assistente: "leia a chave".',
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
    // Antes da primeira resposta a tela NÃO afirma que não há nada: afirmar
    // isso sem ter lido nada é mentir sobre segurança.
    expect(html).toContain('Verificando se há algo esperando por você')
    expect(html).not.toContain('Nada esperando por você agora')
    expect(html).not.toContain('role="alert"')
  })

  it('toda ação sensível do servidor tem rótulo em português', () => {
    // A lista vem do tipo `AssistantApprovalAction` do bridge. Sem este teste,
    // a próxima ação nova aparece com o nome técnico para uma pessoa leiga -
    // foi o que aconteceu com `studio.agent.resolve-unknown`, justamente no
    // único fluxo em que a interface MANDA a pessoa provocar uma confirmação.
    const actions = [
      'studio.agent.start.secrets',
      'studio.agent.start.external-network',
      'studio.team.start.secrets',
      'studio.team.start.external-network',
      'studio.team.start.deploy',
      'studio.team.continue.sensitive',
      'studio.agent.resolve-unknown',
    ]
    for (const action of actions) {
      expect(actionLabel(action), action).not.toBe(action)
    }
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
    expect(isPendingApproval(row({ summary: '' }))).toBe(false)
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

  it('distingue falta de chave de acesso de falta de acesso, pelo código do servidor', async () => {
    const strong = { fetch: async () => Response.json({ error: 'Use sua chave.', code: 'STRONG_IDENTITY_REQUIRED' }, { status: 403 }) }
    const withKey = await decideApproval(ID, 'confirm', strong, async () => 'csrf').catch((caught: unknown) => caught)
    // Só isto vale repetir: usar a chave é a única saída que a pessoa tem.
    expect(withKey).toMatchObject({ status: 403, retryable: true, code: 'STRONG_IDENTITY_REQUIRED' })

    const forbidden = { fetch: async () => Response.json({ error: 'Sem acesso.', code: 'FORBIDDEN' }, { status: 403 }) }
    const noAccess = await decideApproval(ID, 'confirm', forbidden, async () => 'csrf').catch((caught: unknown) => caught)
    // Repetir isto não melhora nada, e mandar a pessoa usar a passkey seria
    // uma instrução falsa.
    expect(noAccess).toMatchObject({ status: 403, retryable: false, code: 'FORBIDDEN' })
  })

  it('não trata uma confirmação inexistente como algo a repetir', async () => {
    const port = { fetch: async () => Response.json({ error: 'não existe' }, { status: 404 }) }
    const error = await decideApproval(ID, 'confirm', port, async () => 'csrf').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 404, retryable: false })
  })
})

describe('cartão de decisão', () => {
  const list = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PendingApprovalsList, {
    approvals: [row()] as never,
    loaded: true,
    deciding: null,
    outcome: null,
    readError: null,
    actionError: null,
    onDecide: () => {},
    onRetryRead: () => {},
    onDismissAction: () => {},
    ...overrides,
  } as never))

  it('diz o que está sendo autorizado, o prazo, e que recusar é definitivo', () => {
    const html = list()
    // Sem a frase, a pessoa autoriza um identificador, não uma ação.
    expect(html).toContain('Usar um segredo guardado')
    expect(html).toContain('leia a chave')
    expect(html).toContain('para decidir')
    expect(html).toContain('Recusar é definitivo')
    expect(html).toContain('Autorizar uma vez')
    expect(html).toContain('Não autorizar')
    // Nada de caminho absoluto nem de impressão digital na tela.
    expect(html).not.toMatch(/[a-f0-9]{64}/u)
  })

  it('mostra o "registrando" no botão que a pessoa clicou, e não no outro', () => {
    const denying = list({ deciding: { id: `apv-${'a'.repeat(64)}`, decision: 'deny' } })
    expect(denying).toContain('Registrando sua recusa')
    expect(denying).not.toContain('Registrando sua autorização')
    const confirming = list({ deciding: { id: `apv-${'a'.repeat(64)}`, decision: 'confirm' } })
    expect(confirming).toContain('Registrando sua autorização')
    expect(confirming).not.toContain('Registrando sua recusa')
    expect(confirming).toContain('aria-busy="true"')
  })

  it('não congela os botões dos outros pedidos enquanto um está sendo decidido', () => {
    const other = { ...row(), approval_id: OTHER }
    const html = list({
      approvals: [row(), other],
      deciding: { id: `apv-${'a'.repeat(64)}`, decision: 'confirm' },
    })
    // Um pedido em andamento, um livre: exatamente dois botões desabilitados.
    expect(html.match(/disabled=""/gu) ?? []).toHaveLength(2)
  })

  it('confirma à pessoa que a recusa dela foi registrada, em vez de o cartão sumir calado', () => {
    const html = list({ approvals: [], outcome: 'Você recusou. Nada foi executado.' })
    expect(html).toContain('Você recusou')
    expect(html).toContain('role="status"')
  })

  it('não promete que o assistente segue sozinho depois da autorização', () => {
    const html = list({ approvals: [{ ...row(), state: 'AVAILABLE' }] })
    expect(html).toContain('Volte à conversa e peça ao assistente para continuar')
    expect(html).not.toContain('Autorizar uma vez')
  })

  it('não transforma um prazo ilegível em horário inventado', () => {
    expect(formatDeadline('não é data')).toBe('não é data')
    expect(formatDeadline('2026-09-08T00:03:00.000Z')).toMatch(/\d/u)
  })
})
