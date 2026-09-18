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
  /*
    O cartão social NÃO é referenciado pela interface: ele é carregado à mão na
    página de configurações do repositório, e nada no produto o lê. Ele está
    nesta lista porque some do mesmo jeito que os outros — e some em silêncio,
    já que a única coisa que o notaria é alguém colando o link do projeto num
    lugar que gere prévia, meses depois. `scripts/build-social-card.mjs` o gera.
  */
  'docs/images/social-card.png',
]
for (const arquivo of ARQUIVOS) {
  if (!existsSync(resolve(raiz, arquivo))) reprove(arquivo, 'referenciado pela marca e ausente do repositório')
}

/**
 * Os pedaços de texto que um PNG carrega em `tEXt`, como chave → valor.
 *
 * Um chunk `tEXt` é `tamanho(4) tipo(4) chave\0valor crc(4)`. Ler isto à mão
 * custa vinte linhas e evita uma dependência de imagem na CI — que é o preço
 * que `gate:pix` já recusou pagar para decodificar um QR.
 * @param caminho - o arquivo PNG.
 * @returns o mapa de chave para valor.
 */
export function textoDoPng(caminho) {
  const bytes = readFileSync(caminho)
  const mapa = new Map()
  let posicao = 8
  while (posicao + 8 <= bytes.length) {
    const tamanho = bytes.readUInt32BE(posicao)
    const tipo = bytes.toString('ascii', posicao + 4, posicao + 8)
    if (tipo === 'IEND') break
    if (tipo === 'tEXt') {
      const bruto = bytes.subarray(posicao + 8, posicao + 8 + tamanho)
      const corte = bruto.indexOf(0)
      if (corte > 0) mapa.set(bruto.toString('latin1', 0, corte), bruto.toString('latin1', corte + 1))
    }
    posicao += 12 + tamanho
  }
  return mapa
}

/*
  O CARTÃO SOCIAL ainda diz o que a marca diz HOJE?

  Este é o único arquivo de marca que nada regenera sozinho: ele não entra em
  build nenhum, e trocar o nome do produto sem rodar o gerador deixaria um
  cartão mentindo — para quem cola o link do projeto, que é justamente a pessoa
  que ainda não conhece o produto. O gerador grava dentro do PNG as entradas que
  o desenharam; aqui elas são comparadas com a fonte viva.

  Ele NÃO confere que o cartão foi CARREGADO no GitHub: a imagem social não
  existe na API REST nem no `gh`, e é enviada à mão na página de configurações.
  O portão prova o arquivo, não o efeito.
*/
const cartao = resolve(raiz, 'docs/images/social-card.png')
if (existsSync(cartao)) {
  const gravado = textoDoPng(cartao)
  if (gravado.get('frigg-marca') === undefined) {
    reprove('docs/images/social-card.png', 'não diz de que marca foi gerado: rode `node scripts/build-social-card.mjs`')
  } else if (gravado.get('frigg-marca') !== nomeCaixaAlta) {
    reprove('docs/images/social-card.png', `foi gerado para ${JSON.stringify(gravado.get('frigg-marca'))} e a marca hoje é ${JSON.stringify(nomeCaixaAlta)}: rode \`node scripts/build-social-card.mjs\``)
  }
}

for (const referencia of [...html.matchAll(/(?:href|src)="(\/studio\/(?:brand|icons)\/[^"]+)"/gu)].map(achado => achado[1])) {
  const arquivo = join('apps/studio-web/public', referencia.replace('/studio/', ''))
  if (!existsSync(resolve(raiz, arquivo))) reprove('apps/studio-web/index.html', `aponta para ${referencia}, que não existe`)
}
for (const icone of manifesto.icons) {
  const arquivo = join('apps/studio-web/public', String(icone.src).replace('/studio/', ''))
  if (!existsSync(resolve(raiz, arquivo))) reprove(manifestoCaminho, `ícone ${icone.src} não existe`)
}


/**
 * A CAMADA DE APRESENTAÇÃO: o que alguém lê antes de instalar.
 *
 * O portão nasceu olhando as superfícies do produto, e isso deixou de fora
 * justamente a porta de entrada: o README, os guias e a constituição
 * continuaram dizendo o nome anterior depois de o produto inteiro já dizer o
 * novo. Quem abria o repositório via um projeto que não existe mais — com
 * capturas de uma interface que também não existe.
 *
 * Documentos HISTÓRICOS ficam de fora de propósito e não entram nesta lista:
 * ADRs, livro mestre, relatórios de auditoria e `docs/inventory` registram o
 * que aconteceu com o nome que a coisa tinha na época, e reescrevê-los seria
 * apagar o registro para fazer o passado combinar com o presente.
 */
const APRESENTACAO = [
  'README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'TRADEMARKS.md',
  'docs/PRODUCT_CONSTITUTION.md',
  ...readdirSync(resolve(raiz, 'docs/guides')).filter(nome => nome.endsWith('.md')).map(nome => join('docs/guides', nome)),
]

/**
 * As citações da marca ANTERIOR que podem ficar, uma a uma, com motivo.
 *
 * Um portão sem dispensa é contornado no primeiro falso positivo; uma dispensa
 * aberta deixa de ser portão. Cada entrada nomeia o ARQUIVO, o número de
 * ocorrências e o porquê — e o número importa: uma citação nova entra sem que
 * ninguém decida se ele for aberto.
 */
const CITACOES_HISTORICAS = [
  { arquivo: 'CLAUDE.md', quantas: 1, motivo: 'diz em que data o produto mudou de nome, para quem chega não achar que os documentos antigos estão errados' },
  { arquivo: 'docs/PRODUCT_CONSTITUTION.md', quantas: 1, motivo: 'a cláusula 1.1 nomeia o que virou histórico ao declarar o nome novo' },
]

const MARCA_ANTERIOR = /DZ23\s+STUDIO|DZ23\s+Studio/gu

for (const caminho of APRESENTACAO) {
  const conteudo = readFileSync(resolve(raiz, caminho), 'utf8')
  const quantas = [...conteudo.matchAll(MARCA_ANTERIOR)].length
  const permitidas = CITACOES_HISTORICAS.find(entrada => entrada.arquivo === caminho)?.quantas ?? 0
  if (quantas > permitidas) {
    reprove(caminho, `cita a marca anterior ${quantas}× e só ${permitidas} está declarada como histórica`)
  }
  if (quantas < permitidas) {
    // Dispensa que sobra é dispensa que ninguém conferiu: ela passaria a
    // cobrir uma citação NOVA no dia em que alguém escrevesse uma.
    reprove(caminho, `tem ${permitidas} citação histórica declarada e só ${quantas} existe: a dispensa sobrando cobriria uma citação nova`)
  }
}

/*
  As IMAGENS que o README aponta existem?

  Um caminho quebrado no README não falha em teste nenhum: o GitHub desenha o
  ícone de imagem partida, e quem vê conclui que o projeto está abandonado.
*/
const readme = readFileSync(resolve(raiz, 'README.md'), 'utf8')
for (const achado of readme.matchAll(/!\[[^\]]*\]\((\.\/[^)]+)\)|<img src="(\.\/[^"]+)"/gu)) {
  const referencia = achado[1] ?? achado[2] ?? ''
  if (!existsSync(resolve(raiz, referencia.replace(/^\.\//u, '')))) {
    reprove('README.md', `aponta para a imagem ${referencia}, que não existe`)
  }
}

// ------------------------------------------------------------------ o veredito
for (const { onde, motivo } of achados) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`MARCA=${achados.length === 0 ? 'PASS' : 'FAIL'} fonte=${fonteCaminho} nome=${nome} dominio=${dominio} publicado=${publicado} catalogos=${catalogos().length} achados=${achados.length}\n`)
process.exitCode = achados.length === 0 ? 0 : 1
