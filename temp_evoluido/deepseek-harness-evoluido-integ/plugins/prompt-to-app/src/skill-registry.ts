import { t } from './i18n.js'
import type { ContextSection } from './context.js'

/**
 * O registro de habilidades, com CARREGAMENTO PROGRESSIVO.
 *
 * Uma habilidade é instrução em prosa que um agente vai seguir. O livro mestre
 * já registrou o risco, e ele não mudou: *"o vetor de um pacote de skills é
 * conteúdo malicioso em PROSA, não defeito de biblioteca, e nenhum scanner
 * nosso alcança isso"*. Então o que este módulo governa não é desempenho — é
 * QUANTA prosa de terceiro entra no contexto, e sob que condições.
 *
 * Progressivo significa uma coisa precisa: a escolha é feita sobre a FICHA
 * (nome, uma linha de gatilho, e o tamanho DECLARADO do corpo), e o corpo só é
 * buscado depois de a escolha caber. Carregar tudo e cortar depois seria pior
 * que inútil: instrução não é cortável — meia regra se lê como regra, e o
 * motor de contexto trata `instruction` como intocável justamente por isso.
 *
 * A consequência de desenho, que vale a pena dizer em voz alta: sem o tamanho
 * declarado na ficha, não existe carregamento progressivo. Só existiria
 * carregar e torcer.
 */

/** A ficha de uma habilidade: o que é barato saber sobre ela. */
export interface SkillCard {
  readonly skill_id: string
  readonly name: string
  /** Uma linha dizendo QUANDO ela serve. É o que decide a escolha. */
  readonly trigger: string
  /**
   * O tamanho do corpo, em caracteres, como o registro declara.
   *
   * É o que permite decidir ANTES de buscar. Um corpo que chega diferente do
   * declarado é recusado — ver `loadSkills`.
   */
  readonly body_chars: number
  /**
   * De onde ela veio: a integração e a impressão do manifesto.
   *
   * Sem isto, uma instrução de terceiro entra no contexto sem endereço, e a
   * pergunta depois de uma resposta estranha — "de onde saiu essa regra?" —
   * não tem resposta.
   */
  readonly source: string
  /** Se a integração que a publica está ligada AGORA. */
  readonly enabled: boolean
}

/** De onde o corpo de uma habilidade é buscado, quando for a hora. */
export interface SkillBodyLoader {
  load(skillId: string): Promise<string>
}

export type SkillSkipReason =
  | 'DISABLED'
  | 'NO_MATCH'
  | 'BUDGET'
  | 'OVERSIZED'
  | 'DUPLICATE'

export interface SkillSelection {
  readonly chosen: readonly SkillCard[]
  readonly skipped: readonly { readonly skill_id: string; readonly reason: SkillSkipReason }[]
  /** Quanto do teto as escolhidas vão ocupar, pelo tamanho declarado. */
  readonly declared_chars: number
}

/**
 * Nenhuma habilidade sozinha pode passar desta fatia do teto.
 *
 * Uma habilidade que ocupa o contexto inteiro não deixa espaço para o pedido
 * da pessoa, e o resultado é um agente que segue a instrução de terceiro e
 * ignora quem pediu. O limite é uma FRAÇÃO do teto, e não um número fixo,
 * porque instalações com teto maior deveriam poder ter habilidades maiores —
 * mas nunca uma que engula tudo.
 */
export const MAX_SKILL_FRACTION = 0.25

/**
 * Se a ficha casa com o pedido.
 *
 * Comparação por PALAVRA, sem acento e sem caixa. Casar por trecho faria
 * `"ar"` casar com `"calendário"`, e a habilidade errada entraria por
 * coincidência de letras — o que, tratando-se de instrução que o agente vai
 * seguir, não é um erro de relevância: é uma regra que ninguém escolheu.
 * @param card - a ficha.
 * @param request - o que a pessoa pediu.
 * @returns se serve.
 */
export function matchesRequest(card: SkillCard, request: string): boolean {
  const pedido = new Set(words(request))
  if (pedido.size === 0) return false
  return words(card.trigger).some(word => pedido.has(word))
}

/**
 * As palavras de ligação, nomeadas uma a uma.
 *
 * Cortar por TAMANHO não resolve: "para", "como", "quando", "porque" têm
 * quatro letras ou mais e casariam com quase todo pedido — e "site", "nome",
 * "data" têm o mesmo tamanho e são palavras de conteúdo. A lista é explícita
 * porque a regra é sobre o QUE a palavra é, não sobre quanto ela mede.
 */
const LIGACAO = new Set([
  'para', 'pelo', 'pela', 'pelos', 'pelas', 'como', 'quando', 'porque', 'entao',
  'esse', 'essa', 'este', 'esta', 'isso', 'aquilo', 'aquele', 'aquela',
  'minha', 'seu', 'sua', 'nosso', 'nossa', 'dele', 'dela',
  'tudo', 'todo', 'toda', 'algum', 'alguma', 'outro', 'outra',
  'quero', 'queria', 'preciso', 'precisa', 'fazer', 'tenho', 'quer',
  'mais', 'menos', 'muito', 'pouco', 'aqui', 'ali',
  'sobre', 'ainda', 'depois', 'antes', 'agora',
])

/** As palavras de conteúdo de um texto, normalizadas. */
function words(text: string): readonly string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    // Até três letras é artigo e preposição ("de", "com", "que"); o resto que
    // é ligação está nomeado acima. Uma habilidade escolhida por "para" é uma
    // habilidade escolhida por acaso — e acaso, aqui, é uma regra que ninguém
    // escolheu sendo seguida por um agente.
    .filter(word => word.length > 3 && !LIGACAO.has(word))
}

/**
 * Escolhe quais habilidades vale a pena carregar, SEM carregar nenhuma.
 *
 * A ordem de preferência é a ordem de entrada: o registro decide quem vem
 * primeiro, e esta função não reordena. Empate resolvido por ordem de entrada
 * mantém a escolha reproduzível — duas montagens do mesmo pedido têm de
 * produzir o mesmo contexto, ou ninguém consegue explicar uma resposta ruim.
 * @param cards - as fichas conhecidas.
 * @param request - o que a pessoa pediu.
 * @param budgetChars - quanto do contexto as habilidades podem ocupar ao todo.
 * @returns as escolhidas, as descartadas com o motivo, e o custo declarado.
 */
export function selectSkills(
  cards: readonly SkillCard[], request: string, budgetChars: number,
): SkillSelection {
  const teto = Math.floor(budgetChars * MAX_SKILL_FRACTION)
  const chosen: SkillCard[] = []
  const skipped: { skill_id: string; reason: SkillSkipReason }[] = []
  const vistos = new Set<string>()
  let usado = 0

  for (const card of cards) {
    // A ordem das conferências É o contrato. Desligada primeiro: uma habilidade
    // de integração desligada não é "não casou", é "não pode".
    if (!card.enabled) { skipped.push({ skill_id: card.skill_id, reason: 'DISABLED' }); continue }
    if (vistos.has(card.skill_id)) { skipped.push({ skill_id: card.skill_id, reason: 'DUPLICATE' }); continue }
    if (!matchesRequest(card, request)) { skipped.push({ skill_id: card.skill_id, reason: 'NO_MATCH' }); continue }
    if (card.body_chars > teto) { skipped.push({ skill_id: card.skill_id, reason: 'OVERSIZED' }); continue }
    if (usado + card.body_chars > budgetChars) {
      // BUDGET não interrompe o laço: uma habilidade pequena depois de uma
      // grande ainda pode caber, e parar aqui descartaria por POSIÇÃO o que
      // deveria ser descartado por tamanho.
      skipped.push({ skill_id: card.skill_id, reason: 'BUDGET' })
      continue
    }
    vistos.add(card.skill_id)
    chosen.push(card)
    usado += card.body_chars
  }
  return { chosen, skipped, declared_chars: usado }
}

/**
 * Por que uma habilidade escolhida não virou parte do contexto.
 *
 * Os dois casos são diferentes, e juntá-los apagaria o que importa:
 * `SIZE_MISMATCH` é o registro tendo descrito uma coisa e entregue outra — a
 * forma de um pacote passar instrução que ninguém aprovou —, e `LOAD_FAILED` é
 * o registro tendo RECUSADO entregar, o que pode ser desde "está desligada"
 * até "o texto foi trocado depois de instalado".
 */
export type SkillRefusal =
  | { readonly skill_id: string; readonly reason: 'SIZE_MISMATCH'; readonly declared: number; readonly actual: number }
  | { readonly skill_id: string; readonly reason: 'LOAD_FAILED'; readonly detail: string }

/** Um corpo que chegou diferente do que a ficha prometia. */
export class SkillBodyMismatchError extends Error {
  readonly code = 'SKILL_BODY_MISMATCH'
  constructor(readonly skillId: string, readonly declared: number, readonly actual: number) {
    super(t('errors.skillBodyMismatch'))
  }
}

/**
 * Busca o corpo das escolhidas e devolve as partes de contexto.
 *
 * O corpo é CONFERIDO contra o tamanho declarado. Um corpo maior do que a
 * ficha prometia não é um detalhe de contabilidade: ele fura o teto que a
 * escolha acabou de respeitar, e, pior, significa que o registro descreveu uma
 * coisa e entregou outra — que é exatamente a forma de um pacote de habilidades
 * passar instrução que ninguém aprovou.
 *
 * A recusa é POR HABILIDADE, e não da montagem inteira: uma habilidade que
 * mentiu não pode derrubar o pedido da pessoa junto com ela. O que ela não
 * pode é entrar.
 * @param chosen - as fichas escolhidas.
 * @param loader - de onde os corpos vêm.
 * @returns as partes e as recusas.
 */
export async function loadSkills(
  chosen: readonly SkillCard[], loader: SkillBodyLoader,
): Promise<{
  readonly sections: readonly ContextSection[]
  readonly refused: readonly SkillRefusal[]
}> {
  const sections: ContextSection[] = []
  const refused: SkillRefusal[] = []
  for (const card of chosen) {
    let body: string
    try {
      body = await loader.load(card.skill_id)
    } catch (error) {
      // A recusa do registro NÃO derruba o pedido da pessoa. Ela é uma
      // habilidade a menos, com o motivo guardado — e o motivo importa: o
      // registro distingue "desligada", "sem texto" e "texto trocado depois de
      // instalado", e essa última é um incidente que alguém precisa ver.
      refused.push({
        skill_id: card.skill_id, reason: 'LOAD_FAILED',
        detail: error instanceof Error ? error.message : t('errors.skillBodyMismatch'),
      })
      continue
    }
    if (body.length !== card.body_chars) {
      refused.push({ skill_id: card.skill_id, reason: 'SIZE_MISMATCH', declared: card.body_chars, actual: body.length })
      continue
    }
    sections.push({
      id: `skill:${card.skill_id}`,
      // `instruction` porque é isso que ela é: texto que muda o comportamento
      // do agente. Entrar como `evidence` a tornaria cortável pelo teto, e uma
      // instrução cortada pela metade se lê como uma instrução inteira.
      kind: 'instruction',
      priority: 0,
      text: body,
      source: card.source,
    })
  }
  return { sections, refused }
}

/**
 * O recorte de uma integração de onde uma ficha pode sair.
 *
 * Estrutural de propósito: `prompt-to-app` não depende de `integration-hub`, e
 * o motor de contexto não pode passar a exigir o registro de integrações para
 * compilar.
 */
export interface SkillIntegrationShape {
  readonly integration_id: string
  readonly kind: string
  readonly enabled: boolean
  readonly manifest: {
    readonly name: string
    readonly skill?: { readonly trigger: string; readonly body_chars: number } | undefined
    readonly provenance?: { readonly artifact_sha256: string } | undefined
  } | null
}

/** Por que uma integração não virou ficha. */
export type SkillCardGap = 'NOT_A_SKILL' | 'NO_MANIFEST' | 'NO_DECLARED_SIZE'

/**
 * As fichas que saem do registro de integrações.
 *
 * Uma habilidade sem `skill` no manifesto NÃO vira ficha, e a ausência é
 * DEVOLVIDA com o motivo em vez de silenciada: ela fica registrada, aparece na
 * lista de integrações, e nunca é escolhida. Alguém vai perguntar por que — e a
 * resposta precisa existir antes da pergunta.
 *
 * A procedência da ficha é a impressão do ARTEFATO, e não o identificador da
 * integração sozinho: o identificador diz qual linha do registro, e a impressão
 * diz quais bytes. Depois de uma resposta estranha, a pergunta é a segunda.
 * @param integrations - as integrações registradas.
 * @returns as fichas e as que não puderam virar ficha.
 */
export function skillCardsFrom(integrations: readonly SkillIntegrationShape[]): {
  readonly cards: readonly SkillCard[]
  readonly gaps: readonly { readonly integration_id: string; readonly gap: SkillCardGap }[]
} {
  const cards: SkillCard[] = []
  const gaps: { integration_id: string; gap: SkillCardGap }[] = []
  for (const row of integrations) {
    if (row.kind !== 'skill') continue
    if (row.manifest === null) { gaps.push({ integration_id: row.integration_id, gap: 'NO_MANIFEST' }); continue }
    const declared = row.manifest.skill
    if (declared === undefined) { gaps.push({ integration_id: row.integration_id, gap: 'NO_DECLARED_SIZE' }); continue }
    const artifact = row.manifest.provenance?.artifact_sha256
    cards.push({
      skill_id: row.integration_id,
      name: row.manifest.name,
      trigger: declared.trigger,
      body_chars: declared.body_chars,
      // Identificador de PROCEDÊNCIA, e não frase: ele é uma chave que o
      // registro de contexto guarda e que alguém compara com o registro de
      // integrações. Escrevê-lo em português o faria parecer texto de tela e o
      // deixaria à mercê de uma tradução — e uma procedência traduzida deixa de
      // casar com a linha que ela aponta.
      source: artifact === undefined
        ? `integration:${row.integration_id}`
        : `integration:${row.integration_id} artifact:${artifact}`,
      enabled: row.enabled,
    })
  }
  return { cards, gaps }
}

/**
 * O recorte do registro de integrações de onde os corpos vêm.
 *
 * Estrutural, como `SkillIntegrationShape`, e pela mesma razão. O que importa
 * do outro lado é que `skillBody` RECUSA — desligada, sem assinatura válida
 * agora, texto trocado depois de instalado — em vez de devolver o que estiver
 * gravado. Esta porta não repete nenhuma dessas conferências: repeti-las aqui
 * criaria uma segunda verdade que diverge no primeiro conserto de um dos lados.
 */
export interface SkillBodySource {
  skillBody(integrationId: string): Promise<string>
}

/**
 * O carregador que busca corpos no registro de integrações.
 *
 * Uma recusa do registro SOBE. Ela não vira string vazia nem texto ausente:
 * "esta habilidade está desligada" e "esta habilidade não tem texto" mandam
 * fazer coisas diferentes, e as duas são diferentes de "o texto foi trocado
 * depois de instalado", que é um incidente.
 * @param source - o registro.
 * @returns o carregador.
 */
export function hubSkillLoader(source: SkillBodySource): SkillBodyLoader {
  return { load: async skillId => source.skillBody(skillId) }
}
