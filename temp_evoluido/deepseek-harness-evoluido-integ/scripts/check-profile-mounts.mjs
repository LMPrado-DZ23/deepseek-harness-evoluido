/**
 * Todo plugin que o perfil DECLARA COMO DEPENDÊNCIA está montado em algum lugar?
 *
 * Este portão existe por causa de um defeito real, encontrado na conferência do
 * MASTER V6: `@dz23-studio/emergency-stop` era dependência do perfil desde o
 * começo, tinha domínio, serviço, rotas, tela e testes — e **não era montado em
 * perfil nenhum**. Os três consumidores resolvem o serviço com
 * `ctx.get('studioEmergencyStop')` e seguem em frente quando ele é `undefined`,
 * de propósito, para que um plugin opcional não derrube o Studio. O resultado é
 * o pior dos dois mundos: a tela mostra o botão de parada de emergência, as
 * rotas não existem e nenhuma execução é bloqueada.
 *
 * Nada acusava isso. Os testes do plugin passavam (testam o plugin), os portões
 * passavam (não olham montagem) e o e2e não cobre a parada. O defeito vivia
 * exatamente no espaço entre "o código existe" e "o código roda" — que é onde
 * esta casa já se queimou com o artefato versionado desatualizado.
 *
 * A regra: uma dependência declarada ou é MONTADA, ou é uma EXCEÇÃO DECLARADA
 * aqui com o lugar onde ela é montada. Não há terceira opção, e uma dependência
 * nova não passa sem alguém escrever qual das duas ela é.
 *
 * Uso: node scripts/check-profile-mounts.mjs [--self-test]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Os arquivos onde uma montagem pode aparecer, com o nome que o relatório usa. */
export const MOUNT_FILES = [
  ['perfil studio', 'dsh-home/profiles/studio/cordis.patch.yml'],
  ['overlay de borda', 'deploy/harness/edge.patch.yml'],
  ['preset do assistente', 'dsh-home/.agent-presets/dz23-assistant/agent.cordis.yml'],
  ['preset do coordenador', 'dsh-home/.agent-presets/dz23-coordinator/agent.cordis.yml'],
  ['preset do coordenador em processo', 'dsh-home/.agent-presets/dz23-coordinator-in-process/agent.cordis.yml'],
]

/**
 * Dependências que NÃO são montadas, e a razão — cada uma conferida à mão.
 *
 * Uma entrada aqui é uma promessa de que a ausência é deliberada. Ela não é um
 * lugar para silenciar um defeito: se o motivo não couber numa frase que um
 * revisor aceite, o plugin não é exceção, é buraco.
 */
export const NAO_MONTADOS = {
  '@dz23-studio/web': 'e a interface compilada; quem a serve e o plugin montado com o id dz23-studio-web.',
}

/**
 * O nome do pacote a partir do id de montagem, quando o id é o convencional.
 * @param pacote - nome do pacote npm, como `@dz23-studio/emergency-stop`.
 * @returns o id convencional `dz23-studio-<sufixo>`.
 */
export function idConvencional(pacote) {
  return `dz23-studio-${pacote.split('/')[1]}`
}

/**
 * Tira os comentários de um YAML, linha a linha.
 *
 * Existe por um achado de revisão independente: a busca era `includes()` sobre
 * o arquivo inteiro, então **uma menção em comentário passava por montagem**.
 * Um perfil que dissesse "# o emergency-stop NÃO é montado aqui" aprovaria o
 * portão — o texto que explica a ausência valendo como presença.
 *
 * O corte é conservador: só descarta o que vem depois de `#` quando ele começa
 * a linha ou vem depois de espaço, para não cortar `#` dentro de um valor.
 * @param conteudo - o texto do arquivo.
 * @returns o mesmo texto sem os comentários.
 */
export function semComentarios(conteudo) {
  return conteudo.split('\n').map(linha => {
    const semAspas = linha.replace(/'[^']*'|"[^"]*"/gu, aspas => ' '.repeat(aspas.length))
    const corte = semAspas.search(/(?:^|\s)#/u)
    return corte === -1 ? linha : linha.slice(0, corte)
  }).join('\n')
}

/**
 * Procura a montagem ESTRUTURAL de um pacote nos arquivos de perfil.
 *
 * Duas formas contam, e só elas: uma linha `name: '<pacote>'`, que é como o
 * perfil nomeia o pacote a montar, e um item de lista `- id: <id>`, que é como
 * ele nomeia a linha montada. Qualquer outra aparição — comentário, prosa,
 * dependência no `package.json` — deixou de contar.
 *
 * Isto continua sendo análise de TEXTO, e não composição resolvida: o portão
 * prova que a entrada está escrita no perfil, não que o serviço subiu. Essa
 * segunda prova exige carregar o runtime, está declarada como pendente e não é
 * substituída por este portão.
 * @param pacote - nome do pacote npm.
 * @param textos - pares [rótulo, conteúdo] dos arquivos de montagem.
 * @returns o rótulo do arquivo onde está montado, ou `null`.
 */
export function ondeMontado(pacote, textos) {
  // Em modo `u`, escapar um caractere que nao precisa e erro de sintaxe: a
  // lista e exatamente a dos metacaracteres, e `-`, `@` e `/` ficam de fora.
  const escapaRegex = texto => texto.replace(/[.*+?^${}()|[\]\\]/gu, carater => `\\${carater}`)
  const porNome = new RegExp(`(?:^|\\n)\\s*(?:-\\s*)?name:\\s*['"]?${escapaRegex(pacote)}['"]?\\s*$`, 'mu')
  const porId = new RegExp(`(?:^|\\n)\\s*-\\s*id:\\s*${idConvencional(pacote)}\\s*$`, 'mu')
  for (const [rotulo, conteudo] of textos) {
    const limpo = semComentarios(conteudo)
    if (porNome.test(limpo) || porId.test(limpo)) return rotulo
  }
  return null
}

/**
 * Confere o perfil inteiro.
 * @param dependencias - o objeto `dependencies` do `package.json` do perfil.
 * @param textos - pares [rótulo, conteúdo] dos arquivos de montagem.
 * @returns os achados, um por dependência não montada e não declarada.
 */
export function achados(dependencias, textos) {
  const resultado = []
  for (const pacote of Object.keys(dependencias)) {
    if (!pacote.startsWith('@dz23-studio/')) continue
    if (Object.hasOwn(NAO_MONTADOS, pacote)) continue
    if (ondeMontado(pacote, textos) === null) {
      resultado.push(`${pacote}: declarado como dependência do perfil e NÃO montado em nenhum arquivo de perfil`)
    }
  }
  return resultado
}


/**
 * OS NOMES DE SERVIÇO QUE CADA PLUGIN PEDE, e quem os oferece.
 *
 * Esta segunda família de achados existe por um defeito medido em 18/09/2026,
 * e ele era o pior tipo: o produto NÃO ABRIA. `@dz23-studio/business` declarava
 * `inject = ['storageDomain', 'promptToApp']`, e nenhum plugin oferece
 * `promptToApp` — o nome real é `studioPromptToApp`, que é o que os outros
 * quatro consumidores pedem. O Cordis não inventa serviço: ele espera. A
 * entrada ficava `pending (waiting for service: promptToApp)`, o carregamento
 * da árvore falhava, e o `pnpm studio` morria depois de imprimir o endereço.
 *
 * Nada acusava. Os testes do plugin montam o que o plugin precisa; o portão de
 * montagem conferia que a LINHA existe no perfil, e ela existia; e o e2e usa
 * servidor próprio. O defeito morava no espaço entre "está montado" e "sobe" —
 * o mesmo espaço do artefato versionado desatualizado, e o próprio comentário
 * deste portão dizia que essa prova faltava.
 *
 * A prova aqui é ESTÁTICA, e continua não sendo a composição resolvida: um
 * nome pedido tem de ser oferecido por ALGUÉM — por um plugin nosso, com
 * `ctx.provide('<nome>')`, ou pelo Harness fixado, cuja lista é LIDA do
 * submódulo e não escrita à mão aqui. O que ela não prova é ordem de montagem.
 */

/**
 * Os nomes que um arquivo oferece com `provide`.
 * @param conteudo - o texto do arquivo.
 * @returns os nomes, sem repetição.
 */
export function nomesOferecidos(conteudo) {
  // DUAS formas, porque o Cordis tem duas. `provide('nome')` é a explícita; um
  // serviço de classe se registra em `super(ctx, 'nome')`, e é assim que o
  // Harness oferece `tools`, `storage` e `sessionController`. Ler só a primeira
  // fazia o portão acusar seis serviços que existem — e um portão que grita sem
  // razão é desligado, que é como um portão morre.
  const formas = [
    /provide\(\s*['"]([A-Za-z][A-Za-z0-9_.]*)['"]/gu,
    /super\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9_.]*)['"]/gu,
  ]
  const nomes = []
  for (const forma of formas) {
    for (const achado of conteudo.matchAll(forma)) nomes.push(achado[1])
  }
  return [...new Set(nomes)]
}

/**
 * Os nomes que um arquivo PEDE na sua lista `inject`.
 *
 * Só a forma literal conta — `export const inject = ['a', 'b']`. Uma lista
 * montada em tempo de execução não é lida aqui, e isso é limite declarado: o
 * portão prefere não ver a pedir que alguém escreva a lista de outro jeito para
 * escapar dele.
 * @param conteudo - o texto do arquivo.
 * @returns os nomes pedidos.
 */
export function nomesPedidos(conteudo) {
  const bloco = /export const inject\s*=\s*\[([^\]]*)\]/u.exec(conteudo)
  if (bloco === null) return []
  return (bloco[1].match(/['"]([A-Za-z][A-Za-z0-9_.]*)['"]/gu) ?? [])
    .map(trecho => trecho.slice(1, -1))
}

/**
 * Os achados de serviço pedido e não oferecido.
 * @param pedidos - pares [rótulo do plugin, nomes pedidos].
 * @param oferecidos - todos os nomes oferecidos por alguém.
 * @returns um achado por nome pedido que ninguém oferece.
 */
export function achadosDeServico(pedidos, oferecidos) {
  const conjunto = new Set(oferecidos)
  const resultado = []
  for (const [plugin, nomes] of pedidos) {
    for (const nome of nomes) {
      if (conjunto.has(nome)) continue
      resultado.push(`${plugin}: pede o serviço \`${nome}\`, e NINGUÉM o oferece — a entrada fica pendente e a árvore inteira não sobe`)
    }
  }
  return resultado
}

/** Lê o disco: o que cada plugin nosso pede, e tudo que existe para oferecer. */
function servicosDoDisco() {
  const pedidos = []
  const oferecidos = []
  const pluginsDir = resolve(root, 'plugins')
  for (const nome of readdirSync(pluginsDir)) {
    const indice = resolve(pluginsDir, nome, 'src', 'index.ts')
    if (!existsSync(indice)) continue
    const conteudo = readFileSync(indice, 'utf8')
    pedidos.push([`plugins/${nome}`, nomesPedidos(conteudo)])
  }
  // O que NOSSOS plugins oferecem: a varredura é da pasta inteira, porque um
  // `provide` não precisa morar no `index.ts`.
  for (const nome of readdirSync(pluginsDir)) {
    const src = resolve(pluginsDir, nome, 'src')
    if (!existsSync(src)) continue
    for (const arquivo of readdirSync(src)) {
      if (!arquivo.endsWith('.ts')) continue
      oferecidos.push(...nomesOferecidos(readFileSync(resolve(src, arquivo), 'utf8')))
    }
  }
  // E o que o HARNESS oferece, LIDO do submódulo fixado: escrever a lista aqui
  // seria uma segunda verdade sobre um upstream que não é nosso.
  oferecidos.push(...nomesDoHarness(resolve(root, 'third_party/deepseek-harness/packages'), 0))
  return { pedidos, oferecidos }
}

/**
 * Varre o Harness fixado atrás dos nomes que ele oferece.
 * @param dir - a pasta a varrer.
 * @param profundidade - o nível atual.
 * @returns os nomes encontrados.
 */
export function nomesDoHarness(dir, profundidade) {
  if (profundidade > 5 || !existsSync(dir)) return []
  const saida = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === 'node_modules') continue
    const caminho = resolve(dir, entrada.name)
    if (entrada.isDirectory()) { saida.push(...nomesDoHarness(caminho, profundidade + 1)); continue }
    if (!/\.(?:ts|js)$/u.test(entrada.name)) continue
    saida.push(...nomesOferecidos(readFileSync(caminho, 'utf8')))
  }
  return saida
}

function textos() {
  return MOUNT_FILES.map(([rotulo, caminho]) => {
    try { return [rotulo, readFileSync(resolve(root, caminho), 'utf8')] }
    catch { return [rotulo, ''] }
  })
}

if (process.argv.includes('--self-test')) {
  // A sabotagem que este portão precisa pegar é exatamente a que aconteceu:
  // dependência declarada, nenhuma montagem.
  const semMontagem = achados({ '@dz23-studio/emergency-stop': 'workspace:*' }, [['perfil', 'nada aqui']])
  if (semMontagem.length !== 1) { process.stderr.write('self-test: nao pegou a dependencia nao montada\n'); process.exit(1) }
  const comMontagem = achados({ '@dz23-studio/emergency-stop': 'workspace:*' }, [['perfil', "name: '@dz23-studio/emergency-stop'"]])
  if (comMontagem.length !== 0) { process.stderr.write('self-test: reprovou uma montagem valida\n'); process.exit(1) }
  const porId = achados({ '@dz23-studio/mission': 'workspace:*' }, [['perfil', '    - id: dz23-studio-mission']])
  if (porId.length !== 0) { process.stderr.write('self-test: nao reconheceu montagem pelo id convencional\n'); process.exit(1) }
  // O achado da revisao independente: menção em COMENTÁRIO nao e montagem.
  const soComentario = achados({ '@dz23-studio/emergency-stop': 'workspace:*' },
    [['perfil', "    # o name: '@dz23-studio/emergency-stop' sai daqui na proxima versao"]])
  if (soComentario.length !== 1) { process.stderr.write('self-test: aceitou comentario como montagem\n'); process.exit(1) }
  // E prosa solta tambem nao.
  const soProsa = achados({ '@dz23-studio/emergency-stop': 'workspace:*' },
    [['perfil', 'este perfil usa @dz23-studio/emergency-stop quando alguem montar']])
  if (soProsa.length !== 1) { process.stderr.write('self-test: aceitou prosa como montagem\n'); process.exit(1) }
  // Uma dependência que não é nossa não é problema deste portão.
  const alheia = achados({ '@deepseek-ai/dsh-base': 'workspace:*' }, [['perfil', '']])
  if (alheia.length !== 0) { process.stderr.write('self-test: reclamou de pacote de terceiro\n'); process.exit(1) }
  // A SEGUNDA FAMÍLIA: o defeito medido — nome pedido que ninguém oferece.
  const servicoAusente = achadosDeServico([['plugins/business', ['storageDomain', 'promptToApp']]], ['storageDomain', 'studioPromptToApp'])
  if (servicoAusente.length !== 1) { process.stderr.write('self-test: nao pegou o servico pedido e nao oferecido\n'); process.exit(1) }
  const servicoPresente = achadosDeServico([['plugins/business', ['storageDomain', 'studioPromptToApp']]], ['storageDomain', 'studioPromptToApp'])
  if (servicoPresente.length !== 0) { process.stderr.write('self-test: reprovou um servico oferecido\n'); process.exit(1) }
  const leitura = nomesPedidos("export const inject = ['a', \"b\"]\n")
  if (leitura.join(',') !== 'a,b') { process.stderr.write('self-test: nao leu a lista inject\n'); process.exit(1) }
  const semLista = nomesPedidos('export const name = "x"')
  if (semLista.length !== 0) { process.stderr.write('self-test: inventou lista inject\n'); process.exit(1) }
  const oferta = nomesOferecidos("ctx.provide('studioPromptToApp', algo)\nprovide( \"outro\" )")
  if (oferta.join(',') !== 'studioPromptToApp,outro') { process.stderr.write('self-test: nao leu os provides\n'); process.exit(1) }
  // A segunda forma do Cordis: serviço de classe.
  const ofertaDeClasse = nomesOferecidos("class T extends Service {\n  constructor(ctx) { super(ctx, 'tools') }\n}")
  if (ofertaDeClasse.join(',') !== 'tools') { process.stderr.write('self-test: nao leu o servico de classe\n'); process.exit(1) }
  process.stdout.write('PROFILE_MOUNTS_SELF_TEST=PASS checks=12\n')
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(resolve(root, 'dsh-home/profiles/studio/package.json'), 'utf8'))
const servicos = servicosDoDisco()
const encontrados = [...achados(pkg.dependencies ?? {}, textos()), ...achadosDeServico(servicos.pedidos, servicos.oferecidos)]
for (const linha of encontrados) process.stdout.write(`${linha}\n`)
const total = Object.keys(pkg.dependencies ?? {}).filter(nome => nome.startsWith('@dz23-studio/')).length
process.stdout.write(`PROFILE_MOUNTS=${encontrados.length === 0 ? 'PASS' : 'FAIL'} plugins=${String(total)} excecoes=${String(Object.keys(NAO_MONTADOS).length)} achados=${String(encontrados.length)}\n`)
process.exit(encontrados.length === 0 ? 0 : 1)
