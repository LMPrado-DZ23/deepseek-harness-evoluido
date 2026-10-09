#!/usr/bin/env node
/**
 * Os derivados da marca FRIGG, a partir das FONTES do proprietário.
 *
 * O kit `FRIGG-MARCA-20260917-R1` entregou o emblema, o lettering e ícones já
 * exportados. Este roteiro NÃO desenha marca nenhuma: ele só produz os tamanhos
 * que a interface pede, a partir de dois arquivos que ficam versionados aqui
 * como fonte.
 *
 * ## Por que o emblema é quadrado com margem transparente, e não esticado
 *
 * O emblema tem 621×582 — ele não é quadrado. Esticá-lo para caber numa caixa
 * quadrada mudaria o desenho, e o guia de aplicação proíbe exatamente isso.
 * Então o emblema é COLADO no centro de uma tela quadrada transparente do
 * tamanho do maior lado. Margem transparente não é deformação.
 *
 * ## Por que existe um micro-F, além do emblema
 *
 * Medição própria, em `audit/FRIGG_MARCA_R1/comparacao-marca.png`: o emblema
 * desenhado a 16, 24 e 32 px vira uma mancha verde — os recortes, as flechas e
 * o cristal central não sobrevivem à redução. O micro-F derivado do próprio
 * lettering continua legível a 16 px.
 *
 * Daí a divisão de uso, e ela é declarada porque o kit pede que seja:
 *
 * - **emblema** de 36 px para cima — trilho, ícone de aplicativo, maskable;
 * - **micro-F** de 32 px para baixo — favicon e bandeja.
 *
 * O micro-F NÃO substitui o emblema: ele é a redução de uma superfície onde o
 * emblema não cabe. Trocar um pelo outro fora dessa faixa seria inventar um
 * segundo símbolo.
 *
 * Uso: node scripts/build-marca-assets.mjs
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marca = resolve(raiz, 'apps/studio-web/public/brand')
const icones = resolve(raiz, 'apps/studio-web/public/icons')

/** Do EMBLEMA saem os tamanhos do trilho e das telas amplas. */
const DO_EMBLEMA = [
  { arquivo: 'frigg-mark-48.png', tamanho: 48, onde: 'trilho de navegação, 1x' },
  { arquivo: 'frigg-mark-96.png', tamanho: 96, onde: 'o mesmo em telas de 2x' },
  { arquivo: 'frigg-mark-256.png', tamanho: 256, onde: 'telas amplas e autenticação' },
]

/** Do MICRO-F sai só o que é pequeno demais para o emblema. */
const DO_MICRO_F = [
  { arquivo: 'favicon-32.png', tamanho: 32, onde: 'aba do navegador' },
]

const roteiro = `
import sys
from PIL import Image

marca, icones = sys.argv[1], sys.argv[2]
do_emblema = ${JSON.stringify(DO_EMBLEMA)}
do_micro_f = ${JSON.stringify(DO_MICRO_F)}

emblema = Image.open(marca + '/frigg-simbolo-original.png').convert('RGBA')
lado = max(emblema.size)
quadrado = Image.new('RGBA', (lado, lado), (0, 0, 0, 0))
quadrado.paste(emblema, ((lado - emblema.width) // 2, (lado - emblema.height) // 2))

micro = Image.open(marca + '/frigg-micro-f-original.png').convert('RGBA')

for item in do_emblema:
    quadrado.resize((item['tamanho'], item['tamanho']), Image.LANCZOS).save(marca + '/' + item['arquivo'])
for item in do_micro_f:
    micro.resize((item['tamanho'], item['tamanho']), Image.LANCZOS).save(icones + '/' + item['arquivo'])

print('MARCA=PASS emblema=%dx%d quadrado=%dx%d derivados=%d favicons=%d'
      % (emblema.width, emblema.height, quadrado.width, quadrado.height, len(do_emblema), len(do_micro_f)))
`

try {
  process.stdout.write(execFileSync('python3', ['-c', roteiro, marca, icones], { encoding: 'utf8' }))
} catch (erro) {
  process.stderr.write(`${String(erro.stdout ?? '')}${String(erro.stderr ?? erro.message)}\n`)
  process.exitCode = 1
}
