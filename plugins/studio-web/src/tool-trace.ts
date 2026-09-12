/**
 * A CADEIA: equipe → etapa → execução → ferramenta.
 *
 * O `T-06` deixou o elo que faltava — `child_session_id` na execução — e parou
 * ali: nada lia a trilha de política para dizer, de uma etapa, QUE FERRAMENTAS
 * ela chamou e o que a política decidiu em cada chamada. Correlação que ninguém
 * consulta é correlação que ninguém confere.
 *
 * Esta é a leitura que faltava. Ela é um JUNTAR, e nada mais: a trilha de
 * política guarda `session_id`, a execução guarda `child_session_id`, e a etapa
 * guarda `run_id`. O caminho é esse, e ele tem DOIS pontos onde pode faltar —
 * e é sobre nomear esses dois pontos que este módulo existe.
 *
 * A regra que atravessa o arquivo inteiro: AUSÊNCIA DE ELO NÃO É AUSÊNCIA DE
 * CHAMADA. Uma etapa cuja execução não registrou a sessão filha não fez zero
 * chamadas — ela fez chamadas que NINGUÉM CONSEGUE ATRIBUIR. Desenhar isso como
 * "nenhuma ferramenta usada" é a mentira mais cara que esta tela poderia
 * contar, porque ela descreve como limpo o caso em que a vigilância falhou.
 */

/** O recorte da trilha de política que esta leitura usa. */
export interface PolicyAuditShape {
  readonly audit_id: string
  readonly session_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly created_at: string
  readonly tool_name: string
  readonly call_id: string
  readonly effective_tier: string
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason: string
  readonly rule_source: string
  /**
   * Os opcionais aceitam `undefined` EXPLÍCITO, e não só a ausência da chave.
   *
   * Sob `exactOptionalPropertyTypes`, `readonly x?: string` recusa um valor
   * `undefined` — e o registro da trilha declara exatamente isso. Estreitar
   * aqui obrigaria quem monta a rota a limpar campo por campo antes de passar,
   * que é trabalho inventado por uma escolha de tipo deste arquivo.
   */
  readonly user_id?: string | undefined
  readonly seq?: number | undefined
  readonly entry_sha256?: string | undefined
}

/** O recorte da execução de onde sai o elo com a sessão da ferramenta. */
export interface TraceRunShape {
  readonly run_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly child_session_id?: string | null | undefined
}

/** A etapa, no mínimo que a cadeia precisa. */
export interface TraceTaskShape {
  readonly task_id: string
  readonly title: string
  readonly role: string
  readonly status: string
  readonly run_id: string | null
}

/** O escopo de quem pergunta. Nenhuma linha de fora dele entra na resposta. */
export interface TraceScope {
  readonly orgId: string
  readonly tenantId: string
}

/**
 * Uma chamada de ferramenta, como a tela pode mostrá-la.
 *
 * `sealed` diz se a entrada participa da corrente de selos. Uma entrada antiga,
 * gravada antes de a corrente existir, é reportada como NÃO SELADA — que é a
 * verdade sobre ela. Omitir a distinção faria uma linha inauditável parecer
 * auditada.
 */
export interface ToolCallView {
  readonly call_id: string
  readonly tool_name: string
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly effective_tier: string
  readonly reason: string
  readonly at: string
  readonly sealed: boolean
}

/**
 * Por que uma etapa não tem chamadas listadas — ou tem.
 *
 * Os três casos são DIFERENTES e não podem colapsar num só:
 *
 * - `NOT_EXECUTED`: a etapa não rodou. Não há o que atribuir, e está certo.
 * - `UNLINKED`: a etapa rodou, mas a execução não registrou a sessão filha.
 *   As chamadas dela existem na trilha e não dá para saber quais são. Este é o
 *   caso que precisa GRITAR.
 * - `LINKED`: o elo existe, e a lista é a lista. Ela pode estar vazia, e aí
 *   vazia significa mesmo "não chamou ferramenta nenhuma".
 */
export type TaskTraceView =
  | { readonly link: 'NOT_EXECUTED'; readonly calls: readonly [] }
  | { readonly link: 'UNLINKED'; readonly run_id: string; readonly calls: readonly [] }
  | { readonly link: 'LINKED'; readonly run_id: string; readonly session_id: string; readonly calls: readonly ToolCallView[] }

export interface TaskTraceRow {
  readonly task_id: string
  readonly title: string
  readonly role: string
  readonly status: string
  readonly trace: TaskTraceView
}

export interface TeamTraceView {
  readonly team_id: string
  readonly tasks: readonly TaskTraceRow[]
  /**
   * Quantas etapas rodaram sem deixar o elo.
   *
   * Sai do lado de fora, e não só dentro de cada etapa, porque é o número que
   * diz se esta tela pode ser lida como um relato completo. Uma pessoa que
   * percorre dez etapas não soma isso de cabeça.
   */
  readonly unlinked_count: number
}

/**
 * As chamadas de uma sessão, dentro do escopo, da mais antiga para a mais nova.
 *
 * A ordem é NOSSA e não da tabela: a trilha é um mapa, e ler fora de ordem
 * contaria a história ao contrário — uma recusa apareceria antes do pedido que
 * a provocou.
 * @param audit - a trilha inteira.
 * @param scope - a organização e o inquilino de quem pergunta.
 * @param sessionId - a sessão da execução.
 * @returns as chamadas.
 */
export function callsForSession(
  audit: readonly PolicyAuditShape[], scope: TraceScope, sessionId: string,
): readonly ToolCallView[] {
  return audit
    .filter(entry => entry.session_id === sessionId
      && entry.org_id === scope.orgId && entry.tenant_id === scope.tenantId)
    .slice()
    .sort(byOrder)
    .map(entry => ({
      call_id: entry.call_id,
      tool_name: entry.tool_name,
      decision: entry.decision,
      effective_tier: entry.effective_tier,
      reason: entry.reason,
      at: entry.created_at,
      sealed: entry.entry_sha256 !== undefined,
    }))
}

/**
 * Ordena pela posição da corrente, e pela data quando não há posição.
 *
 * `seq` é a ordem REAL: duas entradas podem ter o mesmo carimbo de tempo, e aí
 * a data empata e a corrente não. Entrada antiga, sem `seq`, cai para a data —
 * que é o melhor que existe sobre ela.
 * @param left - uma entrada.
 * @param right - a outra.
 * @returns a comparação.
 */
function byOrder(left: PolicyAuditShape, right: PolicyAuditShape): number {
  if (left.seq !== undefined && right.seq !== undefined) return left.seq - right.seq
  const data = left.created_at.localeCompare(right.created_at)
  if (data !== 0) return data
  // Desempate final ESTÁVEL: sem ele, duas entradas com a mesma data trocam de
  // lugar entre leituras, e a tela pisca sem que nada tenha mudado.
  return left.audit_id.localeCompare(right.audit_id)
}

/**
 * A cadeia de uma equipe.
 * @param teamId - a equipe.
 * @param tasks - as etapas dela.
 * @param runs - as execuções conhecidas.
 * @param audit - a trilha de política.
 * @param scope - a organização e o inquilino de quem pergunta.
 * @returns a cadeia.
 */
export function teamTrace(
  teamId: string,
  tasks: readonly TraceTaskShape[],
  runs: readonly TraceRunShape[],
  audit: readonly PolicyAuditShape[],
  scope: TraceScope,
): TeamTraceView {
  const byRun = new Map<string, TraceRunShape>()
  for (const run of runs) {
    // A execução de OUTRO escopo não entra no índice. Sem isto, uma etapa
    // conseguiria alcançar a sessão de outro inquilino pelo identificador da
    // execução — e a trilha dele apareceria nesta tela.
    if (run.org_id !== scope.orgId || run.tenant_id !== scope.tenantId) continue
    byRun.set(run.run_id, run)
  }

  let unlinked = 0
  const rows = tasks.map((task): TaskTraceRow => {
    const base = { task_id: task.task_id, title: task.title, role: task.role, status: task.status }
    if (task.run_id === null) return { ...base, trace: { link: 'NOT_EXECUTED', calls: [] } }
    const run = byRun.get(task.run_id)
    const sessionId = run?.child_session_id ?? undefined
    if (sessionId === undefined || sessionId === '') {
      unlinked += 1
      return { ...base, trace: { link: 'UNLINKED', run_id: task.run_id, calls: [] } }
    }
    return {
      ...base,
      trace: { link: 'LINKED', run_id: task.run_id, session_id: sessionId, calls: callsForSession(audit, scope, sessionId) },
    }
  })
  return { team_id: teamId, tasks: rows, unlinked_count: unlinked }
}
