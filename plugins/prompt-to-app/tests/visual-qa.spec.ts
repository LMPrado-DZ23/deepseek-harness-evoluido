import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  COLOR_COUNT_CEILING,
  HOME_SCREENSHOT,
  homeScreenVerdict,
  MIN_INK_COVERAGE,
  type RgbaImage,
  compareImages,
  decodePng,
  imageStats,
  visualProblems,
} from '../src/visual-qa.js'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  // O CRC nao e conferido pelo leitor, entao zero serve: o que este ajudante
  // precisa reproduzir e o ENQUADRAMENTO, que e o que o leitor percorre.
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

/** Monta um PNG de verdade a partir de pixels RGBA, sem filtro de linha. */
function png(width: number, height: number, rgba: readonly (readonly [number, number, number, number])[], options: {
  readonly colorType?: number; readonly bitDepth?: number; readonly interlace?: number
} = {}): Buffer {
  const colorType = options.colorType ?? 6
  const channels = colorType === 6 ? 4 : 3
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = options.bitDepth ?? 8; header[9] = colorType
  header[10] = 0; header[11] = 0; header[12] = options.interlace ?? 0
  const raw = Buffer.alloc(height * (width * channels + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * channels + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = rgba[y * width + x] ?? [0, 0, 0, 255]
      const at = y * (width * channels + 1) + 1 + x * channels
      raw[at] = pixel[0]; raw[at + 1] = pixel[1]; raw[at + 2] = pixel[2]
      if (channels === 4) raw[at + 3] = pixel[3]
    }
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function solid(width: number, height: number, color: readonly [number, number, number, number]) {
  return Array.from({ length: width * height }, () => color)
}

function image(width: number, height: number, rgba: readonly (readonly [number, number, number, number])[]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4)
  rgba.forEach((pixel, index) => { pixels.set(pixel, index * 4) })
  return { width, height, pixels }
}

describe('decodePng — o que ele sabe ler, e o que ele DIZ que nao sabe', () => {
  it('le cor verdadeira com alfa', () => {
    const result = decodePng(png(2, 1, [[10, 20, 30, 255], [40, 50, 60, 128]]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image).toMatchObject({ width: 2, height: 1 })
    expect([...result.image.pixels]).toEqual([10, 20, 30, 255, 40, 50, 60, 128])
  })

  it('sem canal alfa tudo e OPACO, e nunca transparente', () => {
    // Assumir transparente faria toda imagem sem alfa parecer uma tela vazia.
    const result = decodePng(png(1, 1, [[1, 2, 3, 0]], { colorType: 2 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.image.pixels]).toEqual([1, 2, 3, 255])
  })

  it('o filtro de linha e desfeito, e nao ignorado', () => {
    // Um decodificador que ignorasse o filtro leria um degrade como ruido.
    const width = 3
    const raw = Buffer.from([
      1, 10, 20, 30, 255, 5, 5, 5, 0, 5, 5, 5, 0, // filtro `Sub`: cada pixel soma o anterior
    ])
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0); header.writeUInt32BE(1, 4)
    header[8] = 8; header[9] = 6
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
    const result = decodePng(buffer)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.image.pixels]).toEqual([10, 20, 30, 255, 15, 25, 35, 255, 20, 30, 40, 255])
  })

  it('o que nao e PNG e DITO, e nao chutado', () => {
    expect(decodePng(Buffer.from('nao sou uma imagem'))).toEqual({ ok: false, reason: 'NOT_PNG' })
    expect(decodePng(Buffer.alloc(0))).toEqual({ ok: false, reason: 'NOT_PNG' })
  })

  it('entrelacado, profundidade e tipo de cor fora do subconjunto sao RECUSADOS', () => {
    // Chutar a leitura produziria pixels errados, e pixel errado aqui vira
    // "a pagina esta branca" sobre uma pagina cheia.
    expect(decodePng(png(1, 1, [[0, 0, 0, 255]], { interlace: 1 }))).toEqual({ ok: false, reason: 'INTERLACED' })
    expect(decodePng(png(1, 1, [[0, 0, 0, 255]], { bitDepth: 16 }))).toEqual({ ok: false, reason: 'UNSUPPORTED_BIT_DEPTH' })
    expect(decodePng(png(1, 1, [[0, 0, 0, 255]], { colorType: 3 }))).toEqual({ ok: false, reason: 'UNSUPPORTED_COLOR_TYPE' })
  })

  it('arquivo cortado DENTRO dos dados e TRUNCADO, e nao lido pela metade', () => {
    const whole = png(64, 64, solid(64, 64, [1, 2, 3, 255]))
    // 30 bytes cobrem assinatura e cabecalho; o corte cai dentro do IDAT.
    expect(decodePng(whole.subarray(0, 30 + 8))).toMatchObject({ ok: false, reason: 'TRUNCATED' })
  })

  it('bloco que DECLARA mais bytes do que o arquivo tem e recusado', () => {
    // Sem conferir o fim do bloco contra o tamanho do arquivo, o leitor
    // avancaria para fora do buffer e leria lixo como pixel.
    const whole = png(64, 64, solid(64, 64, [1, 2, 3, 255]))
    // Assinatura (8) + IHDR (25) + cabecalho do IDAT (8) + um pedaco dos dados.
    expect(decodePng(whole.subarray(0, 8 + 25 + 8 + 4))).toEqual({ ok: false, reason: 'TRUNCATED' })
  })

  it('sem o bloco final, mas com os dados inteiros, a imagem AINDA e lida', () => {
    // O bloco final nao carrega pixel nenhum. Recusar por falta dele descartaria
    // uma imagem completa por causa de doze bytes de pontuacao.
    const whole = png(4, 4, solid(4, 4, [1, 2, 3, 255]))
    expect(decodePng(whole.subarray(0, whole.length - 12)).ok).toBe(true)
  })

  it('PNG sem nenhum bloco de imagem nao vira imagem vazia', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IEND', Buffer.alloc(0))])
    expect(decodePng(buffer)).toEqual({ ok: false, reason: 'NO_IMAGE_DATA' })
  })

  it('dados de imagem corrompidos nao lancam: eles sao RECUSADOS', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    const buffer = Buffer.concat([
      SIGNATURE, chunk('IHDR', header), chunk('IDAT', Buffer.from('isto nao e zlib')), chunk('IEND', Buffer.alloc(0)),
    ])
    expect(decodePng(buffer)).toEqual({ ok: false, reason: 'CORRUPT' })
  })

  it('largura ou altura zero e corrupcao, e nao uma imagem legitima', () => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(0, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0))])
    expect(decodePng(buffer)).toEqual({ ok: false, reason: 'CORRUPT' })
  })

  it('um bloco desconhecido no meio nao atrapalha', () => {
    const whole = png(1, 1, [[9, 9, 9, 255]])
    const withExtra = Buffer.concat([
      whole.subarray(0, 8 + 25), chunk('tEXt', Buffer.from('nota')), whole.subarray(8 + 25),
    ])
    expect(decodePng(withExtra).ok).toBe(true)
  })
})

describe('imageStats', () => {
  it('a cor mais comum e o FUNDO, mesmo em modo escuro', () => {
    // Medir tinta contra branco fixo diria que a tela escura inteira e conteudo.
    const dark = [...solid(10, 10, [16, 16, 16, 255])]
    dark[0] = [255, 255, 255, 255]
    const stats = imageStats(image(10, 10, dark))
    expect(stats.background).toEqual([16, 16, 16])
    expect(stats.inkCoverage).toBeCloseTo(0.01)
  })

  it('pixel TRANSPARENTE conta como fundo, e nao como cor propria', () => {
    const stats = imageStats(image(2, 1, [[255, 0, 0, 0], [255, 0, 0, 0]]))
    expect(stats.distinctColors).toBe(1)
    expect(stats.inkCoverage).toBe(0)
  })

  it('transparentes de cores DIFERENTES sao o mesmo nada', () => {
    // Uma regiao transparente e uma regiao onde nao ha nada desenhado; a cor
    // que esta por baixo do alfa zero nunca chegou aos olhos de ninguem.
    const pixels = [...solid(10, 10, [255, 255, 255, 255] as const)]
    pixels[0] = [255, 0, 0, 0]
    pixels[1] = [0, 255, 0, 0]
    const stats = imageStats(image(10, 10, pixels))
    expect(stats.distinctColors).toBe(2)
    expect(stats.inkCoverage).toBeCloseTo(0.02)
  })

  it('a mesma cor com alfa diferente de zero nao vira duas cores', () => {
    const stats = imageStats(image(2, 1, [[7, 7, 7, 255], [7, 7, 7, 128]]))
    expect(stats.distinctColors).toBe(1)
  })
})

describe('visualProblems — o que se afirma sobre UMA imagem', () => {
  it('uma cor so e EM BRANCO, e tem nome proprio', () => {
    expect(visualProblems(imageStats(image(4, 4, solid(4, 4, [255, 255, 255, 255]))))).toEqual(['BLANK', 'SINGLE_COLOR'])
  })

  it('preta inteira tambem e em branco: o defeito e nao ter desenhado', () => {
    expect(visualProblems(imageStats(image(4, 4, solid(4, 4, [0, 0, 0, 255]))))).toContain('BLANK')
  })

  it('quase nada desenhado e QUASE EM BRANCO, que e frase diferente', () => {
    const pixels = [...solid(100, 10, [255, 255, 255, 255])]
    pixels[0] = [0, 0, 0, 255]
    expect(visualProblems(imageStats(image(100, 10, pixels)))).toEqual(['NEARLY_BLANK'])
  })

  it('uma pagina com conteudo nao levanta problema nenhum', () => {
    const pixels = [...solid(10, 10, [255, 255, 255, 255])]
    for (let i = 0; i < 30; i += 1) pixels[i] = [0, 0, 0, 255]
    expect(visualProblems(imageStats(image(10, 10, pixels)))).toEqual([])
  })

  it('na borda do teto de tinta a pagina ainda passa', () => {
    // Um teto alto reprovaria paginas legitimamente minimalistas, e essa
    // reprovacao custa mais do que o defeito que ela tenta pegar.
    const total = 1000
    const ink = Math.ceil(total * MIN_INK_COVERAGE)
    const pixels = [...solid(100, 10, [255, 255, 255, 255] as const)]
    for (let i = 0; i < ink; i += 1) pixels[i] = [0, 0, 0, 255]
    expect(visualProblems(imageStats(image(100, 10, pixels)))).toEqual([])
  })
})

describe('compareImages — o que se afirma sobre DUAS', () => {
  it('iguais sao IDENTICAS', () => {
    const a = image(2, 2, solid(2, 2, [1, 2, 3, 255]))
    expect(compareImages(a, a)).toEqual({ state: 'IDENTICAL' })
  })

  it('mudou diz QUANTO mudou', () => {
    const before = image(2, 2, solid(2, 2, [1, 2, 3, 255]))
    const pixels = [...solid(2, 2, [1, 2, 3, 255] as const)]
    pixels[0] = [9, 9, 9, 255]
    expect(compareImages(before, image(2, 2, pixels))).toEqual({ state: 'CHANGED', differentFraction: 0.25 })
  })

  it('so o alfa diferente ja e mudanca', () => {
    const before = image(1, 1, [[1, 2, 3, 255]])
    expect(compareImages(before, image(1, 1, [[1, 2, 3, 254]])).state).toBe('CHANGED')
  })

  it('tamanhos diferentes NAO sao esticados para caber', () => {
    // Redimensionar inventaria pixels, e a fracao calculada sobre pixels
    // inventados seria um numero com aparencia de medida.
    const result = compareImages(image(2, 2, solid(2, 2, [0, 0, 0, 255])), image(3, 2, solid(3, 2, [0, 0, 0, 255])))
    expect(result).toEqual({ state: 'INCOMPARABLE', reason: 'SIZE_MISMATCH' })
  })

  it('a comparacao e simetrica', () => {
    const a = image(2, 1, [[1, 1, 1, 255], [2, 2, 2, 255]])
    const b = image(2, 1, [[1, 1, 1, 255], [3, 3, 3, 255]])
    expect(compareImages(a, b)).toEqual(compareImages(b, a))
  })
})

describe('a ponta a ponta: PNG de verdade ate o veredito', () => {
  it('um PNG todo branco e lido e acusado de estar em branco', () => {
    const decoded = decodePng(png(20, 20, solid(20, 20, [255, 255, 255, 255])))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(visualProblems(imageStats(decoded.image))).toContain('BLANK')
  })

  it('um PNG com conteudo passa', () => {
    const pixels = [...solid(20, 20, [255, 255, 255, 255] as const)]
    for (let i = 0; i < 80; i += 1) pixels[i] = [20, 20, 20, 255]
    const decoded = decodePng(png(20, 20, pixels))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(visualProblems(imageStats(decoded.image))).toEqual([])
  })
})

describe('entrada nao confiavel nao derruba o leitor', () => {
  it('dimensoes gigantes sao RECUSADAS antes de qualquer alocacao', () => {
    // `width` e `height` vem DO ARQUIVO. Sem teto, um PNG de poucos bytes
    // declara bilhoes de pixels e a alocacao lanca `RangeError` — que ESCAPA da
    // funcao como excecao, em vez de sair como recusa.
    const header = Buffer.alloc(13)
    header.writeUInt32BE(60_000, 0); header.writeUInt32BE(60_000, 4)
    header[8] = 8; header[9] = 6
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))])
    expect(decodePng(buffer)).toEqual({ ok: false, reason: 'TOO_LARGE' })
  })

  it('bomba de descompressao e recusada, e NAO chamada de corrupcao', () => {
    // Poucos bytes comprimidos, gigabytes na saida. O arquivo pode estar
    // perfeito e ser grande demais — dizer CORRUPT mandaria alguem procurar
    // defeito onde houve recusa por tamanho.
    const lado = 4_000
    const header = Buffer.alloc(13)
    header.writeUInt32BE(lado, 0); header.writeUInt32BE(lado, 4)
    header[8] = 8; header[9] = 6
    const cru = Buffer.alloc(lado * (lado * 4 + 1))
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(cru)), chunk('IEND', Buffer.alloc(0))])
    // Dentro do teto de pixels, entao ele passa — o teto de bytes existe para o
    // caso em que o cabecalho mente sobre o tamanho dos dados.
    expect(decodePng(buffer).ok).toBe(true)
  })

  it('filtro de linha INVALIDO e recusado, e nao decodificado como lixo', () => {
    // A guarda antiga era codigo morto: `line` e `Uint8Array`, entao atribuir
    // `-1` guarda `255`. Um filtro 99 decodificava `ok: true` com tudo em 255 —
    // e `visualProblems` diria EM BRANCO sobre uma imagem qualquer.
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    const cru = Buffer.from([99, 1, 2, 3, 255])
    const buffer = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(cru)), chunk('IEND', Buffer.alloc(0))])
    expect(decodePng(buffer)).toEqual({ ok: false, reason: 'CORRUPT' })
  })

  it('a contagem de cores tem TETO, e o teto nao muda o veredito de tela em branco', () => {
    const pixels = Array.from({ length: COLOR_COUNT_CEILING * 2 }, (_value, index) =>
      [index % 256, (index >> 8) % 256, (index >> 16) % 256, 255] as const)
    const stats = imageStats(image(COLOR_COUNT_CEILING * 2, 1, pixels))
    expect(stats.distinctColors).toBeLessThanOrEqual(COLOR_COUNT_CEILING)
    // E uma imagem de uma cor so continua sendo uma cor so.
    expect(imageStats(image(4, 4, solid(4, 4, [1, 2, 3, 255]))).distinctColors).toBe(1)
  })
})

describe('homeScreenVerdict — o elo com a execucao', () => {
  const semLer = async () => undefined

  it('captura AUSENTE nao e tela em branco', () => {
    // Reprovar aqui seria reprovar a criacao por um defeito do observador.
    return expect(homeScreenVerdict('/run', semLer)).resolves.toEqual({ state: 'NOT_OBSERVED', reason: 'ABSENT' })
  })

  it('captura ILEGIVEL diz POR QUE, e continua nao sendo tela em branco', async () => {
    const verdict = await homeScreenVerdict('/run', async () => Buffer.from('nao sou uma imagem'))
    expect(verdict).toEqual({ state: 'NOT_OBSERVED', reason: 'NOT_PNG' })
  })

  it('tela de uma cor so e EM BRANCO, com os problemas nomeados', async () => {
    const branca = png(20, 20, solid(20, 20, [255, 255, 255, 255]))
    const verdict = await homeScreenVerdict('/run', async () => branca)
    expect(verdict).toMatchObject({ state: 'BLANK' })
    if (verdict.state !== 'BLANK') return
    expect(verdict.problems).toContain('BLANK')
  })

  it('tela com conteudo DESENHOU', async () => {
    const pixels = [...solid(20, 20, [255, 255, 255, 255] as const)]
    for (let i = 0; i < 80; i += 1) pixels[i] = [20, 20, 20, 255]
    await expect(homeScreenVerdict('/run', async () => png(20, 20, pixels))).resolves.toEqual({ state: 'DREW' })
  })

  it('o caminho lido e o que a suite gerada escreve', async () => {
    let pedido = ''
    await homeScreenVerdict('/run', async path => { pedido = path; return undefined })
    expect(pedido).toBe(`/run/${HOME_SCREENSHOT}`)
  })
})
