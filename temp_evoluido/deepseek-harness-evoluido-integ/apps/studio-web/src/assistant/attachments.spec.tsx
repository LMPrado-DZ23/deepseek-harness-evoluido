import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import copy from '../i18n/assistant.pt-BR.json'
import { AttachmentList, Conversation, attachmentKind, formatAttachmentSize } from './Conversation'
import {
  ConversationRequestError,
  MAX_ATTACHMENT_BYTES,
  isConversationAttachment,
  sendConversationMessage,
  uploadConversationAttachment,
  type ConversationAttachment,
} from './conversationApi'

const csrf = async () => 'csrf-1'

const attachment = (overrides: Partial<ConversationAttachment> = {}): ConversationAttachment => ({
  attachment_id: 'ref-1', name: 'relatorio.txt', size: 2048, media_type: 'text/plain', ...overrides,
})

/** Um arquivo do jeito que a tela o vê: nome dado pela pessoa, mais bytes. */
function file(name: string, bytes: Uint8Array) {
  return { name, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer }
}

describe('envio de mensagem com anexo', () => {
  it('sem anexo o corpo continua sendo exatamente {text}', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ accepted: true, request_id: 'req-1' }, { status: 202 }))
    await sendConversationMessage('c1', 'oi', { fetch: fetchMock }, csrf)
    // A garantia do servidor é `{text}` OU `{text, attachments}`: mandar
    // `attachments: []` seria uma terceira forma, e o servidor a recusaria.
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ text: 'oi' })
  })

  it('com anexo o corpo carrega só as referências opacas, nunca o arquivo', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ accepted: true, request_id: 'req-1' }, { status: 202 }))
    await sendConversationMessage('c1', 'veja', { fetch: fetchMock }, csrf, ['ref-1', 'ref-2'])
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      text: 'veja', attachments: ['ref-1', 'ref-2'],
    })
  })
})

describe('subir um anexo', () => {
  it('sobe nome e bytes, com CSRF, e não informa tipo nem caminho', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json(attachment({ name: 'passwd' }), { status: 201 }))
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const reference = await uploadConversationAttachment(
      'c1', file('../../etc/passwd', bytes), { fetch: fetchMock }, csrf,
    )
    // O nome que a tela mostra é o que o SERVIDOR devolveu, já higienizado.
    expect(reference.name).toBe('passwd')
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('/studio/assistant/conversation/c1/attachments')
    expect((init.headers as Record<string, string>)['x-dz23-csrf']).toBe('csrf-1')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    // Exatamente duas chaves. `content_type` deixaria o cliente escolher a
    // gaveta; `path` diria ao servidor um caminho que ele nunca deve usar.
    expect(Object.keys(body).sort()).toEqual(['content_base64', 'filename'])
    expect(body.filename).toBe('../../etc/passwd')
    expect(Buffer.from(body.content_base64 as string, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('o teto de tamanho barra antes de subir, e o arquivo vazio também', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json(attachment(), { status: 201 }))
    const grande = file('grande.png', new Uint8Array(MAX_ATTACHMENT_BYTES + 1))
    await expect(uploadConversationAttachment('c1', grande, { fetch: fetchMock }, csrf))
      .rejects.toThrow(copy.attachmentTooLargeLocal)
    await expect(uploadConversationAttachment('c1', file('vazio.txt', new Uint8Array(0)), { fetch: fetchMock }, csrf))
      .rejects.toThrow(copy.attachmentTooLargeLocal)
    // Nada subiu: o limite existe para poupar a rede da pessoa, não só a do servidor.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a recusa do servidor chega em português e sem virar sucesso', async () => {
    const recusa = 'Este tipo de arquivo não é aceito. Envie uma imagem (PNG, JPEG, WebP ou GIF) ou um arquivo de texto.'
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ error: recusa }, { status: 400 }))
    const erro = await uploadConversationAttachment('c1', file('a.bin', new Uint8Array([1, 2, 3])), { fetch: fetchMock }, csrf)
      .catch((reason: unknown) => reason)
    expect(erro).toBeInstanceOf(ConversationRequestError)
    expect((erro as ConversationRequestError).message).toBe(recusa)
    // 400 não é para tentar de novo com o mesmo arquivo: nada mudou.
    expect((erro as ConversationRequestError).retryable).toBe(false)
  })

  it('meia referência não vira anexo na tela', async () => {
    // Renderizar meia referência mostraria um anexo que o servidor nunca
    // confirmou, e a pessoa enviaria a mensagem achando que o arquivo foi junto.
    expect(isConversationAttachment(attachment())).toBe(true)
    for (const quebrada of [
      null, [], 'ref-1',
      { ...attachment(), attachment_id: '' },
      { ...attachment(), name: '' },
      { ...attachment(), size: 0 },
      { ...attachment(), size: 1.5 },
      { ...attachment(), media_type: 'application/pdf' },
      { attachment_id: 'ref-1' },
    ]) {
      expect(isConversationAttachment(quebrada), JSON.stringify(quebrada)).toBe(false)
    }
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ attachment_id: 'ref-1' }, { status: 201 }))
    await expect(uploadConversationAttachment('c1', file('a.txt', new Uint8Array([65])), { fetch: fetchMock }, csrf))
      .rejects.toThrow(copy.invalidServerResponse)
  })
})

describe('anexos na tela', () => {
  it('cada anexo mostra nome, tipo e tamanho, e tem seu próprio botão de remover', () => {
    const html = renderToStaticMarkup(createElement(AttachmentList, {
      items: [
        attachment(),
        attachment({ attachment_id: 'ref-2', name: 'foto.png', size: 300, media_type: 'image/png' }),
      ],
      onRemove: () => {},
    }))
    expect(html).toContain(copy.attachmentsTitle)
    expect(html).toContain('relatorio.txt')
    expect(html).toContain('foto.png')
    expect(html).toContain(copy.attachmentKindText)
    expect(html).toContain(copy.attachmentKindImage)
    expect(html).toContain('2 KB')
    // Um botão por anexo, cada um dizendo QUAL anexo remove: "Remover" repetido
    // três vezes num leitor de tela não diz nada a quem não vê a lista.
    expect(html).toContain('aria-label="Remover o anexo relatorio.txt"')
    expect(html).toContain('aria-label="Remover o anexo foto.png"')
  })

  it('sem anexo não há lista vazia ocupando a tela', () => {
    expect(renderToStaticMarkup(createElement(AttachmentList, { items: [], onRemove: () => {} }))).toBe('')
  })

  it('o tamanho nunca aparece como zero, e a palavra do tipo é humana', () => {
    // 512 bytes arredondado para baixo seria "0 KB": um anexo que parece vazio.
    expect(formatAttachmentSize(1)).toBe('1 KB')
    expect(formatAttachmentSize(512)).toBe('1 KB')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(2049)).toBe('3 KB')
    expect(attachmentKind(attachment())).toBe(copy.attachmentKindText)
    for (const media of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
      expect(attachmentKind(attachment({ media_type: media }))).toBe(copy.attachmentKindImage)
    }
  })

  it('o compositor oferece escolher arquivo, com rótulo, dica e limites ditos', () => {
    const port = { fetch: async () => Response.json({ conversation_id: 'c1', cursor: 0, events: [], truncated: false }) }
    const html = renderToStaticMarkup(createElement(Conversation, { conversationId: 'c1', port }))
    expect(html).toContain('for="conversation-attachment"')
    expect(html).toContain('id="conversation-attachment"')
    expect(html).toContain('type="file"')
    expect(html).toContain(copy.attachLabel)
    // A dica diz os limites ANTES da recusa, e está ligada ao campo.
    expect(html).toContain('aria-describedby="conversation-attachment-hint"')
    expect(html).toContain('id="conversation-attachment-hint"')
    expect(html).toContain(copy.attachHint)
    // Sem anexo escolhido, nenhuma lista de anexos aparece.
    expect(html).not.toContain(copy.attachmentsTitle)
  })
})

describe('textos de anexo no catálogo', () => {
  it('nenhuma frase de anexo está escrita dentro do componente', () => {
    const fonte = String(AttachmentList) + String(Conversation)
    for (const frase of [copy.attachLabel, copy.attachmentsTitle, copy.attachmentRemove, copy.attaching]) {
      expect(fonte, frase).not.toContain(frase)
    }
  })
})
