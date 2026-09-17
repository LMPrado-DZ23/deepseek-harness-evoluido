/**
 * A conversa da tarefa é uma PROJEÇÃO do que já existe — não um segundo diário.
 *
 * O produto guarda o pedido, as perguntas de admissão, o plano, as tentativas e
 * as evidências em domínios próprios, e `GET /projects/:id` já devolve os cinco
 * no mesmo corpo. O que faltava não era armazenamento: era apresentação. A tela
 * antiga lia três desses campos, jogava fora `turns`, `runs` e `evidence`, e
 * desenhava um trilho de cinco caixas ao lado de um relatório.
 *
 * Este arquivo não grava nada e não chama nada. Ele recebe o corpo que o
 * servidor devolve e responde em que ORDEM aquilo aconteceu, como uma
 * conversa. É por isso que ele é uma função pura: a ordem dos lances é a coisa
 * que quebra primeiro quando alguém acrescenta um estado novo, e uma decisão
 * que mora dentro de um JSX não é exercitada por teste nenhum.
 *
 * O que ele NÃO faz, de propósito:
 *
 * - não inventa mensagem que ninguém escreveu. Um estado sem registro vira
 *   ausência, nunca uma frase amigável no lugar do fato;
 * - não resume tentativa reprovada como "tudo certo". O lance do artefato
 *   carrega o estado da tentativa e as evidências que existem, e quem desenha
 *   não tem como dizer mais do que isso.
 */

/** O que o servidor devolve em `GET /projects/:projectId`, no que interessa aqui. */
export interface DetalhesDaTarefa {
  readonly project: {
    readonly project_id: string
    readonly name: string
    readonly state: string
    readonly original_brief: string
    readonly created_at?: string
  }
  readonly turns?: readonly {
    readonly turn_id: string
    readonly question_id: string
    readonly question: string
    readonly answer: string
    readonly recommended: boolean
    readonly created_at: string
  }[]
  readonly plan?: {
    readonly plan_id: string
    readonly revision?: number
    readonly status: string
    readonly slices: readonly { readonly slice_id: string; readonly title: string; readonly description: string; readonly acceptance_criteria: readonly string[] }[]
    readonly edited_by_person?: boolean
    readonly updated_at?: string
  } | null
  readonly runs?: readonly RunDaTarefa[]
  readonly current_run?: RunDaTarefa | null
  readonly evidence?: readonly {
    readonly evidence_id: string
    readonly run_id: string
    readonly kind: string
    readonly relative_path: string
    readonly size_bytes: number
  }[]
  /** A pergunta ainda SEM resposta, quando o servidor devolveu uma. */
  readonly next?: { readonly id: string; readonly text: string } | null
  /**
   * Os pedidos de mudança que a pessoa escreveu depois de um resultado.
   *
   * Eles são mensagens DELA, e é por isso que entram na conversa como tal. Sem
   * este lance, pedir uma alteração desaparecia da tarefa e reaparecia só como
   * um critério dentro do plano seguinte — o que é o oposto de continuar a
   * conversa, e é justamente o que a decisão de produto manda corrigir.
   */
  readonly revisions?: readonly {
    readonly spec_id: string
    readonly request: string
    readonly created_at: string
  }[]
}

/**
 * Um passo do construtor, na MESMA forma em que o servidor o grava.
 *
 * O campo é `step`, e não `name`: a lista da construção já existe
 * (`buildSteps.ts`), já sabe traduzir cada passo e já sabe o que fazer com um
 * passo desconhecido. Repetir aqui uma forma parecida daria duas descrições do
 * mesmo registro, que é o defeito mais caro deste repositório.
 */
export interface PassoDaTarefa {
  readonly step: string
  readonly state: 'RUNNING' | 'PASSED' | 'FAILED'
  readonly started_at: string
  readonly finished_at: string | null
}

export interface RunDaTarefa {
  readonly run_id: string
  readonly attempt: number
  readonly stage: string
  readonly state: string
  readonly started_at: string
  readonly finished_at?: string | null
  readonly steps?: readonly PassoDaTarefa[]
  readonly acceptance_checks?: readonly { readonly id: string; readonly label: string; readonly title?: string; readonly status: string }[]
}

export type Autor = 'pessoa' | 'estudio'

export interface LanceBase {
  readonly id: string
  readonly autor: Autor
  /** O instante do registro de origem. Ordenar por ele é o contrato deste arquivo. */
  readonly quando: string
}

export type Lance =
  | (LanceBase & { readonly tipo: 'pedido'; readonly texto: string })
  | (LanceBase & { readonly tipo: 'pergunta'; readonly texto: string; readonly perguntaId: string; readonly respondida: boolean })
  | (LanceBase & { readonly tipo: 'resposta'; readonly texto: string; readonly recomendada: boolean })
  | (LanceBase & {
    readonly tipo: 'plano'
    readonly planoId: string
    readonly revisao: number
    readonly status: string
    readonly fatias: readonly { readonly slice_id: string; readonly title: string; readonly description: string; readonly acceptance_criteria: readonly string[] }[]
    readonly escritoPelaPessoa: boolean
  })
  | (LanceBase & {
    readonly tipo: 'execucao'
    readonly runId: string
    readonly tentativa: number
    readonly etapa: string
    readonly estado: string
    readonly emCurso: boolean
    readonly passos: readonly PassoDaTarefa[]
  })
  | (LanceBase & {
    readonly tipo: 'artefato'
    readonly runId: string
    readonly estado: string
    readonly tentativa: number
    readonly criterios: readonly { readonly id: string; readonly label: string; readonly title?: string; readonly status: string }[]
    readonly evidencias: readonly { readonly evidence_id: string; readonly kind: string; readonly relative_path: string; readonly size_bytes: number }[]
  })

/** Tentativas que não continuam: depois delas existe um resultado para olhar. */
const ESTADOS_TERMINAIS = new Set(['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED'])

/**
 * Se uma tentativa terminou.
 * @param estado - o estado da tentativa, como o servidor o gravou.
 * @returns `true` quando não há mais o que esperar dela.
 */
export function execucaoTerminou(estado: string): boolean {
  return ESTADOS_TERMINAIS.has(estado)
}

/**
 * A conversa da tarefa, em ordem cronológica.
 *
 * Cada lance sai de um registro que já existia; nenhum é sintetizado. Quando o
 * registro não tem instante próprio — o pedido inicial, antes de o projeto
 * ganhar `created_at` — ele fica no começo, porque é de lá que a tarefa veio.
 *
 * @param detalhes - o corpo devolvido por `GET /projects/:projectId`.
 * @returns os lances, do mais antigo ao mais recente.
 */
export function transcricaoDaTarefa(detalhes: DetalhesDaTarefa): readonly Lance[] {
  const lances: Ancorado[] = []
  const nascimento = detalhes.project.created_at ?? ''
  lances.push({ ancora: 'inicio', lance: {
    tipo: 'pedido', id: `pedido:${detalhes.project.project_id}`, autor: 'pessoa',
    quando: nascimento, texto: detalhes.project.original_brief,
  } })

  for (const turno of detalhes.turns ?? []) {
    lances.push({ ancora: 'instante', lance: {
      tipo: 'pergunta', id: `pergunta:${turno.turn_id}`, autor: 'estudio',
      quando: turno.created_at, texto: turno.question, perguntaId: turno.question_id, respondida: true,
    } })
    // A resposta vazia é ausência de resposta, não uma mensagem em branco: o
    // turno existe porque a pergunta foi feita, e gravar a fala de alguém que
    // não falou é exatamente a mensagem inventada que este arquivo recusa.
    if (turno.answer.trim() !== '') {
      lances.push({ ancora: 'instante', lance: {
        tipo: 'resposta', id: `resposta:${turno.turn_id}`, autor: 'pessoa',
        quando: turno.created_at, texto: turno.answer, recomendada: turno.recommended,
      } })
    }
  }

  const plano = detalhes.plan
  if (plano !== null && plano !== undefined) {
    // A revisão ausente é a primeira: o campo é opcional no domínio porque
    // planos gravados antes dele existirem continuam válidos.
    const revisao = plano.revision ?? 1
    lances.push({ ancora: 'instante', lance: {
      tipo: 'plano', id: `plano:${plano.plan_id}:${revisao}`, autor: 'estudio',
      quando: plano.updated_at ?? '', planoId: plano.plan_id, revisao,
      status: plano.status, fatias: plano.slices, escritoPelaPessoa: plano.edited_by_person === true,
    } })
  }

  const evidencias = detalhes.evidence ?? []
  for (const run of execucoesConhecidas(detalhes)) {
    const terminou = execucaoTerminou(run.state)
    lances.push({ ancora: 'instante', lance: {
      tipo: 'execucao', id: `execucao:${run.run_id}`, autor: 'estudio', quando: run.started_at,
      runId: run.run_id, tentativa: run.attempt, etapa: run.stage, estado: run.state,
      emCurso: !terminou, passos: run.steps ?? [],
    } })
    if (!terminou) continue
    lances.push({ ancora: 'instante', lance: {
      tipo: 'artefato', id: `artefato:${run.run_id}`, autor: 'estudio',
      // O artefato pertence ao FIM da tentativa. Datá-lo pelo início a
      // colocaria antes de qualquer coisa que aconteceu durante ela.
      quando: run.finished_at ?? run.started_at,
      runId: run.run_id, estado: run.state, tentativa: run.attempt,
      criterios: run.acceptance_checks ?? [],
      evidencias: evidencias.filter(item => item.run_id === run.run_id),
    } })
  }

  for (const revisao of detalhes.revisions ?? []) {
    lances.push({ ancora: 'instante', lance: {
      tipo: 'pedido', id: `revisao:${revisao.spec_id}`, autor: 'pessoa',
      quando: revisao.created_at, texto: revisao.request,
    } })
  }

  const pendente = detalhes.next
  if (pendente !== null && pendente !== undefined) {
    lances.push({ ancora: 'fim', lance: {
      tipo: 'pergunta', id: `pergunta-aberta:${pendente.id}`, autor: 'estudio',
      // Sem instante: ela ainda não virou registro. O `''` a joga para o fim
      // pela regra de desempate abaixo, que é onde uma pergunta aberta fica.
      quando: '', texto: pendente.text, perguntaId: pendente.id, respondida: false,
    } })
  }

  return ordenados(lances)
}

/**
 * As tentativas que o corpo traz, sem repetir a corrente.
 *
 * `current_run` é uma das linhas de `runs` na maior parte das respostas, mas
 * nem sempre: quando a pessoa desfez para um ponto seguro, a corrente é uma
 * tentativa ANTIGA, e quando o histórico ainda não foi lido, `runs` pode vir
 * vazio com a corrente presente. Somar as duas listas sem casar por
 * identificador duplicava a tentativa na conversa.
 * @param detalhes - o corpo devolvido pelo servidor.
 * @returns as tentativas, sem duplicata, da mais antiga para a mais recente.
 */
function execucoesConhecidas(detalhes: DetalhesDaTarefa): readonly RunDaTarefa[] {
  const porId = new Map<string, RunDaTarefa>()
  for (const run of detalhes.runs ?? []) porId.set(run.run_id, run)
  const corrente = detalhes.current_run
  // A corrente vence a linha do histórico: ela chega com os critérios de
  // aceitação e os códigos que o histórico não carrega.
  if (corrente !== null && corrente !== undefined) porId.set(corrente.run_id, corrente)
  return [...porId.values()].sort((esquerda, direita) =>
    esquerda.started_at.localeCompare(direita.started_at) || esquerda.attempt - direita.attempt)
}

/**
 * Onde um lance se ancora quando o instante não basta.
 *
 * Três casos, e não um só: o pedido inicial abre a conversa mesmo quando chega
 * sem `created_at` — a resposta da criação devolve o projeto parcial —, a
 * pergunta ainda aberta fecha a conversa porque ainda não virou registro, e
 * todo o resto se ordena pelo instante que o servidor gravou. Sem esta
 * distinção, "sem instante" significava as duas coisas ao mesmo tempo e o
 * pedido caía no fim da conversa que ele começou.
 */
type Ancora = 'inicio' | 'instante' | 'fim'
interface Ancorado { readonly ancora: Ancora; readonly lance: Lance }

const PESO: Readonly<Record<Ancora, number>> = { inicio: -1, instante: 0, fim: 1 }

/**
 * Ordena por âncora, depois por instante, com desempate ESTÁVEL pela posição.
 *
 * O desempate por posição importa: perguntas gravadas no mesmo segundo chegam
 * com o mesmo `created_at`, e sem ele pergunta e resposta se embaralham.
 * @param lances - os lances ancorados, na ordem em que foram montados.
 * @returns os lances, ordenados.
 */
function ordenados(lances: readonly Ancorado[]): readonly Lance[] {
  return lances
    .map((item, posicao) => ({ item, posicao }))
    .sort((esquerda, direita) => {
      const porAncora = PESO[esquerda.item.ancora] - PESO[direita.item.ancora]
      if (porAncora !== 0) return porAncora
      const porInstante = esquerda.item.lance.quando.localeCompare(direita.item.lance.quando)
      return porInstante !== 0 ? porInstante : esquerda.posicao - direita.posicao
    })
    .map(entrada => entrada.item.lance)
}
