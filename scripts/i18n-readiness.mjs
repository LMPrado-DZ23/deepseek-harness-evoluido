/**
 * The catalogues the i18n gate has to READ, and the readiness claims it refuses to find in them.
 *
 * It lives on its own because the list used to be a literal inside the gate, walked with
 * `if (!exists(full)) continue`: renaming a catalogue — or moving one plugin's `i18n/` folder —
 * turned that scan into zero items and the gate still printed PASS. A gate that inspected nothing
 * has not approved anything, so a catalogue that is expected and missing is a FAILURE here, and so
 * is a scan that ends up reading no catalogue at all.
 *
 * `plugins/<name>/i18n/pt-BR.json` was never scanned for readiness claims at all: a plugin could
 * promise the person that something was "pronto" and no gate ever looked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** "pronto", "pronta", "prontos", "prontas": a claim about readiness this product does not make. */
const READY_CLAIM = /\bpront[oa]s?\b/iu

/**
 * Palavras de máquina que a PESSOA não deveria precisar entender.
 *
 * A instrução do produto é explícita: quem usa não precisa saber o que é build,
 * contêiner, rota ou token. Mesmo assim "Harness" — o nome do MOTOR, não do
 * produto — aparecia em cinco frases da tela, o consumo do trabalho era medido
 * "em tokens" e a tela do plano falava em `commit`, `bytes` e `repositório`.
 *
 * A lista é FECHADA e vale só para os catálogos que a pessoa lê. Catálogo de
 * plugin carrega erro de configuração para quem OPERA o Studio, e traduzir
 * `cwd` ali só tiraria a precisão de quem precisa dela.
 */
const PERSON_FACING_CATALOGUES = [
  'apps/studio-web/src/i18n/',
  'plugins/prompt-to-app/i18n/generated-app/',
]

const MACHINE_WORDS = [
  'Harness', 'cwd', 'commit', 'token', 'tokens', 'repositório', 'repositorio',
  'container', 'runtime', 'endpoint', 'deploy', 'rollback', 'passkey',
  'worktree', 'sandbox', 'backend', 'frontend', 'bytes', 'JSON',
]

/**
 * As chaves de plugin que NÃO são lidas pela pessoa, uma a uma, com motivo.
 *
 * A varredura passou a valer para todo catálogo, e não só para os da interface:
 * frases de plugin chegam à tela ("A interface do Harness ainda não está
 * disponível"). Mas boa parte dos catálogos de plugin é outra coisa —
 * instrução para o modelo, erro de contrato de API, mensagem para quem opera o
 * banco — e traduzir `JSON` ali tiraria a precisão de quem precisa dela.
 *
 * A dispensa é por PADRÃO DE CHAVE e traz o motivo, como a da varredura de
 * segredos. Uma dispensa larga demais aparece aqui, escrita, em vez de sumir
 * dentro de uma condição.
 */
const OPERATOR_KEYS = [
  { plugin: 'prompt-to-app', pattern: /^prompts\./u, reason: 'instruções para o MODELO, não texto de tela' },
  { plugin: '*', pattern: /json(?:Required|Invalid|BodyRequired)$|^errors\.invalidJson$|^http\.invalidJson$/iu, reason: 'erro de contrato de API, lido por quem integra' },
  { plugin: 'agents', pattern: /^git\./u, reason: 'fronteira do Git: superfície de quem opera o repositório do projeto' },
  { plugin: 'assistant-bridge', pattern: /^errors\.(?:duplicateRepository|repositoryMissing|repositoryStrings|absoluteRepository|gitRoot)$/u, reason: 'configuração do repositório liberado, feita por quem administra' },
  { plugin: 'assistant-bridge', pattern: /^tools\./u, reason: 'descrição de ferramenta para o assistente, não para a tela' },
  { plugin: 'preview', pattern: /^(?:service|supervisor)\./u, reason: 'contrato com o supervisor de prévia, lido por quem opera' },
  { plugin: 'storage-postgres', pattern: /^restore\./u, reason: 'operação de restauração de banco, feita por quem administra' },
  { plugin: 'identity', pattern: /Audit$/u, reason: 'linha de auditoria, lida em investigação e não na tela' },
]

/** Se esta chave é de operação, e por quê. */
function operatorKey(target, key) {
  const plugin = /^plugins\/([^/]+)\//u.exec(target)?.[1]
  return OPERATOR_KEYS.some(entry => (entry.plugin === '*' || entry.plugin === plugin) && entry.pattern.test(key))
}

/** Se este catálogo é lido pela pessoa que usa o produto. */
function personFacing(target) {
  return PERSON_FACING_CATALOGUES.some(prefix => target.startsWith(prefix))
    || /^plugins\/[^/]+\/i18n\/pt-BR\.json$/u.test(target)
}

/**
 * As palavras de máquina encontradas num texto.
 * @param value - o texto do catálogo.
 * @returns as palavras proibidas presentes.
 */
export function machineWordsIn(value) {
  // `{bytes}` e `{commit}` são NOMES DE CAMPO, trocados por um número e por uma
  // versão antes de a frase existir na tela. Reprová-los mandaria renomear
  // variável para agradar um portão de texto.
  const visible = value.replace(/\{[^}]*\}/gu, ' ')
  return MACHINE_WORDS.filter(word => new RegExp(`\\b${word}\\b`, 'iu').test(visible))
}

/** Catalogues that must exist. Absence is a failure, never a skipped item. */
export const REQUIRED_CATALOGUES = [
  // O catálogo PRINCIPAL da interface não estava nesta lista: a varredura de
  // prontidão e a de palavra de máquina passavam ao largo justamente do texto
  // que a pessoa mais lê. O `check-i18n` lia este arquivo por conta própria,
  // para outra conferência, e a ausência aqui não aparecia em lugar nenhum.
  'apps/studio-web/src/i18n/pt-BR.json',
  'apps/studio-web/src/i18n/assistant.pt-BR.json',
  'apps/studio-web/src/i18n/team.pt-BR.json',
  'apps/studio-web/src/i18n/pwa.pt-BR.json',
  'apps/studio-web/src/i18n/hub.pt-BR.json',
  // O vocabulário do palpite de categoria também é texto de idioma: renomeá-lo
  // não pode encolher o portão em silêncio.
  'apps/studio-web/src/i18n/categorySignals.pt-BR.json',
  'apps/studio-web/src/i18n/help.pt-BR.json',
  'apps/studio-web/public/manifest.json',
]

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Every plugin that HAS an `i18n/` folder owes a `pt-BR.json` in it; the path is returned either way. */
export function pluginCatalogues(root) {
  let entries = []
  try { entries = readdirSync(resolve(root, 'plugins'), { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(entry => entry.isDirectory() && isDirectory(resolve(root, 'plugins', entry.name, 'i18n')))
    .map(entry => `plugins/${entry.name}/i18n/pt-BR.json`)
    .sort()
}

function flatten(value, prefix = '') {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

/**
 * Reads every catalogue that must be read and reports what it found. `scanned` is the evidence the
 * gate prints: a run whose count is zero, or lower than it was, is a run that stopped looking.
 */
export function scanReadinessClaims(root) {
  const failures = []
  const scanned = []
  for (const target of [...REQUIRED_CATALOGUES, ...pluginCatalogues(root)]) {
    const full = resolve(root, target)
    if (!isFile(full)) {
      failures.push(`catálogo obrigatório ausente: ${target} (renomear um catálogo não pode reduzir o escopo do portão em silêncio)`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      failures.push(`catálogo ilegível: ${target}`)
      continue
    }
    scanned.push(target)
    for (const [path, value] of flatten(parsed)) {
      if (READY_CLAIM.test(value)) failures.push(`alegação de prontidão proibida em ${target}:${path}`)
      if (personFacing(target) && !operatorKey(target, path)) {
        for (const word of machineWordsIn(value)) {
          failures.push(`palavra de máquina "${word}" no texto que a pessoa lê: ${target}:${path}`)
        }
      }
    }
  }
  if (scanned.length === 0) failures.push('nenhum catálogo foi lido: um portão que inspeciona zero itens é falha, não aprovação')
  return { scanned, failures }
}
