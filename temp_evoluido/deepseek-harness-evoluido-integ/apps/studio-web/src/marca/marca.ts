/**
 * A MARCA DE APRESENTAÇÃO do produto, num lugar só.
 *
 * Decisão do proprietário (`FRIGG-MARCA-20260917-R1`): a marca visível passa a
 * ser **FRIGG**, o domínio escolhido é **frigg.ia.br**, o DZ23 continua como
 * origem e o DeepSeek continua como núcleo técnico. Nada disso muda uma
 * obrigação funcional, um identificador interno ou uma origem de API.
 *
 * ## Por que esta constante existe
 *
 * Antes dela o nome do produto estava escrito à mão em onze lugares — no
 * `index.html`, no manifesto da PWA e em oito catálogos de tradução. Isso é a
 * **segunda verdade** que este repositório já pagou caro para aprender a
 * evitar: bastaria consertar dez e esquecer um para o produto exibir duas
 * marcas ao mesmo tempo, e a que ficasse errada seria justamente a que
 * ninguém olha.
 *
 * ## O que é fonte, e o que é tradução
 *
 * **DECISÃO ASSUMIDA:** o VALOR da marca mora aqui; os catálogos continuam
 * escrevendo o nome por extenso dentro das frases. Justificativa: trocar o nome
 * por um `{marca}` resolvido em execução em quinze sítios de chamada espalhados
 * substituiria um risco por outro — a frase deixaria de existir inteira no
 * catálogo, que é exatamente o que `gate:i18n` lê. Quem prova que os onze
 * lugares concordam com esta fonte é `gate:marca`, que compara todos eles com
 * o que está escrito abaixo e falha quando UM diverge.
 *
 * **A exceção, e ela é uma só:** `rail.marcaAcao`, o rótulo acessível do
 * logotipo. Ali a frase NÃO existe inteira no catálogo, e isso é deliberado —
 * ela junta um nome que não se traduz a uma ação que se traduz, e a ordem das
 * duas coisas muda de língua para língua. Ver `nomeAcessivelDaMarca` no fim
 * deste arquivo.
 *
 * ## O que esta decisão NÃO autoriza
 *
 * Renomear pacote, plugin, serviço Cordis, tabela, domínio de dados, variável
 * `DZ23_*`, cache, `id`/`scope`/`start_url` do manifesto, callback OAuth, RP ID
 * de passkey ou endpoint. Marca é apresentação; origem é implantação, e são
 * deltas diferentes. `gate:marca` também guarda ESSE lado: ele falha se a
 * identidade do manifesto mudar junto com o nome.
 */
import { comValores } from '../i18n/texto'

/** A marca, como o produto a exibe. */
export const MARCA = {
  /** O nome exibido, na forma que se escreve dentro de uma frase. */
  nome: 'FRIGG',
  /** O mesmo nome onde o título é gritado — título da aba, nome da PWA. */
  nomeCaixaAlta: 'FRIGG',
  /**
   * O domínio ESCOLHIDO. Escolhido não é registrado, apontado nem servido: o
   * kit é explícito que não comprova compra, DNS, certificado nem publicação.
   */
  dominioEscolhido: 'frigg.ia.br',
  /**
   * O domínio está PUBLICADO? Não. Esta linha existe para que nenhuma tela
   * possa afirmar implantação por engano — quem quiser escrever "acesse
   * frigg.ia.br" tem de mudar isto aqui, e mudar isto aqui exige prova.
   */
  dominioPublicado: false,
  /** A marca de origem, que continua existindo e não compete com a nova. */
  origem: 'DZ23',
  /** O núcleo técnico, que a decisão de marca preserva explicitamente. */
  nucleo: 'DeepSeek',
} as const

/**
 * O EMBLEMA no trilho e nas telas amplas, e por que não é a assinatura inteira.
 *
 * Medição própria (`audit/FRIGG_MARCA_R1/comparacao-marca.png`): a assinatura
 * horizontal tem o lettering com brilho e sombreado, e num trilho de 36 px ela
 * some. O que a referência de layout mostra — e o que o guia do kit recomenda —
 * é emblema compacto ao lado do nome em TEXTO, na tipografia do produto. O
 * lettering artístico não vira a fonte do aplicativo.
 */
export const EMBLEMA = {
  /** 1× do trilho. */
  src: '/studio/brand/frigg-mark-48.png',
  /** 1× e 2×, porque num monitor denso um PNG de 48 px desenhado a 48 px borra. */
  srcSet: '/studio/brand/frigg-mark-48.png 1x, /studio/brand/frigg-mark-96.png 2x',
  /** O lado da caixa, em pixels de CSS. O derivado é quadrado por construção. */
  lado: 36,
} as const

/**
 * O título de uma tela, como a aba do navegador o escreve.
 *
 * A marca vem por ÚLTIMO: quem tem seis abas abertas lê os primeiros caracteres
 * de cada uma, e seis abas começando com "FRIGG" são seis abas iguais.
 * @param secao - o nome da tela, quando não é a inicial.
 * @returns o título da aba.
 */
export function tituloDaPagina(secao?: string | null): string {
  const limpo = secao?.trim()
  return limpo === undefined || limpo === '' ? MARCA.nomeCaixaAlta : `${limpo} · ${MARCA.nomeCaixaAlta}`
}

/**
 * O nome acessível do logotipo do trilho.
 *
 * O logotipo é um LINK para a tela inicial, e o guia do kit é explícito: quando
 * o logo é botão, o nome acessível indica a AÇÃO, não o arquivo. E como o nome
 * da marca já está escrito em texto ao lado, a imagem fica `aria-hidden` — sem
 * isso o leitor de tela diria "FRIGG FRIGG".
 *
 * ## Por que o modelo vem de fora, e a marca de dentro
 *
 * A marca é a mesma em toda língua; a AÇÃO não é. Até 18/09/2026 esta função
 * devolvia `ir para a tela inicial` fixo, e o trilho a usava no `aria-label`
 * mesmo com `rail.en` ou `rail.es` escolhidos — ou seja, a navegação anunciada
 * como migrada tinha uma frase em português dita em voz alta a quem usa leitor
 * de tela, e só a quem usa leitor de tela. Uma revisão externa achou; nenhuma
 * varredura de texto acharia, porque a frase não estava num literal da tela:
 * estava dentro de uma função.
 *
 * O modelo traz `{marca}` em vez de a função concatenar nome e ação, porque a
 * ordem das palavras é decisão do tradutor. Quem chama passa `rail.marcaAcao`.
 * @param modelo - o texto do catálogo, com o marcador `{marca}`.
 * @returns o rótulo do link.
 */
export function nomeAcessivelDaMarca(modelo: string): string {
  return comValores(modelo, { marca: MARCA.nome })
}

/**
 * O domínio pode ser anunciado como endereço de acesso?
 *
 * Existe para que a resposta seja UMA. Um ambiente local que mandasse a pessoa
 * para o domínio escolhido faria requisição involuntária a um endereço que
 * ninguém provou controlar.
 * @returns `true` somente quando houver publicação provada.
 */
export function podeAnunciarDominio(): boolean {
  return MARCA.dominioPublicado
}
