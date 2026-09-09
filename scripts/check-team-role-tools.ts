/**
 * Portão dos papéis da equipe (A-06).
 *
 * A pergunta que ele faz é uma só, e é contra o PERFIL REAL: dado o roster que
 * o preset do coordenador monta, o que cada papel enxerga de verdade?
 *
 * O motivo de este portão existir é um achado. O código mandava
 * `toolFilter: { deny: ['network'] }` acreditando cortar a rede do filho, e NÃO
 * EXISTE ferramenta chamada `network` no Harness: o filtro é por nome de
 * ferramenta global, então aquilo removia exatamente nada. Uma proteção assim
 * não falha — ela simplesmente nunca existiu, e ninguém teria descoberto lendo
 * o código, porque lendo o código ela parece existir.
 *
 * Por isso a conferência aqui não pergunta "os nomes estão escritos certo?",
 * mas "o que sobra para cada papel quando cruzamos a política com as
 * ferramentas que o perfil realmente monta?".
 *
 * Uso: node --experimental-strip-types scripts/check-team-role-tools.ts [--self-test]
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AGENT_TEAM_ROLES, COORDINATOR_ROSTER, READ_TOOLS, WRITE_TOOLS, NETWORK_TOOLS, ROLE_TOOL_POLICY, roleToolRestriction, visibleTools } from '../plugins/agent-team/src/roles.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Onde vive cada extensão do preset dentro do Harness fixado.
 *
 * Só o CAMINHO é escrito aqui; os NOMES das ferramentas são lidos do código do
 * Harness. A versão anterior escrevia os nomes à mão — `tool-fs → read,
 * read_image, write, edit` — e isso é exatamente o erro que este portão nasceu
 * para impedir: uma tabela adivinhada. Se `tool-fs` passar a registrar
 * `multi_edit`, o portão precisa VER, e não continuar afirmando um roster que
 * não existe mais.
 */
const EXTENSION_SOURCES: Readonly<Record<string, string>> = {
  'tool-fs': 'third_party/deepseek-harness/packages/fs/tool-fs/src',
  'tool-fs-search': 'third_party/deepseek-harness/packages/fs/tool-fs-search/src',
  'tool-bash': 'third_party/deepseek-harness/packages/shell/tool-bash/src',
  'tool-pwsh': 'third_party/deepseek-harness/packages/shell/tool-pwsh/src',
  'tool-web': 'third_party/deepseek-harness/packages/web/tool-web/src',
  'tool-skill': 'third_party/deepseek-harness/packages/skill/tool-skill/src',
}

/**
 * Os nomes que uma extensão registra, lidos do código do Harness fixado.
 * @param directory - a pasta `src` da extensão.
 * @returns os nomes de ferramenta, em ordem.
 */
export async function registeredTools(directory: string): Promise<readonly string[]> {
  const names = new Set<string>()
  for (const file of await sources(directory)) {
    const text = await readFile(file, 'utf8')
    // Nem toda extensão registra em linha: `tool-fs-search` monta o objeto antes
    // e chama `ctx.tools.register(tool)`. Por isso o que se lê é a DEFINIÇÃO —
    // `defineTool({ ... name: '<nome>' ... })` — em arquivo que registra.
    if (!text.includes('tools.register(')) continue
    for (const block of text.matchAll(/defineTool\(\{/gu)) {
      const after = text.slice(block.index ?? 0, (block.index ?? 0) + 600)
      const named = /\bname:\s*'([a-z0-9_]+)'/u.exec(after)
      // `name: 'tool:glob'` é o id do componente, não o nome da ferramenta que o
      // modelo chama; o filtro de identificador simples já o deixa de fora.
      if (named !== null) names.add(named[1]!)
    }
  }
  return [...names].sort()
}

async function sources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...await sources(path))
    else if (/\.ts$/u.test(entry.name) && !/\.spec\.ts$/u.test(entry.name)) found.push(path)
  }
  return found
}

/** As ferramentas que ESCREVEM, olhando qualquer roster. */
const WRITERS = new Set<string>([...WRITE_TOOLS, 'bash', 'pwsh'])

/**
 * O roster que o preset do coordenador monta, lido do YAML de verdade.
 * @param source - o conteúdo do preset.
 * @returns os nomes de ferramenta, e as linhas cuja extensão este portão não conhece.
 */
export function rosterOf(
  source: string,
  toolsByExtension: Readonly<Record<string, readonly string[]>>,
): { readonly tools: readonly string[]; readonly unknown: readonly string[] } {
  const ids = [...source.matchAll(/^- id: ([a-z0-9-]+)$/gmu)].map(match => match[1]!)
  const tools: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (id === 'persona') continue
    if (!Object.hasOwn(toolsByExtension, id)) { unknown.push(id); continue }
    tools.push(...toolsByExtension[id]!)
  }
  return { tools: [...new Set(tools)].sort(), unknown }
}

/**
 * Os achados: papel de leitura enxergando escrita, papel enxergando rede sem
 * aprovação, ou uma linha do preset que este portão não sabe classificar.
 * @param roster - o que o preset monta.
 * @param unknown - as linhas não classificadas.
 * @returns as frases de reprovação, vazias quando está tudo certo.
 */
export function findings(
  roster: readonly string[],
  unknown: readonly string[],
  restrictionFor: typeof roleToolRestriction = roleToolRestriction,
): readonly string[] {
  const problems: string[] = []
  // Uma linha desconhecida NÃO passa: ela pode estar montando um shell, e o
  // portão calaria justamente sobre a ferramenta mais perigosa.
  for (const id of unknown) problems.push(`linha do preset que este portão não sabe classificar: ${id}`)
  // A constante do produto tem de bater com o preset de VERDADE. Montar uma
  // extensão nova sem atualizar `COORDINATOR_ROSTER` reprova aqui, em vez de
  // quebrar em produção quando a permissão nomear o que não existe.
  const declaredRoster = [...COORDINATOR_ROSTER].sort().join(',')
  if (declaredRoster !== [...roster].sort().join(',')) {
    problems.push(`COORDINATOR_ROSTER (${declaredRoster}) não bate com o preset (${[...roster].sort().join(',')})`)
  }
  for (const role of AGENT_TEAM_ROLES) {
    const policy = ROLE_TOOL_POLICY[role]
    for (const approved of [false, true]) {
      const restriction = restrictionFor(role, approved)
      // O MODO DE FALHA REAL: `tools.restrict()` do Harness LANÇA com nome
      // desconhecido. Uma permissão que nomeia ferramenta fora do roster
      // derruba toda delegação no nascimento — e a pergunta "o que sobra?" é
      // cega para isso, porque o excedente simplesmente não aparece na
      // interseção. Esta é a pergunta "o que não existe?".
      for (const name of restriction.allow) {
        if (!roster.includes(name)) problems.push(`papel ${role} permite ferramenta FORA do roster: ${name} (o Harness lança)`)
      }
      const seen = visibleTools(restriction, roster)
      if (!policy.writes) {
        for (const tool of seen) {
          if (WRITERS.has(tool)) problems.push(`papel de leitura ${role} enxerga ferramenta de escrita ${tool}`)
        }
      }
      const network = seen.filter(tool => (NETWORK_TOOLS as readonly string[]).includes(tool))
      if (network.length > 0 && (policy.network === 'never' || !approved)) {
        problems.push(`papel ${role} enxerga rede (${network.join(',')}) sem poder: approved=${String(approved)} politica=${policy.network}`)
      }
    }
    // Um papel que não enxerga NADA não é um papel restrito, é um papel quebrado.
    if (visibleTools(restrictionFor(role, false), roster).length === 0) {
      problems.push(`papel ${role} não enxerga nenhuma ferramenta do roster`)
    }
  }
  return problems
}

const preset = await readFile(resolve(root, 'dsh-home/.agent-presets/dz23-coordinator-in-process/agent.cordis.yml'), 'utf8')

// A tabela extensão→ferramentas, DERIVADA do Harness fixado. Uma extensão do
// preset cuja pasta não existe (renomeada, movida) fica sem ferramenta nenhuma
// e cai em `unknown`, que já reprova — em vez de sumir em silêncio.
const derived: Record<string, readonly string[]> = {}
const unreadable: string[] = []
for (const [id, directory] of Object.entries(EXTENSION_SOURCES)) {
  const names = await registeredTools(resolve(root, directory))
  // Zero ferramenta numa extensão que existe significa que o LEITOR quebrou (a
  // forma do registro mudou, a pasta mudou de lugar). Um leitor cego devolve um
  // roster menor do que o real, e um roster menor faz o portão aprovar por não
  // enxergar — que é o modo de falha que ele existe para impedir.
  if (names.length === 0) unreadable.push(`${id} (${directory})`)
  else derived[id] = names
}
if (unreadable.length > 0) {
  process.stdout.write(`TEAM_ROLE_TOOLS=FAIL\n- extensão do Harness sem ferramenta legível: ${unreadable.join(', ')}\n`)
  process.exit(1)
}
const { tools, unknown } = rosterOf(preset, derived)

if (process.argv.includes('--self-test')) {
  // Acrescentar `bash` ao ROSTER tem de REPROVAR, e por um motivo preciso: a
  // constante `COORDINATOR_ROSTER` do produto deixou de bater com o preset.
  // Montar uma extensão nova e não atualizar a constante é o caminho para a
  // permissão nomear o que não existe — e o portão para isso ANTES de virar
  // erro em produção. O que continua seguro por desenho é a ferramenta nova
  // não chegar a papel nenhum: numa lista de permissão, quem não é nomeado já
  // está negado.
  const grown = findings([...tools, 'bash'], [])
  if (!grown.some(line => line.includes('COORDINATOR_ROSTER'))) {
    throw new Error(`self-test: o portão não acusou a constante desatualizada: ${grown.join('; ')}`)
  }
  if (grown.some(line => line.includes('ferramenta de escrita'))) {
    throw new Error('self-test: a ferramenta nova chegou a um papel de leitura')
  }
  // O que ele TEM de reprovar é a política afrouxada: um papel de leitura que
  // passe a enxergar tudo o que o roster oferece.
  const loosened = findings([...tools, 'bash'], [], () => ({ allow: [...tools, 'bash'] }))
  if (loosened.length === 0) throw new Error('self-test: o portão não viu um papel de leitura enxergando escrita')
  // E a rede liberada para quem não podia.
  const networked = findings([...tools, ...NETWORK_TOOLS], [], () => ({ allow: [...READ_TOOLS, ...NETWORK_TOOLS] }))
  if (networked.length === 0) throw new Error('self-test: o portão não viu rede liberada sem poder')
  // Uma linha do preset que ele não sabe classificar não passa: ela pode estar
  // montando um shell, e calar sobre a ferramenta mais perigosa seria o pior caso.
  if (findings(tools, ['tool-misterio']).length === 0) throw new Error('self-test: o portão não viu uma linha desconhecida')
  // E tem de PASSAR no roster real, senão o self-test estaria escondendo uma falha.
  // Isto sai como REPROVAÇÃO legível, e não como exceção: quando o roster real
  // muda — que é o caso que este portão existe para pegar —, a pilha de erro
  // aparecia ANTES de a verificação real dizer qual ferramenta apareceu, e
  // quem lia o log via um estouro em vez de um achado.
  const real = findings(tools, unknown)
  if (real.length > 0) {
    process.stdout.write(`TEAM_ROLE_TOOLS_SELF_TEST=FAIL o roster real já reprova:\n${real.map(line => `- ${line}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`TEAM_ROLE_TOOLS_SELF_TEST=PASS checks=5\n`)
}

const problems = findings(tools, unknown)
if (problems.length > 0) {
  process.stdout.write(`TEAM_ROLE_TOOLS=FAIL\n${problems.map(line => `- ${line}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`TEAM_ROLE_TOOLS=PASS papeis=${AGENT_TEAM_ROLES.length} roster=${tools.join(',')} leitura=${READ_TOOLS.join(',')} extensoes_lidas=${Object.keys(derived).length}/${Object.keys(EXTENSION_SOURCES).length}\n`)
