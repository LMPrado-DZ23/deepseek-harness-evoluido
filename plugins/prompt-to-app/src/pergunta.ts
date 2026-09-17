import { t } from './i18n.js'
import type { ProjectState, StudioIntakeTurn, StudioRun } from './model.js'

/**
 * A PERGUNTA da pessoa sobre a tarefa — que não é um pedido de alteração.
 *
 * O defeito que este módulo fecha foi apontado pelo dono do produto e
 * confirmado lendo `destinoDoEnvio`: depois de um resultado, TODO envio caía em
 * `ajustar`, e `ajustar` grava o texto como critério de aceite permanente na
 * especificação. Quem escrevesse "por que falhou?" ganhava um critério de
 * aceite chamado "por que falhou?", que a tentativa seguinte tentaria
 * satisfazer — e pagava uma tentativa por isso.
 *
 * Perguntar e pedir alteração são gestos DIFERENTES, e a diferença não é
 * adivinhada: a tela pede a escolha. Classificar a frase por palavra-chave
 * seria a mesma automação que produziu o defeito, só que mais difícil de ver.
 *
 * ## Onde a pergunta é guardada
 *
 * No MESMO lugar da conversa que já existe — `studio_intake_turns` —, com um
 * `question_id` próprio. Não há armazenamento novo, nem journal paralelo, nem
 * segunda conversa: a decisão visual do dono proíbe os três, e o histórico
 * precisa sair em ordem única de um lugar só.
 *
 * A VERSÃO DO DOMÍNIO NÃO SOBE, e isso é deliberado: acrescentar um valor ao
 * conjunto de `question_id` não invalida nenhum registro já gravado — os
 * antigos continuam válidos. Subir a versão faria `open()` recusar toda
 * instalação que já rodou, sem passo de migração nenhum neste seam.
 */

/** O `question_id` de uma pergunta feita PELA PESSOA. */
export const PERGUNTA_QUESTION_ID = 'pergunta-da-pessoa'

/** Os `question_id` que pertencem ao questionário de entrada. */
export const IDS_DO_INTAKE: readonly StudioIntakeTurn['question_id'][] = ['audience', 'goal', 'content', 'sensitive-confirmation']

/**
 * As respostas do QUESTIONÁRIO, e só elas.
 *
 * Esta decisão morava dentro da montagem do corpo da rota, como um
 * `question_id !== 'sensitive-confirmation'` — uma lista NEGADA. A conversa
 * passou a guardar também as perguntas da pessoa, e uma lista negada deixa
 * entrar tudo o que ninguém lembrou de excluir: a frase da pessoa ia parar em
 * `IntakeConversation.answers`, que é lido para escolher a próxima pergunta,
 * para detectar dado sensível E para montar a especificação do aplicativo.
 *
 * É uma função exportada porque a lição desta casa já foi paga mais de dez
 * vezes: decisão que mora num `return` de rota não é exercitada por teste
 * nenhum. A sabotagem que trocava a lista permitida pela negada SOBREVIVEU
 * enquanto ela estava lá dentro.
 *
 * A confirmação de dado sensível fica FORA: ela não é uma resposta do
 * questionário, é um sim ou não sobre ele, e quem a lê a lê pelo próprio
 * `question_id`.
 * @param turns - a conversa inteira da tarefa, na ordem em que foi gravada.
 * @returns as respostas por `question_id`, a última valendo.
 */
export function respostasDoQuestionario(turns: readonly StudioIntakeTurn[]): Readonly<Record<string, string>> {
  const permitidos: readonly StudioIntakeTurn['question_id'][] = ['audience', 'goal', 'content']
  return Object.fromEntries(
    turns.filter(turn => permitidos.includes(turn.question_id)).map(turn => [turn.question_id, turn.answer]),
  )
}

export const MIN_PERGUNTA = 2
export const MAX_PERGUNTA = 500

/**
 * O texto da pergunta como ele é GUARDADO.
 *
 * Espaços das pontas saem e sequências de espaço viram uma só — o resto fica
 * como a pessoa escreveu, inclusive maiúsculas e acentos. "Preserve o texto do
 * histórico" é requisito do dono, e reescrever a frase de alguém para caber num
 * formato é a forma silenciosa de não preservar.
 * @param texto - o que a pessoa escreveu.
 * @returns o texto normalizado, ou `null` quando ele não serve.
 */
export function perguntaNormalizada(texto: string): string | null {
  const limpo = texto.trim().replace(/\s+/gu, ' ')
  if (limpo.length < MIN_PERGUNTA || limpo.length > MAX_PERGUNTA) return null
  return limpo
}

/** Os fatos que o Studio JÁ registrou sobre a tarefa. */
export interface FatosDaTarefa {
  readonly estado: ProjectState
  /** Quantas tentativas já existem, contando a de agora. */
  readonly tentativasFeitas: number
  /** A tentativa em curso ou a última, quando há alguma. */
  readonly tentativa: number | null
  readonly etapa: StudioRun['stage'] | null
  readonly estadoDaTentativa: StudioRun['state'] | null
  readonly criterios: number
  readonly provas: number
  /**
   * O custo estimado desta tentativa, quando ele foi REGISTRADO.
   *
   * `null` quer dizer "não registrado", e nunca zero. Um custo desconhecido
   * apresentado como `US$ 0,00` é a mentira mais barata que um painel de
   * consumo consegue contar, e o adendo de uso e custos do dono a proíbe por
   * escrito.
   */
  readonly custoEstimadoUsd: number | null
}


/*
  OS TRÊS MAPAS SÃO EXAUSTIVOS, e é por isso que são mapas.

  Um `t(`estado.${x}`)` aceitaria calado um estado novo e explodiria só na
  frente da pessoa, em tempo de execução. Aqui, um estado acrescentado ao
  domínio não compila até alguém escrever o que ele quer dizer em português —
  que é exatamente a hora de decidir isso.
*/
const ESTADO_DA_TAREFA: Readonly<Record<ProjectState, string>> = {
  DRAFT: 'pergunta.estado.DRAFT',
  SPEC_READY: 'pergunta.estado.SPEC_READY',
  PLAN_PROPOSED: 'pergunta.estado.PLAN_PROPOSED',
  PLAN_APPROVED: 'pergunta.estado.PLAN_APPROVED',
  GENERATING: 'pergunta.estado.GENERATING',
  BUILD_OK: 'pergunta.estado.BUILD_OK',
  BUILD_FAILED: 'pergunta.estado.BUILD_FAILED',
  TESTS_OK: 'pergunta.estado.TESTS_OK',
  TESTS_FAILED: 'pergunta.estado.TESTS_FAILED',
  CANCELLED: 'pergunta.estado.CANCELLED',
  INTERRUPTED: 'pergunta.estado.INTERRUPTED',
  VERIFIED_PROTOTYPE: 'pergunta.estado.VERIFIED_PROTOTYPE',
}

const ETAPA_DA_TENTATIVA: Readonly<Record<StudioRun['stage'], string>> = {
  generate: 'pergunta.etapa.generate',
  build: 'pergunta.etapa.build',
  test: 'pergunta.etapa.test',
  verify: 'pergunta.etapa.verify',
}

const ESTADO_DA_TENTATIVA: Readonly<Record<StudioRun['state'], string>> = {
  PENDING: 'pergunta.tentativa.PENDING',
  RUNNING: 'pergunta.tentativa.RUNNING',
  PASSED: 'pergunta.tentativa.PASSED',
  FAILED: 'pergunta.tentativa.FAILED',
  BLOCKED_EXTERNAL: 'pergunta.tentativa.BLOCKED_EXTERNAL',
  BUDGET_EXCEEDED: 'pergunta.tentativa.BUDGET_EXCEEDED',
  CANCELLED: 'pergunta.tentativa.CANCELLED',
}

/** Uma linha da resposta: um rótulo e o que se sabe dele. */
export interface LinhaDaResposta {
  readonly rotulo: string
  readonly valor: string
}

/**
 * O que o Studio consegue responder sobre a tarefa AGORA.
 *
 * Ela é feita só de fato registrado. Não chama modelo nenhum, não interpreta a
 * frase da pessoa e não tem como inventar: cada linha sai de um campo que já
 * existe, e o campo ausente vira "não registrado" em vez de virar zero.
 *
 * Isto NÃO é um assistente. Enquanto `EB-04` estiver aberto, nenhum modelo real
 * responde aqui, e a última linha diz isso em voz alta em vez de deixar a
 * pessoa achar que conversou com alguém.
 * @param fatos - o que está registrado sobre a tarefa.
 * @returns as linhas da resposta, na ordem em que a tela as mostra.
 */
export function respostaSobreATarefa(fatos: FatosDaTarefa): readonly LinhaDaResposta[] {
  const linhas: LinhaDaResposta[] = [
    { rotulo: t('pergunta.rotuloEstado'), valor: t(ESTADO_DA_TAREFA[fatos.estado]) },
    { rotulo: t('pergunta.rotuloTentativas'), valor: String(fatos.tentativasFeitas) },
  ]
  if (fatos.tentativa !== null && fatos.estadoDaTentativa !== null && fatos.etapa !== null) {
    linhas.push({
      rotulo: t('pergunta.rotuloUltimaTentativa'),
      valor: t('pergunta.valorUltimaTentativa', {
        tentativa: fatos.tentativa,
        etapa: t(ETAPA_DA_TENTATIVA[fatos.etapa]),
        estado: t(ESTADO_DA_TENTATIVA[fatos.estadoDaTentativa]),
      }),
    })
  }
  linhas.push({ rotulo: t('pergunta.rotuloCriterios'), valor: String(fatos.criterios) })
  linhas.push({ rotulo: t('pergunta.rotuloProvas'), valor: String(fatos.provas) })
  linhas.push({
    rotulo: t('pergunta.rotuloCusto'),
    // Ausente é ausente. Ver `FatosDaTarefa.custoEstimadoUsd`.
    valor: fatos.custoEstimadoUsd === null
      ? t('pergunta.naoRegistrado')
      : t('pergunta.valorCusto', { valor: fatos.custoEstimadoUsd.toFixed(4) }),
  })
  linhas.push({ rotulo: t('pergunta.rotuloLimite'), valor: t('pergunta.valorLimite') })
  return linhas
}

/**
 * As linhas viram o texto que fica GUARDADO na conversa.
 *
 * O registro guarda texto, e não estrutura, pelo mesmo motivo de sempre: a
 * conversa precisa poder ser relida daqui a um ano por quem não tem este
 * código à mão.
 * @param linhas - a resposta.
 * @returns uma linha por fato, `rótulo: valor`.
 */
export function respostaEmTexto(linhas: readonly LinhaDaResposta[]): string {
  return linhas.map(linha => `${linha.rotulo}: ${linha.valor}`).join('\n')
}
