import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  stagingProviderReceiptSchema,
  type StagingArtifact,
  type StagingProviderReceipt,
} from './model.js'
import type {
  StagingProviderPort,
  StagingProviderResult,
  StagingProviderStatus,
} from './service.js'

/**
 * O destino de staging que este produto realmente tem: uma pasta local.
 *
 * DECISÃO: staging na v1.0 publica num diretório do próprio computador, e não
 * num servidor na internet. Um destino em rede exige credencial, domínio e
 * autorização que o produto não tem — e um provedor que fingisse publicar
 * seria pior que a ausência dele. O que este provedor faz é REAL e
 * verificável: os arquivos ficam lá, imutáveis por geração, com recibo.
 *
 * Três coisas que ele garante, e que são o motivo de ele existir em vez de uma
 * cópia de diretório:
 *
 * 1. **Verifica antes de publicar.** Cada arquivo é conferido contra o
 *    manifesto atestado. Um artefato que mudou entre a verificação e a
 *    publicação NÃO é publicado — é exatamente entre esses dois momentos que
 *    algo trocado passaria despercebido.
 * 2. **Publica por renomeação.** A geração é montada num diretório temporário
 *    e só então renomeada para o lugar final. Sem isso, uma queda no meio da
 *    cópia deixaria meia aplicação publicada e servindo.
 * 3. **É idempotente pela chave do pedido.** Repetir a mesma publicação
 *    devolve o MESMO recibo, sem copiar de novo. É isso que permite ao Studio
 *    perguntar "aconteceu?" depois de uma resposta perdida.
 */

/** Uma entrada do manifesto atestado, do jeito que o provedor a confere. */
export interface VerifiedFile {
  readonly path: string
  readonly sha256: string
}

/**
 * De onde saem os bytes do artefato e o manifesto que os descreve.
 *
 * O provedor não sabe onde ficam as execuções: quem monta é que sabe. Assim
 * este arquivo continua testável sem inventar uma árvore de diretórios.
 */
export interface StagingArtifactBytesPort {
  /**
   * @param artifact - o artefato selado.
   * @returns o diretório com os arquivos e o manifesto atestado deles.
   */
  open(artifact: StagingArtifact): Promise<{
    readonly directory: string
    readonly files: readonly VerifiedFile[]
  }>
}

export interface LocalStagingProviderOptions {
  readonly providerId?: string
  readonly targetRef: string
  /** Onde as gerações publicadas ficam. Um caminho absoluto, sempre. */
  readonly root: string
  readonly artifacts: StagingArtifactBytesPort
  readonly now?: () => Date
}

/**
 * Uma geração que pode virar segmento de caminho.
 *
 * O serviço só aloca inteiros positivos, então isto é segunda tranca — mas ela
 * vale na ESCRITA, e não só na leitura: uma geração absurda ali criaria um
 * diretório de lixo dentro da raiz de staging, e ninguém saberia de onde veio.
 * @param generation - a geração pedida.
 * @returns se ela é utilizável.
 */
export function usableGeneration(generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > 0
}

const RECEIPT_FILE = 'receipt.json'
const CURRENT_FILE = 'current.json'

/**
 * O nome de pasta de um destino.
 *
 * Derivado por HASH, e não pelo texto do destino: `dz23-target:staging-main`
 * tem dois-pontos, que não é nome de arquivo em todo sistema, e um destino
 * escolhido por configuração não pode virar um caminho que escape da raiz.
 * @param targetRef - a referência do destino.
 * @returns o nome de pasta.
 */
export function targetFolder(targetRef: string): string {
  return createHash('sha256').update(targetRef).digest('hex').slice(0, 32)
}

/**
 * Confere cada arquivo do artefato contra o manifesto atestado.
 *
 * Arquivo a MAIS também reprova: um artefato com um arquivo que o manifesto não
 * lista não é o artefato que foi verificado, e publicá-lo seria publicar algo
 * que ninguém atestou.
 * @param directory - o diretório do artefato.
 * @param files - o manifesto atestado.
 * @returns o primeiro problema encontrado, ou `undefined`.
 */
export async function verifyArtifactFiles(
  directory: string,
  files: readonly VerifiedFile[],
): Promise<string | undefined> {
  const expected = new Map(files.map(file => [file.path, file.sha256]))
  const found = await listFiles(directory)
  for (const path of found) {
    const declared = expected.get(path)
    if (declared === undefined) return `ARTIFACT_FILE_NOT_ATTESTED:${path}`
    const digest = createHash('sha256').update(await readFile(join(directory, path))).digest('hex')
    if (digest !== declared) return `ARTIFACT_FILE_MODIFIED:${path}`
    expected.delete(path)
  }
  const missing = [...expected.keys()][0]
  return missing === undefined ? undefined : `ARTIFACT_FILE_MISSING:${missing}`
}

async function listFiles(directory: string, prefix = ''): Promise<readonly string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    // Um link simbólico não é conferível pelo conteúdo do alvo: ele aponta para
    // fora do que foi atestado, e publicar um é publicar o que estiver lá.
    if (entry.isSymbolicLink()) throw new Error(`ARTIFACT_SYMLINK:${relativePath}`)
    if (entry.isDirectory()) found.push(...await listFiles(directory, relativePath))
    else if (entry.isFile()) found.push(relativePath)
  }
  return found.sort()
}

export class LocalStagingProvider implements StagingProviderPort {
  readonly providerId: string
  readonly targetRef: string
  readonly #root: string
  readonly #now: () => Date

  constructor(private readonly options: LocalStagingProviderOptions) {
    this.providerId = options.providerId ?? 'local-staging'
    this.targetRef = options.targetRef
    if (!isAbsolute(options.root)) throw new Error('STAGING_ROOT_MUST_BE_ABSOLUTE')
    this.#root = resolve(options.root)
    this.#now = options.now ?? (() => new Date())
  }

  stage(input: Parameters<StagingProviderPort['stage']>[0], signal: AbortSignal): Promise<StagingProviderResult> {
    return this.#publish(input, 'PUBLISH', signal)
  }

  rollback(input: Parameters<StagingProviderPort['rollback']>[0], signal: AbortSignal): Promise<StagingProviderResult> {
    // Um rollback é uma publicação nova de um artefato antigo. Nada é apagado:
    // a geração anterior continua no disco, e é isso que permite voltar de novo.
    return this.#publish(input, 'ROLLBACK', signal)
  }

  async status(input: Parameters<StagingProviderPort['status']>[0], _signal: AbortSignal): Promise<StagingProviderStatus> {
    const receipt = await this.#readReceipt(input.targetGeneration)
    // Ausente e ilegível respondem o mesmo AQUI, e por razões diferentes: de um
    // lado não há nada para adotar, do outro não dá para afirmar o que há.
    // `UNKNOWN` é a resposta honesta para os dois, e é a reconciliação que
    // decide — diferente de `#publish`, onde os dois mandam para lados opostos.
    if (receipt === 'AUSENTE' || receipt === 'ILEGIVEL') return { state: 'UNKNOWN' }
    // O recibo só serve se for DESTE pedido. Um recibo de outra operação na
    // mesma geração significa que alguém mais mexeu no destino, e responder
    // READY ali faria o Studio adotar um efeito que não é dele.
    if (receipt.operation_id !== input.operationId || receipt.artifact_sha256 !== input.artifactSha256) {
      return { state: 'UNKNOWN' }
    }
    return { state: 'READY', receipt }
  }

  async #publish(
    input: {
      readonly operationId: string
      readonly idempotencyKey: string
      readonly targetGeneration: number
      readonly artifact: StagingArtifact
    },
    kind: 'PUBLISH' | 'ROLLBACK',
    signal: AbortSignal,
  ): Promise<StagingProviderResult> {
    if (!usableGeneration(input.targetGeneration)) {
      return { kind: 'definitive-no-effect', failureCode: 'INVALID_TARGET_GENERATION' }
    }
    // Repetição: o mesmo pedido devolve o MESMO recibo, sem copiar de novo.
    const existing = await this.#readReceipt(input.targetGeneration)
    // Um recibo que ESTÁ LÁ e não dá para ler não libera a geração: publicar em
    // cima seria escrever sobre um efeito que talvez já exista, e o `rename`
    // falharia de qualquer forma — só que como exceção, virando quarentena.
    if (existing === 'ILEGIVEL') return { kind: 'definitive-no-effect', failureCode: 'TARGET_RECEIPT_UNREADABLE' }
    if (existing !== 'AUSENTE') {
      if (existing.operation_id === input.operationId && existing.artifact_sha256 === input.artifact.artifact_sha256) {
        return { kind: 'accepted', receipt: existing }
      }
      // Outra operação já ocupa esta geração. Sobrescrever apagaria um efeito
      // que outro release considera seu.
      return { kind: 'definitive-no-effect', failureCode: 'TARGET_GENERATION_TAKEN' }
    }
    // ABRIR O ARTEFATO era a ÚNICA chamada deste método fora de um `try`, e a
    // revisão adversarial mostrou o que isso custava. `artifacts.open` lança
    // para condições que são DEFINITIVAMENTE sem efeito — manifesto ausente,
    // vazio, ou com impressão que não bate —, e a exceção subia até o `catch`
    // do serviço, que a traduz em `PROVIDER_EFFECT_UNKNOWN`. O código SABIA que
    // nada tinha acontecido e afirmava não saber; e como o destino físico é um
    // só para a instalação inteira, um manifesto torto de um projeto deixava o
    // staging de todo mundo em quarentena, sem saída — a saída da quarentena
    // exige um recibo do provedor, e recibo de uma publicação que nunca começou
    // não existe.
    //
    // Ausência de prova nunca vira prova, e aqui o inverso também vale: PROVA
    // de ausência não pode virar ausência de prova.
    let source: Awaited<ReturnType<StagingArtifactBytesPort['open']>>
    try { source = await this.options.artifacts.open(input.artifact) }
    catch (error) { return { kind: 'definitive-no-effect', failureCode: definitiveCode(error instanceof Error ? error.message : 'ARTIFACT_UNREADABLE') } }
    let problem: string | undefined
    try { problem = await verifyArtifactFiles(source.directory, source.files) }
    catch (error) { problem = error instanceof Error ? error.message : 'ARTIFACT_UNREADABLE' }
    if (problem !== undefined) {
      // Nada foi copiado: a recusa é DEFINITIVA e sem efeito, que é a única
      // resposta que o serviço pode transformar em falha em vez de reconciliação.
      return { kind: 'definitive-no-effect', failureCode: definitiveCode(problem) }
    }
    if (signal.aborted) return { kind: 'definitive-no-effect', failureCode: 'CANCELLED_BEFORE_COPY' }
    const folder = join(this.#root, targetFolder(this.targetRef))
    const destination = join(folder, String(input.targetGeneration))
    const pending = `${destination}.pending-${input.idempotencyKey.slice(0, 16)}`
    // `pending` é NOSSO e nada nele está servindo: um erro de disco daqui até
    // o `rename` é sem efeito, e dizê-lo é o que impede a quarentena global.
    // Do `rename` em diante, e SÓ dali, o efeito é de fato desconhecido.
    try {
      await mkdir(folder, { recursive: true })
      await rm(pending, { recursive: true, force: true })
      await cp(source.directory, pending, { recursive: true, errorOnExist: true, dereference: false })
    } catch (error) {
      await rm(pending, { recursive: true, force: true }).catch(() => undefined)
      return { kind: 'definitive-no-effect', failureCode: definitiveCode(error instanceof Error ? error.message : 'COPY_FAILED') }
    }
    // A CONFERÊNCIA QUE VALE é esta, sobre a CÓPIA — e não a de cima, sobre a
    // origem.
    //
    // `verifyArtifactFiles` lia a árvore e `cp` a lia DE NOVO: duas leituras
    // diferentes do mesmo diretório, com uma janela entre elas. Nessa janela um
    // arquivo podia ser trocado por outro conteúdo (e a cópia publicaria bytes
    // que nunca foram conferidos contra o manifesto atestado) ou por um LINK
    // SIMBÓLICO — e como `cp` usa `dereference: false`, o link ia para dentro
    // da geração publicada. A recusa de link da primeira leitura não alcançava
    // o que fosse plantado depois dela.
    //
    // `pending` é NOSSO: ninguém mais escreve nele, e conferir ali fecha a
    // janela em vez de encurtá-la. A conferência de cima continua por ser
    // barata e recusar cedo o caso comum, mas a decisão de publicar é desta.
    //
    // Ainda é `definitive-no-effect`: a publicação é o `rename` lá embaixo, e
    // até ele nada está servindo. O que foi copiado é apagado.
    let copied: string | undefined
    try { copied = await verifyArtifactFiles(pending, source.files) }
    catch (error) { copied = error instanceof Error ? error.message : 'ARTIFACT_UNREADABLE' }
    if (copied !== undefined) {
      await rm(pending, { recursive: true, force: true })
      return { kind: 'definitive-no-effect', failureCode: definitiveCode(copied) }
    }
    const receipt = stagingProviderReceiptSchema.parse({
      provider_id: this.providerId,
      environment: 'staging',
      target_ref: this.targetRef,
      operation_id: input.operationId,
      kind,
      target_generation: input.targetGeneration,
      artifact_sha256: input.artifact.artifact_sha256,
      receipt_ref: `dz23-receipt:${this.providerId}-${String(input.targetGeneration)}-${input.artifact.artifact_sha256.slice(0, 16)}`,
      observed_at: this.#now().toISOString(),
    })
    await writeFile(join(pending, RECEIPT_FILE), `${JSON.stringify(receipt)}\n`, 'utf8')
    // A renomeação é o momento da publicação. Antes dela nada está servindo;
    // depois dela, tudo está. Copiar direto para o lugar final deixaria meia
    // aplicação publicada se a máquina caísse no meio.
    await rename(pending, destination)
    await writeFile(join(folder, CURRENT_FILE), `${JSON.stringify({ generation: input.targetGeneration, receipt_ref: receipt.receipt_ref })}\n`, 'utf8')
    return { kind: 'accepted', receipt }
  }

  /**
   * O recibo de uma geração, em TRÊS respostas e não em duas.
   *
   * `catch { return undefined }` colapsava "não existe" com "existe e não deu
   * para ler", e as duas mandam o provedor para lados opostos: ausente é uma
   * geração LIVRE, e ilegível é uma geração que pode já estar publicada. Com o
   * colapso, um `receipt.json` truncado, sem permissão de leitura, ou que não
   * valida no esquema fazia `#publish` copiar tudo de novo por cima de um
   * destino ocupado — e o `rename` falhava com `ENOTEMPTY`, exceção que subia
   * ao serviço como efeito desconhecido e punha o destino global em quarentena.
   *
   * Ausência de prova nunca vira prova: aqui ela vira `ILEGIVEL`, que é
   * recusa definitiva e sem efeito, e não uma afirmação de que está livre.
   * @param generation - a geração do destino.
   * @returns `AUSENTE`, `ILEGIVEL`, ou o recibo lido.
   */
  async #readReceipt(generation: number): Promise<StagingProviderReceipt | 'AUSENTE' | 'ILEGIVEL'> {
    const path = join(this.#root, targetFolder(this.targetRef), String(generation), RECEIPT_FILE)
    if (!usableGeneration(generation)) return 'AUSENTE'
    if (relative(this.#root, path).startsWith(`..${sep}`)) return 'AUSENTE'
    let texto: string
    try {
      texto = await readFile(path, 'utf8')
    } catch (error) {
      // SÓ o arquivo que não está lá é ausência. Permissão negada, erro de
      // entrada e saída, ou diretório no lugar do arquivo são falhas de leitura.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'AUSENTE' : 'ILEGIVEL'
    }
    try {
      const parsed = stagingProviderReceiptSchema.safeParse(JSON.parse(texto))
      return parsed.success ? parsed.data : 'ILEGIVEL'
    } catch { return 'ILEGIVEL' }
  }
}

/**
 * O código de falha que atravessa para o journal.
 *
 * O caminho do arquivo é CORTADO: ele é um caminho no computador de quem
 * hospeda, e o código de falha aparece na tela de quem publicou.
 * @param problem - o problema encontrado na verificação.
 * @returns o código, no formato que o journal aceita.
 */
export function definitiveCode(problem: string): string {
  const [code] = problem.split(':')
  return /^[A-Z][A-Z0-9_]{1,95}$/u.test(code ?? '') ? code! : 'ARTIFACT_VERIFICATION_FAILED'
}
