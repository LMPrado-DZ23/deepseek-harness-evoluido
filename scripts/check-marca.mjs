#!/usr/bin/env node
/**
 * O PORTÃO DA MARCA: uma marca só, e ela não arrasta a identidade junto.
 *
 * Ele existe por causa de duas coisas que este repositório já viu custar caro.
 *
 * ## 1. A segunda verdade
 *
 * O nome do produto estava escrito à mão em onze lugares — `index.html`,
 * manifesto da PWA e nove catálogos de tradução. Nenhum teste podia pegar a
 * divergência: cada lugar está certo sozinho. Aqui todos são comparados com a
 * ÚNICA fonte, `apps/studio-web/src/marca/marca.ts`, e um só que discorde
 * derruba o portão.
 *
 * ## 2. A renomeação por busca e substituição
 *
 * A decisão do proprietário é explícita: marca é APRESENTAÇÃO. Ela não autoriza
 * trocar `id`, `scope` nem `start_url` do manifesto — são identidade de
 * instalação, e mudá-los faz o navegador tratar a PWA instalada como outro
 * aplicativo, perdendo o que a pessoa tinha. O portão CONGELA esses três.
 *
 * ## 3. O domínio que ninguém provou controlar
 *
 * `frigg.ia.br` foi escolhido; o kit diz com todas as letras que isso não
 * comprova compra, DNS, certificado nem serviço publicado. Enquanto
 * `dominioPublicado` for `false`, nenhum texto de interface pode escrever o
 * domínio — uma frase dessas manda a pessoa a um endereço que talvez não exista.
 *
 * Uso: node scripts/check-marca.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const raiz = process.cwd()
const achados = []
const reprove = (onde, motivo) => achados.push({ onde, motivo })

// ---------------------------------------------------------------- a fonte
const fonteCaminho = 'apps/studio-web/src/marca/marca.ts'
const fonte = readFileSync(resolve(raiz, fonteCaminho), 'utf8')

/**
 * Lê um campo de texto da constante `MARCA`.
 *
 * É leitura por expressão regular, e não `import`: o portão roda em Node puro,
 * sobre TypeScript não compilado. Um campo que sumir não vira string vazia —
 * vira falha, porque uma fonte ilegível é pior que uma fonte errada.
 * @param campo - o nome do campo.
 * @returns o valor.
 */
function texto(campo) {
  const achado = new RegExp(`${campo}:\\s*'([^']+)'`, 'u').exec(fonte)
  if (achado === null) {
    reprove(fonteCaminho, `a fonte da marca não declara \`${campo}\``)
    return null
  }
  return achado[1]
}

const nome = texto('nome')
const nomeCaixaAlta = texto('nomeCaixaAlta')
const dominio = texto('dominioEscolhido')
const publicado = /dominioPublicado:\s*true/u.test(fonte)

// ------------------------------------------------- as superfícies estáticas
const html = readFileSync(resolve(raiz, 'apps/studio-web/index.html'), 'utf8')
const titulo = /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? null
const applicationName = /name="application-name"\s+content="([^"]*)"/u.exec(html)?.[1] ?? null
if (titulo !== nomeCaixaAlta) reprove('apps/studio-web/index.html', `<title> diz ${JSON.stringify(titulo)} e a fonte diz ${JSON.stringify(nomeCaixaAlta)}`)
if (applicationName !== nomeCaixaAlta) reprove('apps/studio-web/index.html', `application-name diz ${JSON.stringify(applicationName)} e a fonte diz ${JSON.stringify(nomeCaixaAlta)}`)

const manifestoCaminho = 'apps/studio-web/public/manifest.json'
const manifesto = JSON.parse(readFileSync(resolve(raiz, manifestoCaminho), 'utf8'))
if (manifesto.name !== nomeCaixaAlta) reprove(manifestoCaminho, `name diz ${JSON.stringify(manifesto.name)} e a fonte diz ${JSON.stringify(nomeCaixaAlta)}`)
if (manifesto.short_name !== nomeCaixaAlta) reprove(manifestoCaminho, `short_name diz ${JSON.stringify(manifesto.short_name)} e a fonte diz ${JSON.stringify(nomeCaixaAlta)}`)

/**
 * A IDENTIDADE DE INSTALAÇÃO, congelada.
 *
 * Estes três valores são anteriores à decisão de marca e não pertencem a ela.
 * Se algum dia precisarem mudar, isso é um delta de implantação com plano,
 * teste e autorização — nunca um efeito colateral de trocar o nome exibido.
 */
const IDENTIDADE_CONGELADA = { id: '/studio/', scope: '/studio/', start_url: '/studio/' }
for (const [campo, esperado] of Object.entries(IDENTIDADE_CONGELADA)) {
  if (manifesto[campo] !== esperado) {
    reprove(manifestoCaminho, `${campo} virou ${JSON.stringify(manifesto[campo])}; a identidade de instalação é ${JSON.stringify(esperado)} e marca não a muda`)
  }
}

// ------------------------------------------------------------- os catálogos
/**
 * Marcas de produto que NÃO podem sobreviver num texto de interface.
 *
 * `DZ23_` com sublinhado fica de fora de propósito: `DZ23_APP_SMTP` é nome de
 * variável de ambiente, é o que a pessoa digita, e trocá-lo quebraria a
 * instalação de quem já configurou.
 */
const CONCORRENTES = [
  { padrao: /DZ23\s+STUDIO/giu, motivo: 'a marca anterior por extenso' },
  { padrao: /(?<![\w/\-])Studio(?![\w/\-])/gu, motivo: 'o nome anterior sozinho' },
  { padrao: /(?<![\w_/\-])DZ23(?![\w_/\-])/gu, motivo: 'a origem usada como se fosse a marca do produto' },
]

/**
 * Todo catálogo de tradução do produto.
 * @returns os caminhos, relativos à raiz.
 */
function catalogos() {
  const lista = readdirSync(resolve(raiz, 'apps/studio-web/src/i18n'))
    .filter(arquivo => arquivo.endsWith('.json'))
    .map(arquivo => join('apps/studio-web/src/i18n', arquivo))
  for (const plugin of readdirSync(resolve(raiz, 'plugins'))) {
    const pasta = resolve(raiz, 'plugins', plugin, 'i18n')
    if (!existsSync(pasta)) continue
    for (const arquivo of readdirSync(pasta)) {
      if (arquivo.endsWith('.json')) lista.push(join('plugins', plugin, 'i18n', arquivo))
    }
  }
  return lista.sort()
}

for (const caminho of catalogos()) {
  const conteudo = readFileSync(resolve(raiz, caminho), 'utf8')
  for (const { padrao, motivo } of CONCORRENTES) {
    const quantos = [...conteudo.matchAll(padrao)].length
    if (quantos > 0) reprove(caminho, `${quantos}× ${motivo}`)
  }
  if (!publicado && conteudo.includes(dominio)) {
    reprove(caminho, `escreve ${dominio}, e o domínio não está publicado`)
  }
}

// ----------------------------------------------------------------- os arquivos
/**
 * Os arquivos de marca que a interface referencia de verdade.
 *
 * Um caminho que resolve em 404 não aparece em teste de unidade nenhum: o
 * componente renderiza, o atributo existe, e a pessoa vê o ícone quebrado.
 */
const ARQUIVOS = [
  'apps/studio-web/public/brand/frigg-simbolo-original.png',
  'apps/studio-web/public/brand/frigg-micro-f-original.png',
  'apps/studio-web/public/brand/frigg-mark-48.png',
  'apps/studio-web/public/brand/frigg-mark-96.png',
  'apps/studio-web/public/brand/frigg-mark-256.png',
  'apps/studio-web/public/icons/favicon-32.png',
  'apps/studio-web/public/icons/icon-192.png',
  'apps/studio-web/public/icons/icon-512.png',
  'apps/studio-web/public/icons/maskable-512.png',
]
for (const arquivo of ARQUIVOS) {
  if (!existsSync(resolve(raiz, arquivo))) reprove(arquivo, 'referenciado pela marca e ausente do repositório')
}

for (const referencia of [...html.matchAll(/(?:href|src)="(\/studio\/(?:brand|icons)\/[^"]+)"/gu)].map(achado => achado[1])) {
  const arquivo = join('apps/studio-web/public', referencia.replace('/studio/', ''))
  if (!existsSync(resolve(raiz, arquivo))) reprove('apps/studio-web/index.html', `aponta para ${referencia}, que não existe`)
}
for (const icone of manifesto.icons) {
  const arquivo = join('apps/studio-web/public', String(icone.src).replace('/studio/', ''))
  if (!existsSync(resolve(raiz, arquivo))) reprove(manifestoCaminho, `ícone ${icone.src} não existe`)
}

// ------------------------------------------------------------------ o veredito
for (const { onde, motivo } of achados) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`MARCA=${achados.length === 0 ? 'PASS' : 'FAIL'} fonte=${fonteCaminho} nome=${nome} dominio=${dominio} publicado=${publicado} catalogos=${catalogos().length} achados=${achados.length}\n`)
process.exitCode = achados.length === 0 ? 0 : 1
