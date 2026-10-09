#!/usr/bin/env node
/**
 * Os derivados da marca DZ23, a partir do ORIGINAL do proprietário.
 *
 * Existe porque a decisão de marca do Prado (16/09/2026) é explícita: a fonte
 * oficial é `logo-dz23-original.png`, as logos reinterpretadas nos mockups não
 * a substituem, e "não invente outro símbolo nem recrie a marca apenas digitando
 * DZ23 com uma fonte semelhante".
 *
 * O que este script faz, e SÓ isto:
 *
 * 1. **Corta a margem externa branca.** Ela é respiro do arquivo, não desenho:
 *    o quadrado azul arredondado, o D, o Z e o 23 ficam intactos, na mesma
 *    proporção e com os mesmos recortes. Cortar margem não é "remover o fundo".
 * 2. **Reduz para os tamanhos que a interface usa**, com reamostragem LANCZOS.
 *
 * O que ele NÃO faz, também de propósito:
 *
 * - **Não remove o fundo azul.** A especificação avisa que retirar o fundo e o
 *   relevo exige tratamento cuidadoso, e que uma extração ruim deve ser
 *   substituída pelo ícone original bem dimensionado. Um recorte automático por
 *   limiar deixaria halo nas bordas claras do D — que são MARCA, não fundo.
 * - **Não vetoriza.** "Não apresente PNG embutido em SVG como logo vetorizada."
 * - **Não inverte nem filtra para o tema escuro.** O quadrado azul já tem
 *   contraste contra o grafite; um filtro global mudaria a identidade.
 *
 * Uso: node scripts/build-brand-assets.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const origem = resolve(raiz, 'apps/studio-web/public/brand/dz23-original.png')
const destino = resolve(raiz, 'apps/studio-web/public/brand')
const icones = resolve(raiz, 'apps/studio-web/public/icons')

/** Os tamanhos que a interface pede, e onde cada um aparece. */
const DERIVADOS = [
  { arquivo: 'dz23-mark-48.png', tamanho: 48, onde: 'barra lateral recolhida e cabeçalho compacto' },
  { arquivo: 'dz23-mark-96.png', tamanho: 96, onde: 'o mesmo em telas de 2x' },
  { arquivo: 'dz23-mark-256.png', tamanho: 256, onde: 'autenticação e telas amplas' },
]

const ICONES = [
  { arquivo: 'icon-192.png', tamanho: 192 },
  { arquivo: 'icon-512.png', tamanho: 512 },
  { arquivo: 'maskable-512.png', tamanho: 512 },
]

mkdirSync(destino, { recursive: true })
mkdirSync(icones, { recursive: true })

const roteiro = `
import sys
from PIL import Image

origem, destino, icones = sys.argv[1], sys.argv[2], sys.argv[3]
derivados = ${JSON.stringify(DERIVADOS)}
icones_lista = ${JSON.stringify(ICONES)}

base = Image.open(origem).convert('RGBA')

# A MARGEM EXTERNA e o que sai. Ela e quase branca e envolve o quadrado azul;
# o recorte e pela caixa do que NAO e quase branco, com uma folga de um pixel
# para nao comer a antiserrilha da borda arredondada.
fundo = Image.new('RGBA', base.size, (255, 255, 255, 255))
diferenca = Image.alpha_composite(fundo, base).convert('RGB')
mascara = diferenca.point(lambda valor: 255 if valor < 246 else 0).convert('L')
caixa = mascara.getbbox()
if caixa is None:
    print('MARCA=FALHA motivo=imagem-toda-branca')
    sys.exit(1)
esquerda, topo, direita, baixo = caixa
folga = 1
cortada = base.crop((max(esquerda - folga, 0), max(topo - folga, 0),
                     min(direita + folga, base.width), min(baixo + folga, base.height)))

# O corte tem de continuar QUADRADO: o quadrado arredondado e a forma da marca,
# e esticar um lado mudaria o desenho.
lado = max(cortada.width, cortada.height)
quadrada = Image.new('RGBA', (lado, lado), (0, 0, 0, 0))
quadrada.paste(cortada, ((lado - cortada.width) // 2, (lado - cortada.height) // 2))

for item in derivados:
    quadrada.resize((item['tamanho'], item['tamanho']), Image.LANCZOS).save(destino + '/' + item['arquivo'])
for item in icones_lista:
    quadrada.resize((item['tamanho'], item['tamanho']), Image.LANCZOS).save(icones + '/' + item['arquivo'])

print('MARCA=PASS original=%dx%d cortada=%dx%d derivados=%d icones=%d'
      % (base.width, base.height, quadrada.width, quadrada.height, len(derivados), len(icones_lista)))
`

try {
  const saida = execFileSync('python3', ['-c', roteiro, origem, destino, icones], { encoding: 'utf8' })
  process.stdout.write(saida)
} catch (erro) {
  process.stderr.write(`${String(erro.stdout ?? '')}${String(erro.stderr ?? erro.message)}\n`)
  process.exitCode = 1
}
