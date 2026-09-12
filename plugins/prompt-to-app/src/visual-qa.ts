import { inflateSync } from 'node:zlib'

/**
 * VISUAL QA COM COMPARACAO DE IMAGEM (T-18).
 *
 * O defeito que isto existe para pegar e o mais constrangedor que este produto
 * tem: a compilacao passa, os testes passam, o artefato e assinado — e a pagina
 * abre BRANCA. Nada em todo o resto do pipeline olha para o que a pessoa vai
 * ver; ele olha para o que o computador conseguiu executar, e essas duas coisas
 * se separam exatamente no caso que mais humilha.
 *
 * NAO HA LINHA DE BASE, e isso muda o que a comparacao pode ser. Um aplicativo
 * recem-criado nunca foi visto antes: nao existe "como ele era ontem" para
 * comparar. Entao o que se pode afirmar sobre UMA imagem sozinha e o que a
 * ausencia de conteudo tem de inconfundivel — uma tela de uma cor so, uma tela
 * quase vazia —, e o que se pode afirmar sobre DUAS imagens e se elas mudaram.
 *
 * O QUE ISTO NAO E: um juiz de estetica. Ele nao diz se ficou bonito, nao diz
 * se o espacamento esta bom, nao classifica layout. Uma maquina que opinasse
 * sobre isso estaria inventando, e a opiniao inventada seria seguida.
 */

export interface RgbaImage {
  readonly width: number
  readonly height: number
  /** Quatro bytes por pixel, linha a linha, de cima para baixo. */
  readonly pixels: Uint8Array
}

export type PngDecodeResult =
  | { readonly ok: true; readonly image: RgbaImage }
  /**
   * O formato nao e o subconjunto que sabemos ler.
   *
   * DITO, e nunca adivinhado. Um decodificador que chutasse a leitura de um PNG
   * entrelacado ou paletizado produziria pixels errados, e pixels errados aqui
   * viram "a pagina esta branca" sobre uma pagina cheia.
   */
  | { readonly ok: false; readonly reason: PngUnsupported }

export type PngUnsupported =
  | 'NOT_PNG'
  | 'TRUNCATED'
  | 'INTERLACED'
  | 'UNSUPPORTED_COLOR_TYPE'
  | 'UNSUPPORTED_BIT_DEPTH'
  | 'NO_IMAGE_DATA'
  | 'CORRUPT'
  /** Grande demais para ser lido com seguranca. NAO e corrupcao. */
  | 'TOO_LARGE'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * O maior numero de pixels que este leitor aceita decodificar.
 *
 * Quarenta megapixels cobre com folga qualquer captura de tela, inclusive de
 * pagina inteira em telona. Ele NAO e sobre desempenho: `width` e `height` sao
 * dois inteiros de 32 bits que vem DO ARQUIVO, e um PNG de sessenta mil bytes
 * pode declarar quatro bilhoes de pixels. Sem teto, a linha que aloca os pixels
 * ou consome a memoria toda ou lanca `RangeError` — e um `RangeError` ESCAPA da
 * funcao como excecao em vez de sair como recusa, que e o contrato dela.
 *
 * A revisao adversarial mediu 62 KB virando 128 MB, com fator de 1028 vezes.
 */
export const MAX_PIXELS = 40_000_000

/**
 * O maior tamanho DESCOMPRIMIDO que o leitor aceita.
 *
 * `inflateSync` sem teto aceita ate ~2 GB por padrao, e e assim que uma bomba
 * de descompressao funciona: poucos bytes comprimidos, gigabytes na saida. O
 * teto e derivado do teto de pixels — nao ha razao para aceitar mais dados do
 * que o cabecalho declarou precisar.
 */
const MAX_INFLATED_BYTES = MAX_PIXELS * 4 + MAX_PIXELS

/**
 * Le o subconjunto de PNG que um navegador headless produz: 8 bits por canal,
 * sem entrelacamento, em cor verdadeira com ou sem transparencia.
 *
 * Escrito a mao sobre o `zlib` que o Node ja tem, e nao sobre uma biblioteca de
 * imagem: acrescentar dependencia de imagem ao produto e decisao com peso de
 * licenca e de portabilidade, e ela nao precisa ser tomada para responder "a
 * tela esta em branco?".
 */
export function decodePng(buffer: Buffer): PngDecodeResult {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: 'NOT_PNG' }
  let offset = 8
  let width = 0; let height = 0; let bitDepth = 0; let colorType = -1
  const idat: Buffer[] = []
  let ended = false
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    // O `+ 4` e o CRC. Sem conferir o fim do bloco, um arquivo cortado ao meio
    // seria lido como se o ultimo bloco estivesse inteiro.
    if (dataStart + length + 4 > buffer.length) return { ok: false, reason: 'TRUNCATED' }
    if (type === 'IHDR') {
      if (length < 13) return { ok: false, reason: 'CORRUPT' }
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      bitDepth = buffer[dataStart + 8]!
      colorType = buffer[dataStart + 9]!
      if (buffer[dataStart + 12] !== 0) return { ok: false, reason: 'INTERLACED' }
      if (bitDepth !== 8) return { ok: false, reason: 'UNSUPPORTED_BIT_DEPTH' }
      if (colorType !== 2 && colorType !== 6) return { ok: false, reason: 'UNSUPPORTED_COLOR_TYPE' }
      if (width === 0 || height === 0) return { ok: false, reason: 'CORRUPT' }
      // O teto vem ANTES de qualquer alocacao, e antes ate de descomprimir:
      // depois ja seria tarde.
      if (width * height > MAX_PIXELS) return { ok: false, reason: 'TOO_LARGE' }
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') { ended = true; break }
    offset = dataStart + length + 4
  }
  if (colorType === -1) return { ok: false, reason: 'CORRUPT' }
  // O laco tambem termina quando sobra menos de um cabecalho de bloco. Sem o
  // bloco final E sem dados, o arquivo acabou no meio — e chamar isso de "sem
  // imagem" mandaria alguem procurar um defeito de geracao onde houve um
  // defeito de transferencia.
  if (idat.length === 0) return { ok: false, reason: ended ? 'NO_IMAGE_DATA' : 'TRUNCATED' }

  const channels = colorType === 6 ? 4 : 3
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_INFLATED_BYTES }) } catch (error) {
    // O `zlib` lanca quando estoura o teto, e esse caso NAO e corrupcao: o
    // arquivo pode estar perfeito e ser grande demais. Dizer `CORRUPT` mandaria
    // alguem procurar defeito onde houve recusa por tamanho.
    return { ok: false, reason: (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'TOO_LARGE' : 'CORRUPT' }
  }
  const stride = width * channels
  if (raw.length < height * (stride + 1)) return { ok: false, reason: 'TRUNCATED' }

  const pixels = new Uint8Array(width * height * 4)
  const line = new Uint8Array(stride)
  const previous = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    // A conferencia do filtro acontece AQUI, e nao dentro do laco dos bytes.
    // La ela era codigo morto: `line` e `Uint8Array`, entao atribuir `-1` guarda
    // `255`, e `line[i] === -1` nunca era verdadeiro — um filtro invalido
    // decodificava como `ok: true` com pixels de lixo, que e exatamente o
    // "pixels errados viram 'a pagina esta branca'" que este arquivo diz
    // impedir. A revisao adversarial reproduziu com filtro 99.
    if (filter > 4) return { ok: false, reason: 'CORRUPT' }
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0
      const up = previous[i]!
      const upLeft = i >= channels ? previous[i - channels]! : 0
      const value = source[i]!
      line[i] = filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
        : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
        : (value + paeth(left, up, upLeft)) & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4
      const from = x * channels
      pixels[to] = line[from]!
      pixels[to + 1] = line[from + 1]!
      pixels[to + 2] = line[from + 2]!
      // Sem canal alfa, tudo e opaco. Assumir transparente faria toda imagem
      // sem alfa parecer uma tela vazia.
      pixels[to + 3] = channels === 4 ? line[from + 3]! : 255
    }
    previous.set(line)
  }
  return { ok: true, image: { width, height, pixels } }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const dLeft = Math.abs(estimate - left)
  const dUp = Math.abs(estimate - up)
  const dUpLeft = Math.abs(estimate - upLeft)
  return dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft
}

/**
 * O maior numero de cores distintas que a contagem acompanha.
 *
 * O documento dizia "ate o teto de contagem" e teto nenhum existia: o mapa
 * crescia ate 16 milhoes de entradas, e uma imagem grande com muitas cores
 * travava o laco de eventos por segundos, sincrono. Passado o teto a contagem
 * PARA de acrescentar cores novas — o que ela ainda responde com verdade e
 * `distinctColors >= COLOR_COUNT_CEILING`, e isso ja basta para a unica
 * pergunta que ela serve: a tela tem UMA cor so?
 */
export const COLOR_COUNT_CEILING = 4_096

export interface ImageStats {
  /** Quantas cores distintas a imagem tem, ate `COLOR_COUNT_CEILING`. */
  readonly distinctColors: number
  /** A fracao de pixels que NAO sao a cor mais comum. */
  readonly inkCoverage: number
  /** A cor mais comum, que quase sempre e o fundo. */
  readonly background: readonly [number, number, number]
}

/**
 * Quanto a imagem tem de conteudo.
 *
 * A cor mais comum e tratada como FUNDO em vez de uma cor de fundo fixa: um
 * aplicativo em modo escuro tem fundo quase preto, e medir tinta contra branco
 * diria que a tela inteira e conteudo.
 *
 * Pixels TRANSPARENTES contam como fundo, e nao como cor propria: uma regiao
 * transparente e uma regiao onde nao ha nada desenhado.
 */
export function imageStats(image: RgbaImage): ImageStats {
  const counts = new Map<number, number>()
  const total = image.width * image.height
  // Os pixels alem do teto ainda sao CONTADOS na cor que ja conhecemos; o que
  // para de crescer e o numero de cores DISTINTAS acompanhadas. A cor de fundo
  // e a mais comum, e uma cor de fundo tem milhoes de pixels — ela entra muito
  // antes de qualquer teto.
  for (let i = 0; i < total; i += 1) {
    const alpha = image.pixels[i * 4 + 3]!
    const key = alpha === 0 ? -1 : (image.pixels[i * 4]! << 16) | (image.pixels[i * 4 + 1]! << 8) | image.pixels[i * 4 + 2]!
    const known = counts.get(key)
    if (known === undefined && counts.size >= COLOR_COUNT_CEILING) continue
    counts.set(key, (known ?? 0) + 1)
  }
  let background = -1; let most = 0
  for (const [key, count] of counts) if (count > most) { most = count; background = key }
  return {
    distinctColors: counts.size,
    inkCoverage: total === 0 ? 0 : (total - most) / total,
    background: background === -1 ? [255, 255, 255] : [(background >> 16) & 0xff, (background >> 8) & 0xff, background & 0xff],
  }
}

/**
 * A fracao minima de pixels diferentes do fundo para uma tela ter conteudo.
 *
 * Meio por cento e baixo de proposito. O objetivo NAO e julgar se a pagina esta
 * cheia: e separar "nao renderizou nada" de "renderizou". Um teto alto
 * reprovaria paginas legitimamente minimalistas, e uma reprovacao dessas custa
 * mais do que o defeito que ela tenta pegar.
 */
export const MIN_INK_COVERAGE = 0.005

export type VisualProblem = 'BLANK' | 'NEARLY_BLANK' | 'SINGLE_COLOR'

/**
 * O que se pode afirmar sobre UMA imagem sozinha, sem linha de base.
 *
 * A lista e curta de proposito, e cada item e inconfundivel. Tudo que exigiria
 * julgamento — hierarquia, espacamento, alinhamento — ficou de fora, porque uma
 * maquina opinando sobre isso inventaria, e a opiniao inventada seria seguida.
 */
export function visualProblems(stats: ImageStats): readonly VisualProblem[] {
  // Uma cor so e o caso limite e merece nome proprio: `BLANK` diz "nao
  // desenhou", e e uma frase diferente de "desenhou quase nada".
  if (stats.distinctColors <= 1) return ['BLANK', 'SINGLE_COLOR']
  if (stats.inkCoverage < MIN_INK_COVERAGE) return ['NEARLY_BLANK']
  return []
}

export type VisualComparison =
  | { readonly state: 'IDENTICAL' }
  | { readonly state: 'CHANGED'; readonly differentFraction: number }
  /** Tamanhos diferentes nao se comparam pixel a pixel. */
  | { readonly state: 'INCOMPARABLE'; readonly reason: 'SIZE_MISMATCH' }

/**
 * Duas imagens da mesma tela, para saber se a tentativa seguinte MUDOU alguma
 * coisa do que a pessoa ve.
 *
 * Imagens de tamanhos diferentes NAO sao esticadas para caber: redimensionar
 * inventaria pixels, e a fracao de diferenca calculada sobre pixels inventados
 * seria um numero com aparencia de medida. `INCOMPARABLE` e a resposta honesta,
 * e ela ainda diz a coisa util — o tamanho mudou.
 */
export function compareImages(before: RgbaImage, after: RgbaImage): VisualComparison {
  if (before.width !== after.width || before.height !== after.height) {
    return { state: 'INCOMPARABLE', reason: 'SIZE_MISMATCH' }
  }
  const total = before.width * before.height
  if (total === 0) return { state: 'IDENTICAL' }
  let different = 0
  for (let i = 0; i < total; i += 1) {
    const at = i * 4
    if (
      before.pixels[at] !== after.pixels[at] ||
      before.pixels[at + 1] !== after.pixels[at + 1] ||
      before.pixels[at + 2] !== after.pixels[at + 2] ||
      before.pixels[at + 3] !== after.pixels[at + 3]
    ) different += 1
  }
  return different === 0 ? { state: 'IDENTICAL' } : { state: 'CHANGED', differentFraction: different / total }
}
