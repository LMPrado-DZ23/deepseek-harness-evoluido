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
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AGENT_TEAM_ROLES, READ_TOOLS, WRITE_TOOLS, NETWORK_TOOLS, ROLE_TOOL_POLICY, roleToolRestriction, visibleTools } from '../plugins/agent-team/src/roles.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * As ferramentas que cada extensão do Harness registra, pelo id da linha do
 * preset. É uma tabela porque o preset diz QUAL extensão monta, e não quais
 * ferramentas ela traz — e adivinhar isso pelo nome seria a mesma classe de
 * erro que `network`.
 */
const TOOLS_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  'tool-fs': ['read', 'read_image', 'write', 'edit'],
  'tool-fs-search': ['glob', 'grep'],
  'tool-bash': ['bash'],
  'tool-pwsh': ['pwsh'],
  'tool-web': ['web_search', 'web_fetch'],
  'tool-skill': ['skill'],
}

/** As ferramentas que ESCREVEM, olhando qualquer roster. */
const WRITERS = new Set<string>([...WRITE_TOOLS, 'bash', 'pwsh'])

/**
 * O roster que o preset do coordenador monta, lido do YAML de verdade.
 * @param source - o conteúdo do preset.
 * @returns os nomes de ferramenta, e as linhas cuja extensão este portão não conhece.
 */
export function rosterOf(source: string): { readonly tools: readonly string[]; readonly unknown: readonly string[] } {
  const ids = [...source.matchAll(/^- id: ([a-z0-9-]+)$/gmu)].map(match => match[1]!)
  const tools: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (id === 'persona') continue
    if (!Object.hasOwn(TOOLS_BY_EXTENSION, id)) { unknown.push(id); continue }
    tools.push(...TOOLS_BY_EXTENSION[id]!)
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
  for (const role of AGENT_TEAM_ROLES) {
    const policy = ROLE_TOOL_POLICY[role]
    for (const approved of [false, true]) {
      const seen = visibleTools(restrictionFor(role, approved), roster)
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
const { tools, unknown } = rosterOf(preset)

if (process.argv.includes('--self-test')) {
  // Acrescentar `bash` ao ROSTER é seguro por desenho, e o portão tem de
  // dizer isso: com lista de permissão, a ferramenta nova não chega a papel
  // nenhum até alguém decidir que chega. Um portão que reprovasse aqui estaria
  // reclamando do comportamento correto.
  if (findings([...tools, 'bash'], []).length > 0) throw new Error('self-test: o portão reprovou um roster que cresceu, que é o caso seguro')
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
  if (findings(tools, unknown).length > 0) throw new Error('self-test: o roster real já reprova')
  process.stdout.write(`TEAM_ROLE_TOOLS_SELF_TEST=PASS checks=5\n`)
}

const problems = findings(tools, unknown)
if (problems.length > 0) {
  process.stdout.write(`TEAM_ROLE_TOOLS=FAIL\n${problems.map(line => `- ${line}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`TEAM_ROLE_TOOLS=PASS papeis=${AGENT_TEAM_ROLES.length} roster=${tools.join(',')} leitura=${READ_TOOLS.join(',')}\n`)
