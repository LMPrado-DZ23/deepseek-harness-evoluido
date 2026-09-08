/**
 * O transporte stdio de um servidor MCP: um processo filho, JSON-RPC 2.0 em
 * linhas, e o encerramento garantido.
 *
 * Por que JSON-RPC direto e não o SDK oficial (`@modelcontextprotocol/sdk`,
 * que está instalado neste repositório):
 *
 * 1. O `StdioClientTransport` do SDK monta o ambiente do filho a partir de uma
 *    lista de variáveis do processo pai quando nenhuma é passada. Aqui o
 *    ambiente NÃO pode ter esse caminho: ele é construído do zero em
 *    `environment.ts`, e uma camada que sabe herdar é uma camada de onde um dia
 *    alguém herda.
 * 2. O teto de TAMANHO de mensagem tem de ser aplicado no enquadramento, antes
 *    de a linha virar objeto. O SDK entrega mensagens já desserializadas: o
 *    limite chegaria depois de a memória já ter sido gasta.
 * 3. O encerramento tem de ser SIGTERM, espera curta e SIGKILL, com a garantia
 *    de que nenhum filho sobrevive ao processo do Studio. Isso é política deste
 *    repositório (ver `plugins/builder-supervisor`), não do SDK.
 *
 * O que este arquivo NÃO faz: teto de chamadas por escopo, repetição única,
 * custo e auditoria. Tudo isso já existe em `plugins/integration-hub` e
 * duplicá-lo aqui criaria dois limites que discordariam.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { t } from './i18n.js'
import { childEnvironment } from './environment.js'
import {
  jsonRpcIncomingSchema, jsonRpcResponseSchema,
  type McpConnectionLimits, type McpServerCommand,
} from './model.js'

export type McpErrorCode =
  | 'SPAWN_FAILED' | 'HANDSHAKE_TIMEOUT' | 'CALL_TIMEOUT' | 'ABORTED'
  | 'MESSAGE_TOO_LARGE' | 'PROTOCOL_VIOLATION' | 'VERSION_UNSUPPORTED'
  | 'TOO_MANY_TOOLS' | 'CLOSED' | 'TOOL_NOT_OFFERED' | 'SERVER_ERROR'

export class McpError extends Error {
  constructor(readonly code: McpErrorCode, message: string) {
    super(message)
    this.name = 'McpError'
  }
}

/**
 * Todo processo filho que este módulo iniciou e que ainda não morreu.
 *
 * Existe por causa de um acidente já ocorrido neste repositório: processos de
 * teste que sobreviveram à suíte e ficaram consumindo a máquina. Um `close()`
 * bem escrito não basta — o que precisa ser verdade é que nem uma saída abrupta
 * do processo do Studio deixe servidor MCP rodando.
 */
const liveChildren = new Set<ChildProcessWithoutNullStreams>()
let exitHookInstalled = false

function trackChild(child: ChildProcessWithoutNullStreams): void {
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  // `error` também: um executável inexistente não gera processo e nunca emite
  // `exit`, e sem esta linha ele ficaria para sempre na lista de vivos —
  // fazendo a prova "não sobrou nada" acusar um processo que jamais existiu.
  child.once('error', () => liveChildren.delete(child))
  if (exitHookInstalled) return
  exitHookInstalled = true
  // `exit` só admite trabalho síncrono, e `kill` é síncrono. Não há await
  // possível aqui: o objetivo não é encerrar com elegância, é não deixar órfão.
  process.once('exit', () => { for (const live of liveChildren) { try { live.kill('SIGKILL') } catch { /* já morreu */ } } })
}

/** Quantos servidores MCP este processo tem vivos agora. Existe para o teste poder provar que sobrou zero. */
export function liveMcpChildCount(): number { return liveChildren.size }

/** Mata, sem cerimônia, todo servidor MCP que este módulo iniciou. Rede de segurança do `afterEach`. */
export function killAllMcpChildren(): number {
  const count = liveChildren.size
  for (const live of liveChildren) { try { live.kill('SIGKILL') } catch { /* já morreu */ } }
  return count
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: McpError) => void
}

/**
 * Uma conexão viva com um servidor MCP por stdio.
 *
 * A instância é de uso único: depois de `close()` ela não reconecta. Reconectar
 * silenciosamente esconderia de quem chamou que o processo do outro lado é
 * outro — com outro estado, outra lista de ferramentas e outro tempo de vida.
 */
export class StdioMcpTransport {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #limits: McpConnectionLimits
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #buffer = ''
  #closed: McpError | undefined
  #exited: Promise<void>
  /** Só a CONTAGEM de bytes do erro padrão; o conteúdo costuma trazer caminho, banner e às vezes segredo. */
  #stderrBytes = 0

  private constructor(child: ChildProcessWithoutNullStreams, limits: McpConnectionLimits) {
    this.#child = child
    this.#limits = limits
    // `exit`, `close` E `error`: um executável que não existe NUNCA emite `exit`
    // — não houve processo. Esperar só por `exit` deixava `close()` pendurado
    // para sempre exatamente no caso em que não há nada para encerrar.
    this.#exited = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk))
    // O erro padrão PRECISA ser consumido: um cano cheio bloqueia o filho, e um
    // servidor bloqueado parece um servidor lento — o diagnóstico errado.
    child.stderr.on('data', (chunk: Buffer) => { this.#stderrBytes += chunk.byteLength })
    child.once('exit', () => this.#failAll(new McpError('CLOSED', t('errors.connectionClosed'))))
    child.once('error', () => { void this.#destroy(new McpError('SPAWN_FAILED', t('errors.spawnFailed'))) })
    // Um cano de entrada que quebra (servidor morreu no meio de uma escrita)
    // vira exceção sem dono no Node e derruba o processo do Studio inteiro.
    child.stdin.on('error', () => undefined)
  }

  /**
   * Inicia o servidor e devolve o transporte pronto para falar.
   *
   * O que é isolado aqui, de verdade: pasta de trabalho explícita, ambiente
   * construído do zero, nenhum interpretador de comandos (`shell: false`, então
   * nada de expansão nem de `;`), e nenhum descritor extra além dos três canos.
   * O que NÃO é isolado está declarado no cabeçalho de `index.ts` deste plugin:
   * o filho continua no mesmo espaço de rede e no mesmo sistema de arquivos que
   * o Studio, com o mesmo usuário.
   * @param command - o executável, os argumentos, a pasta e o ambiente declarados.
   * @param limits - os tetos desta conexão.
   * @returns o transporte, com o processo já no ar.
   */
  static start(command: McpServerCommand, limits: McpConnectionLimits): StdioMcpTransport {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.command, [...command.args], {
        cwd: command.cwd,
        env: childEnvironment(command.env),
        shell: false,
        windowsHide: true,
        // `detached: false`: o filho fica no grupo de processos do Studio. A
        // consequência honesta é que um NETO que o servidor MCP crie não é
        // alcançado por `kill` daqui — está declarado, não contornado.
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      throw new McpError('SPAWN_FAILED', t('errors.spawnFailed'))
    }
    trackChild(child)
    return new StdioMcpTransport(child, limits)
  }

  /** O identificador do processo, para quem precisa observá-lo de fora (o teste observa). */
  get pid(): number | undefined { return this.#child.pid }

  /** Se este transporte já foi encerrado, por qualquer motivo. */
  get closed(): boolean { return this.#closed !== undefined }

  /** Bytes que o servidor escreveu no erro padrão. A CONTAGEM viaja; o conteúdo, nunca. */
  get stderrBytes(): number { return this.#stderrBytes }

  /**
   * Uma requisição JSON-RPC, presa a um tempo máximo e a um sinal de desistência.
   *
   * Estourar o tempo aqui MATA o processo em vez de abandoná-lo. É diferente do
   * que o Hub faz com uma chamada de rede (lá o Studio desiste de esperar e o
   * outro lado segue vivo): um processo filho é responsabilidade deste
   * computador, e deixá-lo rodando depois de desistir dele é como se acumulam
   * processos órfãos.
   * @param method - o método JSON-RPC.
   * @param params - os parâmetros, já no formato do protocolo.
   * @param options - o tempo máximo desta requisição e o sinal de quem chamou.
   * @returns o `result` do servidor.
   */
  async request(method: string, params: unknown, options: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined }): Promise<unknown> {
    if (this.#closed !== undefined) throw this.#closed
    const id = this.#nextId
    this.#nextId += 1
    const answer = new Promise<unknown>((resolve, reject) => { this.#pending.set(id, { resolve, reject }) })
    this.#write({ jsonrpc: '2.0', id, method, params })
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => { void this.#destroy(new McpError('ABORTED', t('errors.aborted'))) }
    try {
      return await Promise.race([
        answer,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new McpError(method === 'initialize' ? 'HANDSHAKE_TIMEOUT' : 'CALL_TIMEOUT',
              method === 'initialize' ? t('errors.handshakeTimedOut') : t('errors.callTimedOut'))
            // O MESMO erro recusa esta requisição e derruba a conexão. Isso
            // importa: `#destroy` também recusa tudo o que está pendente, e as
            // duas rejeições correm. Passando o mesmo objeto, ganhe quem ganhar
            // a corrida, quem chamou recebe "passou do tempo máximo" — e não "a
            // conexão terminou", que seria a consequência, não a causa.
            reject(error)
            void this.#destroy(error)
          }, options.timeoutMs)
          timer.unref?.()
          options.signal?.addEventListener('abort', onAbort, { once: true })
          if (options.signal?.aborted === true) onAbort()
        }),
      ])
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      this.#pending.delete(id)
    }
  }

  /** Um aviso JSON-RPC (sem `id`): não há resposta a esperar. */
  notify(method: string, params?: unknown): void {
    if (this.#closed !== undefined) return
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Encerra a conexão e o processo, nesta ordem: fecha a entrada, pede saída com
   * SIGTERM, espera a carência e manda SIGKILL. Só volta quando o processo saiu.
   *
   * É idempotente e nunca lança: chamar `close()` num transporte já morto é o
   * caso NORMAL num `finally`, e um erro aqui esconderia o erro de verdade.
   */
  async close(): Promise<void> {
    await this.#destroy(new McpError('CLOSED', t('errors.connectionClosed')))
  }

  async #destroy(reason: McpError): Promise<void> {
    if (this.#closed === undefined) this.#closed = reason
    this.#failAll(reason)
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      try { this.#child.stdin.end() } catch { /* já fechado */ }
      try { this.#child.kill('SIGTERM') } catch { /* já morreu */ }
      const graceful = await Promise.race([
        this.#exited.then(() => true),
        new Promise<false>(resolve => { const timer = setTimeout(() => resolve(false), this.#limits.shutdownGraceMs); timer.unref?.() }),
      ])
      // A carência é uma cortesia, não uma esperança: quem não saiu sozinho sai
      // com SIGKILL. Sem esta linha, um servidor que ignora SIGTERM fica de pé
      // para sempre — foi assim que este repositório juntou centenas de órfãos.
      if (!graceful) { try { this.#child.kill('SIGKILL') } catch { /* já morreu */ } }
    }
    await this.#exited
  }

  #failAll(reason: McpError): void {
    for (const [id, pending] of [...this.#pending.entries()]) {
      this.#pending.delete(id)
      pending.reject(reason)
    }
  }

  #write(message: unknown): void {
    try { this.#child.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* o `exit` já vai recusar os pendentes */ }
  }

  #onStdout(chunk: string): void {
    if (this.#closed !== undefined) return
    this.#buffer += chunk
    // O teto vale para o que se ACUMULA sem terminar em linha: sem isto, um
    // servidor que nunca manda `\n` faz a memória do Studio crescer sem limite
    // e o teto por mensagem nunca chega a ser consultado.
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#limits.maxMessageBytes) {
      void this.#destroy(new McpError('MESSAGE_TOO_LARGE', t('errors.messageTooLarge')))
      return
    }
    for (;;) {
      const cut = this.#buffer.indexOf('\n')
      if (cut < 0) break
      const line = this.#buffer.slice(0, cut).trim()
      this.#buffer = this.#buffer.slice(cut + 1)
      if (line === '') continue
      if (!this.#onLine(line)) return
    }
  }

  /** @returns `false` quando a conexão foi encerrada por esta linha. */
  #onLine(line: string): boolean {
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch {
      void this.#destroy(new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation')))
      return false
    }
    const incoming = jsonRpcIncomingSchema.safeParse(parsed)
    if (!incoming.success) {
      void this.#destroy(new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation')))
      return false
    }
    // Aviso do servidor (progresso, lista mudou): não há nada a casar. Ignorar é
    // correto — este cliente não assina nada que dependa deles.
    if (incoming.data.id === undefined) return true
    // Pedido DO servidor (amostragem, raízes): este cliente não anuncia essas
    // capacidades. Responder "método não existe" é o que o protocolo manda; o
    // silêncio deixaria o servidor esperando para sempre.
    if (typeof incoming.data.method === 'string') {
      this.#write({ jsonrpc: '2.0', id: incoming.data.id, error: { code: -32601, message: 'method not found' } })
      return true
    }
    const response = jsonRpcResponseSchema.safeParse(parsed)
    if (!response.success || typeof response.data.id !== 'number') {
      void this.#destroy(new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation')))
      return false
    }
    const pending = this.#pending.get(response.data.id)
    // Resposta para um `id` que ninguém está esperando: já expirou ou é ruído.
    // Descartar é seguro; derrubar a conexão por isso não seria.
    if (pending === undefined) return true
    this.#pending.delete(response.data.id)
    if (response.data.error !== undefined) {
      // Só o CÓDIGO do erro atravessa: a mensagem de um servidor de terceiro
      // costuma trazer caminho, argumento e às vezes o segredo que ele leu.
      pending.reject(new McpError('SERVER_ERROR', t('errors.toolFailed')))
      return true
    }
    pending.resolve(response.data.result)
    return true
  }
}
