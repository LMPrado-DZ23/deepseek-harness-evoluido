#!/usr/bin/env node
/**
 * A IMAGEM SOCIAL do repositório — o cartão que aparece quando alguém cola o
 * link do projeto em qualquer lugar que gere prévia.
 *
 * ## Por que ela é GERADA, e não desenhada à mão
 *
 * Porque ela repete três coisas que já existem escritas em outro lugar: o nome
 * da marca (`apps/studio-web/src/marca/marca.ts`), o emblema
 * (`apps/studio-web/public/brand/frigg-mark-256.png`) e a cor do produto
 * (`apps/studio-web/src/theme.css`). Desenhá-la à mão criaria a quarta cópia
 * dessas três verdades, e a cópia que ninguém regenera é a que envelhece
 * errado — foi exatamente o que aconteceu com as capturas do README.
 *
 * Aqui o roteiro LÊ as três fontes. Trocar o nome em `marca.ts` e rodar isto de
 * novo produz o cartão certo; não rodar produz um cartão velho, e não um cartão
 * que mente em silêncio sobre ter sido revisado.
 *
 * ## O que este roteiro NÃO faz
 *
 * Não publica nada. O GitHub não expõe a imagem social na API REST nem no `gh`
 * — ela é carregada pela página de configurações do repositório, à mão. Este
 * roteiro produz o arquivo; quem o carrega é o titular. Dizer que a imagem
 * social "foi atualizada" porque o PNG existe seria trocar artefato por efeito.
 *
 * Uso: node scripts/build-social-card.mjs
 * Precisa de `Pillow` no Python: `pip install pillow --break-system-packages`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destino = resolve(raiz, 'docs/images/social-card.png')
const emblema = resolve(raiz, 'apps/studio-web/public/brand/frigg-mark-256.png')

/**
 * Um valor de `marca.ts`, lido da fonte.
 *
 * Node não compila TypeScript, e compilar o módulo inteiro para ler duas
 * cadeias de caracteres custaria mais que o benefício. `gate:marca` já garante
 * que este arquivo é a fonte única do nome.
 * @param chave - o nome do campo.
 * @returns o valor.
 */
function daMarca(chave) {
  const fonte = readFileSync(resolve(raiz, 'apps/studio-web/src/marca/marca.ts'), 'utf8')
  const achado = new RegExp(`${chave}:\\s*'([^']+)'`).exec(fonte)
  if (achado === null) throw new Error(`marca.ts nao declara ${chave}`)
  return achado[1]
}

/**
 * Uma cor de `theme.css`, lida da fonte.
 * @param token - o nome do token, sem os dois hífens.
 * @returns a cor em hexadecimal.
 */
function doTema(token) {
  const fonte = readFileSync(resolve(raiz, 'apps/studio-web/src/theme.css'), 'utf8')
  const achado = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,8});`).exec(fonte)
  if (achado === null) throw new Error(`theme.css nao declara --${token}`)
  return achado[1]
}

const nome = daMarca('nomeCaixaAlta')
const nucleo = daMarca('nucleo')

const roteiro = `
import sys
from PIL import Image, ImageDraw, ImageFont

destino, emblema, nome, nucleo, canvas, texto, secundario, acento, borda = sys.argv[1:10]

# 1280x640 e a proporcao que o GitHub recorta sem cortar nada (2:1).
L, A = 1280, 640
cartao = Image.new('RGB', (L, A), canvas)
desenho = ImageDraw.Draw(cartao)

FONTE = '/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf'
titulo = ImageFont.truetype(FONTE % '-Bold', 116)
linha = ImageFont.truetype(FONTE % '', 34)
miudo = ImageFont.truetype(FONTE % '', 26)
etiqueta = ImageFont.truetype(FONTE % '-Bold', 24)

marca = Image.open(emblema).convert('RGBA').resize((168, 168), Image.LANCZOS)
cartao.paste(marca, (96, 96), marca)

desenho.text((300, 118), nome, font=titulo, fill=texto)

desenho.text((300, 268), 'Descreva o aplicativo de que voc\u00ea precisa.', font=linha, fill=texto)
desenho.text((300, 316), 'Ele planeja, constr\u00f3i e confere no SEU computador.', font=linha, fill=secundario)

# As tres etiquetas de idioma sao a promessa do adendo internacional, e elas so
# aparecem aqui porque as superficies anunciadas realmente tem os tres.
x = 300
for sigla in ('PT-BR', 'EN', 'ES'):
    largura = desenho.textlength(sigla, font=etiqueta) + 36
    desenho.rounded_rectangle([x, 392, x + largura, 440], radius=10, outline=borda, width=2)
    desenho.text((x + 18, 402), sigla, font=etiqueta, fill=acento)
    x += largura + 14

desenho.line([(96, 520), (L - 96, 520)], fill=borda, width=2)
desenho.text((96, 552), 'Constru\u00eddo SOBRE o %s Harness, com zero diff no upstream.' % nucleo, font=miudo, fill=secundario)

# A PROCEDENCIA viaja DENTRO do PNG.
# Nada regenera este arquivo sozinho: trocar o nome em marca.ts e nao rodar o
# roteiro deixaria um cartao mentindo em silencio, e a unica pessoa que notaria
# seria quem colasse o link meses depois. Gravando aqui as entradas que o
# desenharam, o portao da marca compara o cartao com a fonte viva e reprova o
# cartao velho.
from PIL.PngImagePlugin import PngInfo
info = PngInfo()
info.add_text('frigg-marca', nome)
info.add_text('frigg-nucleo', nucleo)
info.add_text('frigg-tema', ','.join((canvas, texto, secundario, acento, borda)))
cartao.save(destino, optimize=True, pnginfo=info)
print('SOCIAL_CARD=PASS destino=%s tamanho=%dx%d marca=%s' % (destino, L, A, nome))
`

try {
  process.stdout.write(execFileSync('python3', [
    '-c', roteiro, destino, emblema, nome, nucleo,
    doTema('dz-canvas'), doTema('dz-text'), doTema('dz-text-secondary'),
    doTema('dz-accent'), doTema('dz-border'),
  ], { encoding: 'utf8' }))
} catch (erro) {
  process.stderr.write(`${String(erro.stdout ?? '')}${String(erro.stderr ?? erro.message)}\n`)
  process.stderr.write('Falta `Pillow`? `pip install pillow --break-system-packages`\n')
  process.exitCode = 1
}
