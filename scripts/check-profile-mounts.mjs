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
import { readFileSync } from 'node:fs'
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
 * Procura a montagem de um pacote nos arquivos de perfil.
 *
 * A busca é pelo NOME DO PACOTE e pelo id convencional: um perfil pode montar
 * com id próprio, e exigir o id convencional transformaria este portão numa
 * regra de nomenclatura disfarçada de regra de segurança.
 * @param pacote - nome do pacote npm.
 * @param textos - pares [rótulo, conteúdo] dos arquivos de montagem.
 * @returns o rótulo do arquivo onde está montado, ou `null`.
 */
export function ondeMontado(pacote, textos) {
  for (const [rotulo, conteudo] of textos) {
    if (conteudo.includes(`'${pacote}'`) || conteudo.includes(`"${pacote}"`)) return rotulo
    if (conteudo.includes(`id: ${idConvencional(pacote)}\n`) || conteudo.includes(`id: ${idConvencional(pacote)}`)) return rotulo
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
  const porId = achados({ '@dz23-studio/mission': 'workspace:*' }, [['perfil', '- id: dz23-studio-mission']])
  if (porId.length !== 0) { process.stderr.write('self-test: nao reconheceu montagem pelo id convencional\n'); process.exit(1) }
  // Uma dependência que não é nossa não é problema deste portão.
  const alheia = achados({ '@deepseek-ai/dsh-base': 'workspace:*' }, [['perfil', '']])
  if (alheia.length !== 0) { process.stderr.write('self-test: reclamou de pacote de terceiro\n'); process.exit(1) }
  process.stdout.write('PROFILE_MOUNTS_SELF_TEST=PASS checks=4\n')
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(resolve(root, 'dsh-home/profiles/studio/package.json'), 'utf8'))
const encontrados = achados(pkg.dependencies ?? {}, textos())
for (const linha of encontrados) process.stdout.write(`${linha}\n`)
const total = Object.keys(pkg.dependencies ?? {}).filter(nome => nome.startsWith('@dz23-studio/')).length
process.stdout.write(`PROFILE_MOUNTS=${encontrados.length === 0 ? 'PASS' : 'FAIL'} plugins=${String(total)} excecoes=${String(Object.keys(NAO_MONTADOS).length)} achados=${String(encontrados.length)}\n`)
process.exit(encontrados.length === 0 ? 0 : 1)
