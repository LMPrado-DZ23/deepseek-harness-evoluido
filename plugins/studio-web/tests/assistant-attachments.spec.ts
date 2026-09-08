import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_TTL_MS,
  AssistantAttachmentStore,
  AssistantConversationError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  attachmentScopeKey,
  detectAttachmentType,
  displayAttachmentName,
  type AssistantAttachmentScope,
} from '../src/index.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('desenho')])
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('foto')])
const GIF = Buffer.from('GIF89a---animado')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPresto')])
const TEXT = Buffer.from('primeira linha\nsegunda\tlinha\r\nacentuação: ação\n', 'utf8')
/** Um ELF de verdade: assinatura, e NUL logo em seguida. Não é imagem nem texto. */
const ELF = Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])

function scope(overrides: Partial<AssistantAttachmentScope> = {}): AssistantAttachmentScope {
  return { userId: 'pessoa-a', orgId: 'org-a', tenantId: 'espaco-a', conversationId: 'conversa-1', ...overrides }
}

/** A recusa que realmente aconteceu. Um teste que não recusa nada tem de falhar. */
function refusal(action: () => unknown): AssistantConversationError {
  try {
    action()
  } catch (error) {
    if (error instanceof AssistantConversationError) return error
    throw error
  }
  throw new Error('a chamada deveria ter sido recusada e não foi')
}

describe('nome exibível de anexo', () => {
  it('um nome hostil nunca vira caminho: separador, travessia, controle e bidi somem', () => {
    // Travessia escrita em qualquer das duas grafias: sobra apenas o último nome.
    expect(displayAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(displayAttachmentName('..\\..\\Windows\\system32\\config\\SAM')).toBe('SAM')
    expect(displayAttachmentName('/absoluto/no/disco/relatorio.txt')).toBe('relatorio.txt')
    // Um nome que é SÓ travessia não é nome: vira o rótulo do catálogo.
    for (const hostile of ['..', '.', '...', '/', '\\', '   ', 'a/..', '']) {
      expect(displayAttachmentName(hostile), hostile).toBe('arquivo anexado')
    }
    // Controle, NUL e quebra de linha não sobrevivem: um `\r` no nome quebraria
    // qualquer registro que o escrevesse, e um NUL trunca nomes em C.
    expect(displayAttachmentName('linha\r\nnova.txt')).toBe('linhanova.txt')
    expect(displayAttachmentName('nulo\u0000.txt')).toBe('nulo.txt')
    expect(displayAttachmentName('escape[31m.txt')).toBe('escape[31m.txt')
    // Marca de direção: é com ela que se disfarça a extensão na tela.
    expect(displayAttachmentName('foto‮gpj.exe')).toBe('fotogpj.exe')
    expect(displayAttachmentName('‏nome⁦.txt⁩')).toBe('nome.txt')
    // Nome imenso é carga, não nome.
    expect(displayAttachmentName('a'.repeat(400))).toHaveLength(80)
    // O nome legítimo continua legível, com acento e espaço.
    expect(displayAttachmentName('Relatório final (2).txt')).toBe('Relatório final (2).txt')
  })
})

describe('tipo de anexo decidido pelo conteúdo', () => {
  it('a extensão não decide nada: quem decide são os primeiros bytes', () => {
    expect(detectAttachmentType(PNG)).toBe('image/png')
    expect(detectAttachmentType(JPEG)).toBe('image/jpeg')
    expect(detectAttachmentType(GIF)).toBe('image/gif')
    expect(detectAttachmentType(Buffer.from('GIF87a---antigo'))).toBe('image/gif')
    expect(detectAttachmentType(WEBP)).toBe('image/webp')
    expect(detectAttachmentType(TEXT)).toBe('text/plain')
    // Nada disto é aceito, com extensão nenhuma que salve.
    expect(detectAttachmentType(ELF)).toBeUndefined()
    expect(detectAttachmentType(Buffer.from([]))).toBeUndefined()
    expect(detectAttachmentType(Buffer.from([0xC3, 0x28]))).toBeUndefined()
    expect(detectAttachmentType(Buffer.from('texto com nulo\u0000', 'utf8'))).toBeUndefined()
    // `RIFF` seguido de qualquer coisa que não seja `WEBP` não é WebP.
    expect(detectAttachmentType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WAVEfmt ')]))).toBeUndefined()
    // Assinatura truncada não é assinatura.
    expect(detectAttachmentType(Buffer.from([0x89, 0x50]))).toBeUndefined()
    // `RIFF` sozinho, sem os 12 bytes do cabeçalho, ainda é ASCII legível: ele
    // cai como texto, e não como uma imagem que ninguém provou existir.
    expect(detectAttachmentType(Buffer.from('RIFF'))).toBe('text/plain')
  })

  it('um PNG chamado notas.txt é guardado como imagem, e um texto chamado foto.png como texto', () => {
    const store = new AssistantAttachmentStore()
    // Esta é a garantia inteira em duas linhas: se a extensão decidisse, um
    // executável renomeado entraria como texto e seria lido como texto.
    expect(store.put(scope(), 'notas.txt', PNG).media_type).toBe('image/png')
    expect(store.put(scope(), 'foto.png', TEXT).media_type).toBe('text/plain')
    // E o que a extensão prometia ser imagem, mas não é, é recusado.
    expect(refusal(() => store.put(scope(), 'foto.png', ELF)).message)
      .toBe('Este tipo de arquivo não é aceito. Envie uma imagem (PNG, JPEG, WebP ou GIF) ou um arquivo de texto.')
  })
})

describe('limites do anexo', () => {
  it('o teto por arquivo barra, e barra pelos bytes', () => {
    const store = new AssistantAttachmentStore()
    const noLimite = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_ATTACHMENT_BYTES - 8, 0x41)])
    expect(store.put(scope(), 'grande.png', noLimite).size).toBe(MAX_ATTACHMENT_BYTES)
    const acima = Buffer.concat([noLimite, Buffer.from('!')])
    const erro = refusal(() => store.put(scope(), 'grande.png', acima))
    expect(erro.code).toBe('INVALID_MESSAGE')
    expect(erro.message).toContain('grande demais')
    // Zero byte também não é anexo: não há tipo a decidir e nada a enviar.
    expect(refusal(() => store.put(scope(), 'vazio.txt', Buffer.alloc(0))).code).toBe('INVALID_MESSAGE')
  })

  it('o teto por conversa barra o que o teto por arquivo sozinho deixaria passar', () => {
    const store = new AssistantAttachmentStore()
    const cheio = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_ATTACHMENT_BYTES - 8, 0x41)])
    const quantos = MAX_CONVERSATION_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES
    for (let index = 0; index < quantos; index++) store.put(scope(), 'parte.png', cheio)
    expect(refusal(() => store.put(scope(), 'a-mais.png', cheio)).message).toContain('anexos demais')
    // Outra conversa da mesma pessoa tem a própria cota: o teto é por conversa.
    expect(store.put(scope({ conversationId: 'conversa-2' }), 'ok.png', cheio).size).toBe(MAX_ATTACHMENT_BYTES)
  })

  it('o achado do scanner recusa o anexo e não devolve o trecho encontrado', () => {
    const store = new AssistantAttachmentStore()
    const segredo = Buffer.from(`config\nGITHUB=ghp_${'a'.repeat(36)}\n`, 'utf8')
    const erro = refusal(() => store.put(scope(), 'config.txt', segredo))
    expect(erro.code).toBe('INVALID_MESSAGE')
    expect(erro.message).toContain('credencial')
    // A recusa não repete o segredo, nem o nome do arquivo, nem o padrão achado.
    expect(erro.message).not.toContain('ghp_')
    expect(erro.message).not.toContain('config.txt')
    // E nada ficou guardado: recusar e guardar seria o pior dos dois mundos.
    expect(store.size()).toBe(0)
    // Uma chave colada dentro dos bytes de uma imagem cai no mesmo padrão.
    const imagemComChave = Buffer.concat([PNG, Buffer.from('-----BEGIN RSA PRIVATE KEY-----')])
    expect(refusal(() => store.put(scope(), 'foto.png', imagemComChave)).message).toContain('credencial')
    expect(store.size()).toBe(0)
    // Uma senha dentro de uma URL de configuração cai no mesmo lugar.
    expect(refusal(() => store.put(scope(), 'env.txt', Buffer.from('SMTP=smtp://ana:senha@mail.exemplo\n'))).message)
      .toContain('credencial')
  })

  it('os tetos por mensagem e por conversa são constantes únicas e coerentes', () => {
    // Duas grafias do mesmo teto seriam dois tetos diferentes: um na borda HTTP
    // e outro no serviço, e a pessoa descobriria a diferença no pior momento.
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5)
    expect(MAX_CONVERSATION_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES).toBe(4)
  })
})

describe('isolamento do anexo', () => {
  it('outra pessoa, outra organização, outro espaço e outra conversa não leem a referência', () => {
    const store = new AssistantAttachmentStore()
    const referencia = store.put(scope(), 'meu.txt', TEXT)
    expect(store.resolve(scope(), [referencia.attachment_id])[0]?.bytes.toString('utf8')).toBe(TEXT.toString('utf8'))
    // O MESMO identificador, tentado de cada escopo vizinho.
    const alheios: readonly Partial<AssistantAttachmentScope>[] = [
      { userId: 'pessoa-b' },
      { orgId: 'org-b' },
      { tenantId: 'espaco-b' },
      { conversationId: 'conversa-2' },
    ]
    for (const alheio of alheios) {
      const erro = refusal(() => store.resolve(scope(alheio), [referencia.attachment_id]))
      expect(erro.code, JSON.stringify(alheio)).toBe('NOT_FOUND')
      // A frase é a mesma de um identificador que nunca existiu: distinguir os
      // dois contaria a quem tentou que este identificador é real.
      expect(erro.message).toBe('Este anexo não está mais disponível. Anexe o arquivo de novo.')
    }
    // E nenhum escopo vizinho consegue apagar o anexo de outro.
    for (const alheio of alheios) store.consume(scope(alheio), [referencia.attachment_id])
    expect(store.resolve(scope(), [referencia.attachment_id])).toHaveLength(1)
  })

  it('a chave de escopo não pode ser colidida juntando os campos de outro jeito', () => {
    // Com `:` no lugar do separador, `org=a:b` + `tenant=c` colidiria com
    // `org=a` + `tenant=b:c`, e um anexo cairia no escopo errado.
    expect(attachmentScopeKey(scope({ orgId: 'a:b', tenantId: 'c' })))
      .not.toBe(attachmentScopeKey(scope({ orgId: 'a', tenantId: 'b:c' })))
  })

  it('uma referência desconhecida, consumida ou vencida responde a mesma coisa', () => {
    let agora = 1_000
    const store = new AssistantAttachmentStore({ now: () => agora })
    const referencia = store.put(scope(), 'meu.txt', TEXT)
    expect(refusal(() => store.resolve(scope(), ['nunca-existiu'])).code).toBe('NOT_FOUND')
    agora += ATTACHMENT_TTL_MS
    expect(refusal(() => store.resolve(scope(), [referencia.attachment_id])).code).toBe('NOT_FOUND')
    // O vencido não fica ocupando memória depois de ser negado.
    expect(store.size()).toBe(0)

    agora = 2_000
    const outra = store.put(scope(), 'meu.txt', TEXT)
    store.consume(scope(), [outra.attachment_id])
    expect(refusal(() => store.resolve(scope(), [outra.attachment_id])).code).toBe('NOT_FOUND')
    // Consumir uma referência que não existe não explode nem apaga a de ninguém.
    store.consume(scope(), ['nunca-existiu'])
  })

  it('a referência é opaca: não carrega caminho, disco nem o nome bruto', () => {
    const store = new AssistantAttachmentStore({ createId: () => 'ref-1' })
    const referencia = store.put(scope(), '../../home/pessoa/.ssh/segredo.txt', TEXT)
    expect(referencia).toEqual({
      attachment_id: 'ref-1',
      name: 'segredo.txt',
      size: TEXT.length,
      media_type: 'text/plain',
    })
    const serializada = JSON.stringify(referencia)
    for (const vazamento of ['/home', '..', '.ssh', '\\']) {
      expect(serializada, vazamento).not.toContain(vazamento)
    }
  })
})
