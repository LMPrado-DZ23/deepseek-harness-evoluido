import { randomUUID } from 'node:crypto'
import { findSecret } from '@dz23-studio/integration-hub'
import { AssistantConversationError } from './assistant-conversation.js'
import { t } from './i18n.js'

/**
 * Teto por arquivo. Vale para os BYTES, nunca para o base64 que os transportou:
 * medir o transporte deixaria o limite 33% maior do que o anunciado, e a pessoa
 * receberia "grande demais" num arquivo que a tela dizia caber.
 */
export const MAX_ATTACHMENT_BYTES = 512 * 1024
/**
 * Teto por conversa. Existe separado do teto por arquivo porque sem ele mil
 * arquivos de 512 KiB dentro do limite individual somariam 512 MiB na memória
 * do servidor - o limite por arquivo sozinho não é limite nenhum.
 */
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 2 * 1024 * 1024
/** Quantos anexos uma única mensagem pode carregar. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5
/**
 * Quanto tempo uma referência vive antes de ser esquecida.
 *
 * O anexo existe para a distância entre escolher o arquivo e apertar Enviar.
 * Depois disso quem guarda é o Harness, que promove os bytes da imagem para uma
 * referência durável dele. Guardar aqui para sempre seria manter uma segunda
 * cópia do arquivo da pessoa num lugar que ninguém audita.
 */
export const ATTACHMENT_TTL_MS = 60 * 60 * 1000
/** Tamanho do nome exibível. Um nome de 4 KB não é nome, é carga. */
const MAX_DISPLAY_NAME_CHARS = 80

/**
 * A lista FECHADA do que é aceito, e ela é decidida pelo conteúdo.
 *
 * Extensão e `content-type` são dois campos que o cliente escreve: os dois
 * mentem de graça. Um executável renomeado para `notas.txt` chega aqui com a
 * extensão certa e o cabeçalho certo, e é o primeiro byte que o desmente.
 */
export type AttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'text/plain'

/**
 * A quem o anexo pertence. Os quatro campos juntos são o isolamento inteiro:
 * pessoa, organização, espaço de trabalho e conversa. Tirar qualquer um deles
 * transforma a referência opaca numa referência adivinhável por outro escopo.
 */
export interface AssistantAttachmentScope {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly conversationId: string
}

/**
 * O que atravessa para o navegador. Não há caminho, diretório, extensão
 * original nem qualquer coisa que revele onde os bytes estão: `attachment_id`
 * é opaco e só significa alguma coisa dentro do escopo que o criou.
 */
export interface AssistantAttachmentReference {
  readonly attachment_id: string
  /** Nome higienizado, só para a pessoa ler. Nunca vira caminho em disco. */
  readonly name: string
  readonly size: number
  readonly media_type: AttachmentMediaType
}

/** Um anexo guardado, com os bytes que só o servidor vê. */
export interface StoredAssistantAttachment {
  readonly reference: AssistantAttachmentReference
  readonly bytes: Buffer
}

export interface AssistantAttachmentStoreOptions {
  readonly now?: () => number
  readonly createId?: () => string
}

/**
 * Nome exibível a partir de um nome hostil.
 *
 * O nome do arquivo é dado da pessoa e chega inteiro: pode trazer
 * `../../etc/passwd`, `C:\Windows\system32`, um NUL no meio, uma marca de
 * direção que faz `foto.exe` aparecer como `foto.gpj` na tela. Esta função
 * devolve um nome para LER, e o resto do módulo não tem nenhuma função de
 * sistema de arquivos - o nome não poderia virar caminho nem se alguém tentasse.
 * @param filename - o nome recebido do cliente, sem nenhuma confiança.
 * @returns um nome curto, sem separador de caminho, sem controle e sem bidi.
 */
export function displayAttachmentName(filename: string): string {
  const lastSeparator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const base = lastSeparator === -1 ? filename : filename.slice(lastSeparator + 1)
  const cleaned = base
    // Controle C0/C1 e DEL: um `\r` no nome quebra qualquer log que o registre.
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, '')
    // Marcas de direção e isolamento: é com elas que se disfarça a extensão.
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_CHARS)
  // Um nome só de pontos (`.`, `..`) não é nome: é a travessia escrita por
  // extenso. Mostrar isso na tela ensinaria a pessoa que o Studio a aceitou.
  if (cleaned === '' || cleaned.replaceAll('.', '') === '') return t('assistant.attachmentDefaultName')
  return cleaned
}

/**
 * O tipo real destes bytes, ou `undefined` quando não é nenhum dos aceitos.
 *
 * A ordem importa: as assinaturas binárias vêm primeiro, e o texto é o ÚLTIMO
 * teste. Ao contrário, um PNG cujo cabeçalho por acaso decodificasse passaria
 * como texto; e é o texto que precisa provar que é texto, não o inverso.
 * @param bytes - o conteúdo inteiro do arquivo.
 */
export function detectAttachmentType(bytes: Buffer): AttachmentMediaType | undefined {
  if (bytes.length === 0) return undefined
  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png'
  if (startsWith(bytes, [0xFF, 0xD8, 0xFF])) return 'image/jpeg'
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return isPlainText(bytes) ? 'text/plain' : undefined
}

/**
 * Os anexos em voo de uma instalação, na memória do processo.
 *
 * Deliberadamente NÃO é um domínio persistido: nenhum campo novo em registro
 * gravado, nenhuma versão de domínio para subir, e nenhuma segunda cópia
 * duradoura do arquivo de alguém. Uma referência que o processo esqueceu
 * responde "anexo não está mais disponível" - a frase é do catálogo e diz à
 * pessoa para anexar de novo, em vez de inventar que o arquivo sumiu.
 */
export class AssistantAttachmentStore {
  readonly #items = new Map<string, { readonly scopeKey: string; readonly stored: StoredAssistantAttachment; readonly expiresAt: number }>()
  readonly #now: () => number
  readonly #createId: () => string

  constructor(options: AssistantAttachmentStoreOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
  }

  /**
   * Verifica e guarda um arquivo, devolvendo só a referência opaca.
   *
   * A ordem das recusas é a ordem do custo: tamanho antes de tipo, tipo antes
   * de varredura. Varrer 512 KiB de um arquivo que já era grande demais seria
   * trabalho feito para nada.
   * @param scope - pessoa, organização, espaço e conversa donos deste anexo.
   * @param filename - o nome recebido do cliente, tratado como hostil.
   * @param bytes - o conteúdo já decodificado.
   * @throws AssistantConversationError quando o anexo é recusado.
   */
  put(scope: AssistantAttachmentScope, filename: string, bytes: Buffer): AssistantAttachmentReference {
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentTooLarge'))
    }
    const mediaType = detectAttachmentType(bytes)
    if (mediaType === undefined) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentTypeNotAccepted'))
    }
    // A varredura de segredos do repositório, aplicada aos BYTES. O nome que ela
    // recebe é sintético e fixo de propósito: ele existe só para dizer ao
    // scanner "isto é legível", e o achado que volta é esse nome, nunca o
    // trecho encontrado. Uma chave colada em metadado de imagem é ASCII dentro
    // do arquivo e cai no mesmo padrão que uma colada num `.txt`.
    if (findSecret(SCAN_SUBJECT, bytes) !== null) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentRejectedSecret'))
    }
    const scopeKey = attachmentScopeKey(scope)
    this.#forget()
    const used = [...this.#items.values()]
      .filter(item => item.scopeKey === scopeKey)
      .reduce((total, item) => total + item.stored.reference.size, 0)
    if (used + bytes.length > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentQuotaExceeded'))
    }
    const reference: AssistantAttachmentReference = {
      attachment_id: this.#createId(),
      name: displayAttachmentName(filename),
      size: bytes.length,
      media_type: mediaType,
    }
    this.#items.set(reference.attachment_id, {
      scopeKey,
      stored: { reference, bytes },
      expiresAt: this.#now() + ATTACHMENT_TTL_MS,
    })
    return reference
  }

  /**
   * Os anexos destas referências, na ordem pedida.
   *
   * Uma referência de OUTRO escopo não é lida: ela não existe aqui. A resposta
   * é a mesma de uma referência que nunca existiu, porque distinguir as duas
   * contaria a quem tentou que o identificador era real.
   * @throws AssistantConversationError quando qualquer referência não é deste escopo.
   */
  resolve(scope: AssistantAttachmentScope, ids: readonly string[]): readonly StoredAssistantAttachment[] {
    const scopeKey = attachmentScopeKey(scope)
    this.#forget()
    const now = this.#now()
    return ids.map(id => {
      const item = this.#items.get(id)
      if (item === undefined || item.scopeKey !== scopeKey || item.expiresAt <= now) {
        throw new AssistantConversationError('NOT_FOUND', t('assistant.attachmentMissing'))
      }
      return item.stored
    })
  }

  /**
   * Esquece os anexos já entregues ao Harness.
   *
   * Sem isto a mesma referência serviria para uma segunda mensagem e os bytes
   * ficariam na memória até o TTL - duas coisas que ninguém pediu.
   */
  consume(scope: AssistantAttachmentScope, ids: readonly string[]): void {
    const scopeKey = attachmentScopeKey(scope)
    for (const id of ids) {
      if (this.#items.get(id)?.scopeKey === scopeKey) this.#items.delete(id)
    }
  }

  /** Quantos anexos vivos existem. Só para teste e para diagnóstico. */
  size(): number { return this.#items.size }

  /** Descarta o que venceu. Vencido é indistinguível de inexistente. */
  #forget(): void {
    const now = this.#now()
    for (const [id, item] of this.#items) {
      if (item.expiresAt <= now) this.#items.delete(id)
    }
  }
}

/**
 * O nome que a varredura recebe. Fixo e sem relação com o nome da pessoa: o
 * scanner devolve o nome que recebeu, e devolver o nome do cliente faria a
 * mensagem de recusa carregar de volta o texto hostil que ela veio negar.
 */
const SCAN_SUBJECT = 'anexo.txt'

/** A chave do escopo. Uma grafia só, porque duas seriam dois isolamentos. */
export function attachmentScopeKey(scope: AssistantAttachmentScope): string {
  // `\u0000` separa porque não pode aparecer em nenhum dos campos: com `:` um
  // `org:a` + `tenant:b` colidiria com `org:a:b` + `tenant:` vazio.
  return [scope.orgId, scope.tenantId, scope.userId, scope.conversationId].join('\u0000')
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Texto de verdade: UTF-8 válido, sem NUL e sem controle além de tabulação e
 * quebra de linha. Um binário qualquer quase sempre falha o UTF-8; o que passa
 * pelo UTF-8 e ainda assim é binário costuma trazer controle, e cai aqui.
 */
function isPlainText(bytes: Buffer): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)
}
