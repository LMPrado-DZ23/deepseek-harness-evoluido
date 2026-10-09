/**
 * O IDIOMA da interface — as decisões, num lugar só.
 *
 * Adendo `FRIGG-CONTA-APOIADOR-INTERNACIONAL-R2`: o produto passa a ter
 * português do Brasil, inglês e espanhol de verdade, com seleção e persistência
 * reais. Não é um seletor decorativo, e não é uma segunda cópia do frontend.
 *
 * ## O que este módulo NÃO decide
 *
 * Idioma **não** é moeda, não é fuso, não é país fiscal e não é permissão. O
 * adendo é explícito: "inglês não força USD; espanhol não força EUR; português
 * não comprova residência no Brasil". Trocar de idioma muda a APRESENTAÇÃO — e
 * nada mais. Nenhuma função daqui lê preço, conta, tarefa ou agendamento.
 *
 * ## A precedência, e por que ela tem esta ordem
 *
 * 1. **a escolha explícita desta pessoa, agora.** Quem acabou de escolher
 *    espanhol quis espanhol, e nada pode desfazer isso enquanto ela estiver ali.
 * 2. **a preferência persistida** da instalação ou da conta.
 * 3. **o que o navegador negocia**, por BCP 47.
 * 4. **pt-BR**, que é o idioma de quem já usa o produto hoje.
 *
 * A corrida entre 1 e 2 é o defeito que o adendo manda tratar por escrito: a
 * preferência da conta chega por rede, DEPOIS de a pessoa já ter escolhido na
 * tela, e sobrescrevê-la faria a escolha dela piscar e voltar. Por isso as duas
 * carregam INSTANTE, e a mais recente vence.
 */

/** Os idiomas que o produto tem de verdade — com catálogo completo. */
export const IDIOMAS = ['pt-BR', 'en', 'es'] as const

export type Idioma = typeof IDIOMAS[number]

/**
 * O nome de cada idioma NA PRÓPRIA LÍNGUA.
 *
 * O adendo pede nomes próprios, e não bandeiras. Bandeira é país: a do Brasil
 * não representa quem fala português em Portugal, e a da Espanha não representa
 * quem fala espanhol no México. Nome próprio é o que a pessoa reconhece mesmo
 * quando a interface está numa língua que ela não lê.
 */
export const NOME_DO_IDIOMA: Readonly<Record<Idioma, string>> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
  es: 'Español',
}

/** O idioma padrão: o de quem já usa o produto hoje. */
export const IDIOMA_PADRAO: Idioma = 'pt-BR'

/**
 * Este texto é um idioma que o produto tem?
 * @param valor - o candidato, de qualquer origem.
 * @returns `true` quando é um dos idiomas suportados.
 */
export function ehIdioma(valor: unknown): valor is Idioma {
  return typeof valor === 'string' && (IDIOMAS as readonly string[]).includes(valor)
}

/**
 * A tag BCP 47 do navegador, mapeada para um catálogo que existe.
 *
 * `en-GB`, `en-US` e `en` caem em `en`; `es-MX` e `es-419` caem em `es`;
 * qualquer `pt-*` cai em `pt-BR` — inclusive `pt-PT`, e isso é uma decisão
 * declarada: o produto não tem catálogo europeu, e entregar português do Brasil
 * a quem pediu português é melhor que entregar inglês.
 *
 * A comparação é pela SUBTAG primária, em minúsculas, porque a tag pode vir em
 * qualquer caixa e com região, script ou variante no meio.
 * @param tag - a tag do navegador ou do sistema.
 * @returns o idioma correspondente, ou `null` quando não há nenhum.
 */
export function idiomaDaTag(tag: string): Idioma | null {
  const primaria = tag.trim().toLowerCase().split('-')[0] ?? ''
  if (primaria === 'pt') return 'pt-BR'
  if (primaria === 'en') return 'en'
  if (primaria === 'es') return 'es'
  return null
}

/**
 * O primeiro idioma suportado na lista de preferências do navegador.
 *
 * A ORDEM importa: `navigator.languages` vem da mais desejada para a menos, e
 * pegar a primeira que o produto tem é o que a pessoa configurou. Varrer tudo e
 * ficar com a última inverteria a preferência dela.
 * @param tags - as tags, na ordem do navegador.
 * @returns o idioma negociado, ou `null` quando nenhuma casa.
 */
export function idiomaNegociado(tags: readonly string[]): Idioma | null {
  for (const tag of tags) {
    const idioma = idiomaDaTag(tag)
    if (idioma !== null) return idioma
  }
  return null
}

/**
 * Uma escolha de idioma guardada, com a VERSÃO dela.
 *
 * `em` é o instante em que foi feita, e serve para dizer à pessoa desde quando
 * vale. Ele **não decide nada** — ver `idiomaEfetivo`.
 */
export interface EscolhaDeIdioma {
  readonly idioma: Idioma
  /** Milissegundos desde a época, e só para efeito informativo. */
  readonly em: number
  /**
   * Quantas vezes a preferência foi gravada. Cresce de um em um, e é isto que
   * decide qual de duas cópias guardadas é a mais nova. Ausente nas escolhas
   * gravadas antes de 18/09/2026, e aí vale zero.
   */
  readonly versao?: number
}

/**
 * O idioma que VALE agora.
 *
 * ## Por que relógio não decide mais nada aqui
 *
 * Até 18/09/2026 esta função comparava `local.em` com `daConta.em` — dois
 * instantes medidos em MÁQUINAS DIFERENTES. Uma revisão externa apontou o
 * problema antes de ele acontecer, e ele é real: o relógio do aparelho da pessoa
 * pode estar meia hora adiantado ou um dia atrasado em relação ao servidor, e
 * nesse caso a comparação não responde "qual é a mais nova" — responde "qual
 * máquina acha que é mais tarde". Com o relógio adiantado, uma preferência
 * antiga do aparelho venceria para sempre a preferência nova da conta; com ele
 * atrasado, a escolha que a pessoa acabou de fazer perderia para a resposta da
 * conta e a tela voltaria de idioma sozinha, na frente dela.
 *
 * ## A precedência, e ela não tem empate
 *
 * 1. **A escolha DESTA sessão.** Se a pessoa trocou o idioma agora, nenhuma
 *    resposta de rede, por mais atrasada que chegue, desfaz isso. Este degrau é
 *    o que garante o contrato do adendo — trocar de idioma não pisca nem volta.
 * 2. **Entre as duas GUARDADAS, a de maior `versao`.** É um contador que cresce
 *    a cada gravação, não um relógio: ele não depende de máquina nenhuma estar
 *    com a hora certa.
 * 3. **Empate de versão: a CONTA.** Duas cópias com a mesma versão são a mesma
 *    verdade; ficar com a da conta é o que faz dois aparelhos convergirem em vez
 *    de cada um insistir na sua.
 * 4. A negociação do navegador, e por último o padrão.
 *
 * **DECISÃO ASSUMIDA:** versão monotônica por gravação, e não relógio lógico
 * completo nem CRDT. Justificativa: o dado é UMA preferência de apresentação
 * cujo pior desfecho é a tela abrir na língua errada até a próxima troca. Um
 * protocolo de sincronização distribuída aqui seria mais caro de manter do que o
 * defeito que evita — e a revisão pediu explicitamente para não inventar um.
 * @param entrada - as origens conhecidas.
 * @returns o idioma efetivo.
 */
export function idiomaEfetivo(entrada: {
  /** A troca feita nesta sessão, em frente à pessoa. Vence tudo. */
  readonly daSessao?: Idioma | null
  readonly local?: EscolhaDeIdioma | null
  readonly daConta?: EscolhaDeIdioma | null
  readonly doNavegador?: Idioma | null
}): Idioma {
  const { daSessao, local, daConta, doNavegador } = entrada
  if (daSessao != null) return daSessao
  if (local != null && daConta != null) {
    return (versaoDa(local) > versaoDa(daConta) ? local : daConta).idioma
  }
  if (local != null) return local.idioma
  if (daConta != null) return daConta.idioma
  return doNavegador ?? IDIOMA_PADRAO
}

/**
 * A versão de uma escolha guardada.
 *
 * Ausente vale ZERO, e não "a mais nova": uma escolha gravada antes de o
 * contador existir não sabe quantas vezes foi reescrita, e tratá-la como recente
 * faria uma preferência antiga do aparelho vencer a da conta.
 * @param escolha - a escolha.
 * @returns a versão.
 */
export function versaoDa(escolha: EscolhaDeIdioma): number {
  return typeof escolha.versao === 'number' && Number.isFinite(escolha.versao) ? escolha.versao : 0
}

/**
 * A tag que vai no `lang` do documento.
 *
 * Ela existe como função porque `html.lang` não é decoração: é o que diz ao
 * leitor de tela em que língua pronunciar, e um `lang` errado faz a frase sair
 * incompreensível para quem depende dele.
 * @param idioma - o idioma efetivo.
 * @returns a tag BCP 47.
 */
export function tagDoDocumento(idioma: Idioma): string {
  return idioma
}

/** A chave onde a escolha da instalação fica guardada, neste navegador. */
export const CHAVE_DO_IDIOMA = 'frigg.idioma.v1'

/**
 * A escolha guardada neste navegador, quando há uma.
 *
 * Toda leitura é protegida: em janela anônima, com dados do site bloqueados ou
 * num navegador que recusa armazenamento, o acesso LANÇA — e uma exceção aqui
 * derrubaria a aplicação inteira antes do primeiro render, por causa de uma
 * preferência de apresentação.
 * @param armazem - o armazenamento a ler; ausente em servidor.
 * @returns a escolha, ou `null`.
 */
export function escolhaGuardada(armazem: Pick<Storage, 'getItem'> | undefined): EscolhaDeIdioma | null {
  if (armazem === undefined) return null
  try {
    const cru = armazem.getItem(CHAVE_DO_IDIOMA)
    if (cru === null) return null
    const valor = JSON.parse(cru) as { idioma?: unknown, em?: unknown, versao?: unknown }
    if (!ehIdioma(valor.idioma) || typeof valor.em !== 'number' || !Number.isFinite(valor.em)) return null
    const versao = typeof valor.versao === 'number' && Number.isFinite(valor.versao) ? valor.versao : 0
    return { idioma: valor.idioma, em: valor.em, versao }
  } catch {
    // Guardado ilegível é o mesmo que não guardado: a pessoa cai na negociação
    // do navegador, que é um estado honesto, em vez de numa tela quebrada.
    return null
  }
}

/**
 * Guarda a escolha neste navegador.
 * @param armazem - o armazenamento a escrever; ausente em servidor.
 * @param escolha - a escolha a guardar.
 * @returns `true` quando foi guardada de verdade.
 */
export function guardarEscolha(armazem: Pick<Storage, 'setItem' | 'getItem'> | undefined, escolha: EscolhaDeIdioma): boolean {
  if (armazem === undefined) return false
  try {
    /*
      A versão vem do que JÁ ESTAVA guardado, mais um.

      Ela não pode vir de quem chama: duas abas abertas gravariam a mesma versão
      e a segunda ficaria indistinguível da primeira. Lendo aqui, a última
      gravação é sempre a de maior versão, sem consultar relógio nenhum.
    */
    const anterior = escolhaGuardada(armazem)
    const versao = (anterior === null ? 0 : versaoDa(anterior)) + 1
    armazem.setItem(CHAVE_DO_IDIOMA, JSON.stringify({ ...escolha, versao }))
    return true
  } catch {
    // Não deu para guardar. A escolha continua valendo NESTA sessão — perder a
    // troca de idioma no mesmo instante em que a pessoa a fez seria pior que
    // esquecê-la no próximo carregamento.
    return false
  }
}
