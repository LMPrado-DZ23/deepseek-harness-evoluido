/**
 * A-06 — os papéis da equipe, e o que cada um PODE TOCAR.
 *
 * Até aqui o papel era só um prefixo de prompt: quatro nomes que mudavam a
 * frase e mais nada. Um revisor com as mesmas ferramentas do construtor não é
 * um revisor — é um construtor com outro texto na frente.
 *
 * ACHADO NO CAMINHO, e é o motivo pelo qual este arquivo existe do jeito que
 * existe: a equipe mandava `toolFilter: { deny: ['network'] }` acreditando
 * estar cortando a rede do filho. NÃO EXISTE ferramenta chamada `network` no
 * Harness. O filtro é por NOME de ferramenta global, então aquilo removia
 * exatamente nada — uma proteção que só existia na leitura de quem passasse
 * pelo código. As ferramentas de rede de verdade se chamam `web_search` e
 * `web_fetch`, e é por esses nomes que elas são recusadas agora.
 *
 * O roster que o filho `spawn-in-process` herda hoje vem do preset
 * `dz23-coordinator-in-process`, que monta só `tool-fs`: `read`, `read_image`,
 * `write` e `edit`. As recusas de rede são, portanto, defesa em profundidade —
 * elas passam a valer sozinhas no dia em que alguém montar `tool-web` ali, sem
 * precisar lembrar de voltar aqui.
 */

/**
 * Os oito papéis.
 *
 * Sete são os do requisito — analista, arquiteto, designer, construtor, QA,
 * segurança e revisor. O oitavo, `synthesizer`, já existia e continua: apagar
 * um papel em uso quebraria toda equipe gravada que o usa, e um papel a mais
 * não é um papel a menos.
 */
export const AGENT_TEAM_ROLES = [
  'analyst', 'architect', 'designer', 'implementer', 'tester', 'security', 'reviewer', 'synthesizer',
] as const
export type AgentTeamRoleName = typeof AGENT_TEAM_ROLES[number]

/**
 * As ferramentas que o preset `dz23-coordinator-in-process` REALMENTE monta.
 *
 * Existe porque `tools.restrict()` do Harness LANÇA quando a lista nomeia uma
 * ferramenta que não está montada — não ignora, lança. Uma permissão que
 * nomeia `str_replace_editor` ou `web_search` num preset que só tem `tool-fs`
 * derruba TODA delegação no nascimento, e o defeito aparece como erro interno
 * opaco para quem pediu.
 *
 * O portão `gate:team-role-tools` confere esta constante contra o preset de
 * verdade: montar uma extensão nova sem atualizar esta linha reprova, em vez de
 * quebrar em produção.
 */
export const COORDINATOR_ROSTER = ['read', 'read_image', 'write', 'edit'] as const

/** As ferramentas do Harness que só LEEM a cópia isolada. */
export const READ_TOOLS = ['read', 'read_image'] as const

/** As ferramentas do Harness que ESCREVEM no disco da cópia isolada. */
export const WRITE_TOOLS = ['write', 'edit', 'str_replace_editor'] as const

/** As ferramentas do Harness que falam com a rede. */
export const NETWORK_TOOLS = ['web_search', 'web_fetch'] as const

/**
 * O que cada papel pode, como TABELA.
 *
 * Tabela, e não expressão: um papel acrescentado ao enum sem linha aqui é um
 * buraco que alguém tem de abrir de propósito, e há teste que reprova a
 * ausência. Foi assim que o piso de política do manifesto (D16) parou de
 * esquecer `filesystem.workspace`.
 *
 * - `writes`: se o papel pode escrever na cópia. Um revisor, um analista, um
 *   arquiteto e a segurança NÃO escrevem: o produto deles é achado e decisão,
 *   não arquivo. Quem escreve é construtor e designer;
 * - `network`: `'never'` quer dizer recusada MESMO quando a equipe inteira foi
 *   aprovada para rede externa. Vale só para `security`, e é de propósito: a
 *   revisão de segurança é o último papel que deveria conseguir telefonar para
 *   fora com o código na mão.
 */
export const ROLE_TOOL_POLICY: Readonly<Record<AgentTeamRoleName, { readonly writes: boolean; readonly network: 'never' | 'when-approved' }>> = {
  analyst: { writes: false, network: 'when-approved' },
  architect: { writes: false, network: 'when-approved' },
  designer: { writes: true, network: 'when-approved' },
  implementer: { writes: true, network: 'when-approved' },
  tester: { writes: false, network: 'when-approved' },
  security: { writes: false, network: 'never' },
  reviewer: { writes: false, network: 'when-approved' },
  synthesizer: { writes: false, network: 'when-approved' },
}

/** A restrição de ferramentas do Harness. `allow` é uma lista FECHADA: o resto some. */
export interface RoleToolRestriction {
  readonly allow: readonly string[]
}

/**
 * As ferramentas que este papel enxerga nesta equipe.
 *
 * É uma lista de PERMISSÃO, e não de recusa, e isso é a decisão central deste
 * arquivo. Uma lista de recusa erra fechado só para o que alguém lembrou de
 * escrever nela: no dia em que `tool-bash` for montado no preset do
 * coordenador, um papel de leitura passa a poder escrever pelo shell e nenhuma
 * linha aqui teria mudado. Com permissão, a ferramenta nova simplesmente não
 * chega a papel nenhum até alguém decidir que ela chega.
 *
 * Custo aceito e declarado: uma ferramenta nova que os papéis PRECISEM não
 * funciona até entrar aqui. Isso é uma tarefa esquecida, e não um buraco de
 * segurança — que é o lado certo para errar.
 * @param role - o papel da tarefa.
 * @param externalNetworkApproved - se a equipe foi aprovada para rede externa.
 * @returns a lista de permissão, em ordem estável para o teste poder compará-la.
 */
/**
 * A restrição vale para ferramenta GLOBAL, e é isso que o Studio usa.
 *
 * O Harness documenta, em `core/tools`: "Restrictions intersect and do not
 * affect scoped registrations". Ou seja, ferramenta registrada por ESCOPO não
 * é alcançada por esta lista de permissão. O Studio não registra nada por
 * escopo — o portão `check-team-role-tools` lê as extensões do preset e todas
 * registram globalmente —, então a suposição vale hoje. Ela está escrita aqui
 * porque uma suposição não escrita é a que ninguém revisa quando muda.
 */
export function roleToolRestriction(
  role: AgentTeamRoleName,
  externalNetworkApproved: boolean,
  roster: readonly string[] = COORDINATOR_ROSTER,
): RoleToolRestriction {
  const policy = ROLE_TOOL_POLICY[role]
  const wanted: string[] = [...READ_TOOLS]
  if (policy.writes) wanted.push(...WRITE_TOOLS)
  // A aprovação da equipe LIBERA a rede — menos para quem a tem como `never`,
  // que é onde a aprovação da equipe não alcança.
  if (policy.network === 'when-approved' && externalNetworkApproved) wanted.push(...NETWORK_TOOLS)
  // E a permissão é INTERSECTADA com o que está montado. Sem isto ela nomearia
  // ferramenta ausente e o `tools.restrict()` do Harness LANÇARIA, derrubando
  // a delegação inteira — trocar uma proteção inerte por uma proteção fatal
  // seria um defeito pior do que o que se estava consertando.
  //
  // Nomear a mais também não seria "defesa em profundidade": numa lista de
  // PERMISSÃO, a ferramenta que não é nomeada já está negada. `web_search` fora
  // desta lista não é uma recusa que falta — é a recusa acontecendo.
  return { allow: wanted.filter(name => roster.includes(name)).sort() }
}

/**
 * As ferramentas do roster REAL que este papel enxerga.
 *
 * É o que o portão pergunta contra o roster montado no perfil: um papel de
 * leitura não pode enxergar nada que escreva, hoje ou depois de o roster
 * crescer.
 * @param restriction - a permissão do papel.
 * @param roster - os nomes que o preset realmente monta.
 * @returns os nomes do roster que sobram para o papel.
 */
export function visibleTools(restriction: RoleToolRestriction, roster: readonly string[]): readonly string[] {
  const allowed = new Set(restriction.allow)
  return roster.filter(name => allowed.has(name))
}
