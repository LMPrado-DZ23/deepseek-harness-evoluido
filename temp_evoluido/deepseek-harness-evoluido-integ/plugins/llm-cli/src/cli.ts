import { spawn as spawnReal, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { t } from './i18n.js'

/**
 * Uma ferramenta de IA que a pessoa já tem instalada e já entrou com a conta
 * dela — Claude Code, Gemini CLI, Qwen Code, Codex CLI.
 *
 * A CONTA é o motivo desta conexão existir: a pessoa paga uma assinatura (ou
 * usa a cota gratuita da conta) e não quer, ou não pode, criar uma chave de
 * API. O FRIGG não vê nem guarda credencial nenhuma: quem fala com o provedor
 * é a ferramenta, com o login que ela mesma guardou.
 *
 * Os argumentos pedem o modo NÃO interativo e, onde a ferramenta oferece, o
 * modo que só lê — a ferramenta responde texto e não mexe em arquivo. A
 * pergunta vai pela entrada padrão, nunca pela linha de comando: um prompt de
 * geração passa de 100 KB, e a linha de comando tem teto e aparece em `ps`.
 */
export interface FerramentaDeLinha {
  /** A rota que aparece no seletor de modelos e na escolha de rota. */
  readonly rota: string
  /** O executável procurado no PATH. */
  readonly comando: string
  /** Os argumentos fixos; o modelo, quando escolhido, vem depois. */
  readonly argumentos: readonly string[]
  /** Como a ferramenta recebe um modelo escolhido. */
  readonly argumentoDeModelo: string
}

export const FERRAMENTAS_CONHECIDAS: readonly FerramentaDeLinha[] = [
  // `--tools ""` desliga todas as ferramentas do Claude Code: ele só responde.
  { rota: 'cli-claude', comando: 'claude', argumentos: ['-p', '--output-format', 'text', '--tools', ''], argumentoDeModelo: '--model' },
  // `-p ""` liga o modo sem interação e SOMA a entrada padrão; `plan` só lê.
  { rota: 'cli-gemini', comando: 'gemini', argumentos: ['-p', '', '-o', 'text', '--approval-mode', 'plan'], argumentoDeModelo: '--model' },
  { rota: 'cli-qwen', comando: 'qwen', argumentos: ['-p', '', '-o', 'text', '--approval-mode', 'plan'], argumentoDeModelo: '--model' },
  // `-` lê a pergunta da entrada padrão; o sandbox só de leitura impede escrita.
  { rota: 'cli-codex', comando: 'codex', argumentos: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], argumentoDeModelo: '--model' },
]

/** O modelo "o que a ferramenta já usa": nenhum `--model` é passado. */
export const MODELO_PADRAO = 'padrao'

/**
 * Onde o executável está no PATH, ou `undefined`.
 * @param comando - o nome do executável.
 * @param path - o PATH, separado pelo separador da plataforma.
 * @param executavel - diz se o caminho existe e pode ser executado.
 * @returns o caminho completo.
 */
export function acharNoPath(comando: string, path: string | undefined, executavel: (caminho: string) => boolean = podeExecutar): string | undefined {
  for (const pasta of (path ?? '').split(delimiter)) {
    if (pasta === '') continue
    const caminho = join(pasta, comando)
    if (executavel(caminho)) return caminho
  }
  return undefined
}

function podeExecutar(caminho: string): boolean {
  try {
    accessSync(caminho, constants.X_OK)
    return true
  } catch {
    // Ausente ou sem permissão de execução: as duas respostas são "não está aqui".
    return false
  }
}

/**
 * O ambiente que a ferramenta recebe: o do FRIGG, MENOS o que parece segredo.
 *
 * A ferramenta precisa de `HOME` (onde mora o login dela) e do `PATH`. Ela não
 * precisa das chaves que o FRIGG recebeu para outras rotas — e uma
 * `ANTHROPIC_API_KEY` herdada faria o Claude Code cobrar na chave em vez de
 * usar a assinatura, que é exatamente o contrário do que a pessoa escolheu.
 * @param ambiente - o ambiente do processo.
 * @returns uma cópia sem as variáveis com nome de segredo.
 */
export function ambienteSemSegredos(ambiente: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const saida: Record<string, string> = {}
  for (const [nome, valor] of Object.entries(ambiente)) {
    if (valor === undefined) continue
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/iu.test(nome)) continue
    saida[nome] = valor
  }
  return saida
}

/**
 * A conversa inteira como UM texto, que é o que uma ferramenta de linha recebe.
 *
 * LIMITE DECLARADO: a ferramenta não recebe a lista de ferramentas do agente e
 * não devolve chamada de ferramenta. Pela linha de comando, o agente CONVERSA;
 * pesquisar, escrever arquivo e agendar continuam precisando de uma rota com
 * chamada de ferramenta (o Ollama ou uma chave de API).
 * @param options - o pedido montado.
 * @returns a transcrição.
 */
export function transcricao(options: Pick<GenerateOptions, 'system' | 'messages'>): string {
  // Uma única mensagem da pessoa, sem instruções, vai CRUA: é o caso das
  // criações, e o cabeçalho só atrapalharia o modelo a achar o pedido.
  const unica = options.messages[0]
  if ((options.system ?? '').trim() === '' && options.messages.length === 1 && unica?.role === 'user') {
    return unica.content.map(textoDoBloco).filter(parte => parte !== '').join('\n')
  }
  const partes: string[] = []
  if (options.system !== undefined && options.system.trim() !== '') partes.push(`## ${t('papeis.system')}\n${options.system.trim()}`)
  for (const mensagem of options.messages) {
    const texto = mensagem.content.map(textoDoBloco).filter(parte => parte !== '').join('\n')
    if (texto === '') continue
    const papel = mensagem.content.every(bloco => bloco.type === 'tool-result') ? t('papeis.ferramenta') : t(`papeis.${mensagem.role}`)
    partes.push(`## ${papel}\n${texto}`)
  }
  return partes.join('\n\n')
}

function textoDoBloco(bloco: ContentBlock): string {
  switch (bloco.type) {
    case 'text': return bloco.text
    case 'tool-call': return `[${t('papeis.chamada')}: ${bloco.name} ${bloco.arguments}]`
    case 'tool-result': return bloco.content.map(textoDoBloco).filter(parte => parte !== '').join('\n')
    default:
      // Raciocínio e imagem não atravessam: a ferramenta recebe texto, e o
      // raciocínio anterior não é parte da conversa que ela precisa ver.
      return ''
  }
}

export interface Execucao {
  readonly caminho: string
  readonly comando: string
  readonly argumentos: readonly string[]
  readonly entrada: string
  readonly pasta: string
  readonly ambiente: Record<string, string>
  readonly tempoMs: number
  readonly maxBytes: number
  readonly signal?: AbortSignal
  readonly spawn?: (caminho: string, argumentos: readonly string[], opcoes: SpawnOptions) => ChildProcess
}

/**
 * Roda a ferramenta uma vez e devolve o que ela escreveu na saída padrão.
 *
 * Quatro saídas de erro, cada uma com a causa em português: código diferente
 * de zero (com o fim do que ela disse), tempo esgotado, saída acima do teto e
 * resposta vazia — a última é o sintoma típico de login vencido.
 * @param execucao - o que rodar e com que limites.
 * @returns o texto da resposta.
 */
export function executar(execucao: Execucao): Promise<string> {
  const iniciar = execucao.spawn ?? ((caminho, argumentos, opcoes) => spawnReal(caminho, [...argumentos], opcoes))
  return new Promise((resolve, reject) => {
    if (execucao.signal?.aborted === true) { reject(new Error(t('errors.cancelado'))); return }
    let filho: ChildProcess
    try {
      filho = iniciar(execucao.caminho, execucao.argumentos, { cwd: execucao.pasta, env: execucao.ambiente, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    } catch (error) {
      reject(new Error(t('errors.naoAbriu', { comando: execucao.comando, motivo: error instanceof Error ? error.message : String(error) })))
      return
    }
    const saida: Buffer[] = []
    const erro: Buffer[] = []
    let bytes = 0
    let fim: Error | undefined
    const parar = (motivo: Error): void => {
      if (fim !== undefined) return
      fim = motivo
      filho.kill('SIGTERM')
    }
    const relogio = setTimeout(() => parar(new Error(t('errors.tempoEsgotado', { comando: execucao.comando, segundos: Math.round(execucao.tempoMs / 1000) }))), execucao.tempoMs)
    const aoCancelar = (): void => parar(new Error(t('errors.cancelado')))
    execucao.signal?.addEventListener('abort', aoCancelar, { once: true })
    filho.stdout?.on('data', (pedaco: Buffer) => {
      bytes += pedaco.length
      if (bytes > execucao.maxBytes) { parar(new Error(t('errors.saidaGrande', { comando: execucao.comando }))); return }
      saida.push(pedaco)
    })
    filho.stderr?.on('data', (pedaco: Buffer) => { if (erro.reduce((soma, parte) => soma + parte.length, 0) < 64 * 1024) erro.push(pedaco) })
    filho.on('error', error => parar(new Error(t('errors.naoAbriu', { comando: execucao.comando, motivo: error.message }))))
    filho.on('close', codigo => {
      clearTimeout(relogio)
      execucao.signal?.removeEventListener('abort', aoCancelar)
      if (fim !== undefined) { reject(fim); return }
      const texto = Buffer.concat(saida).toString('utf8').trim()
      if (codigo !== 0) {
        const disse = (Buffer.concat(erro).toString('utf8').trim() || texto).slice(-600)
        reject(new Error(t('errors.saiuComErro', { comando: execucao.comando, codigo: String(codigo), saida: disse })))
        return
      }
      if (texto === '') { reject(new Error(t('errors.respostaVazia', { comando: execucao.comando }))); return }
      resolve(texto)
    })
    // A pergunta vai inteira e a entrada é FECHADA: sem o fim, a ferramenta
    // esperaria mais texto para sempre.
    filho.stdin?.on('error', () => {
      // A ferramenta fechou a entrada antes de ler tudo (saiu cedo). Quem
      // responde por isso é o `close`, com o código e o que ela disse.
    })
    filho.stdin?.end(execucao.entrada)
  })
}
