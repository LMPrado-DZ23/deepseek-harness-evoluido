
/**
 * O endereco da tela do assistente.
 *
 * Ele mora AQUI, e nao em `AssistantEntry`, por um motivo que custou uma suite
 * travada para aparecer: o painel de equipe passou a montar o endereco do
 * pedido; `assistantRequest` importava a constante de `AssistantEntry`; e
 * `AssistantEntry` importa a conversa, que agora importa o fluxo. O ciclo se
 * fechava - e num ciclo o modulo avaliado primeiro enxerga o outro pela
 * metade, o que no navegador vira uma tela que simplesmente nao desenha.
 * Constante em modulo FOLHA nao participa de ciclo nenhum.
 */
export const ASSISTANT_PATH = '/studio/assistente'

/**
 * O caminho que leva a conversa com um pedido JÁ ESCRITO no campo.
 *
 * Existe por causa de um beco real. O painel de trabalho em equipe mostra tudo
 * sobre uma equipe — árvore, estados, custo, evidência, quem autorizou, o botão
 * de parar — e não tinha **nenhum caminho para começar uma**. Quem chegava lá
 * sem equipe nenhuma lia "Nenhum trabalho em equipe foi iniciado neste projeto"
 * e ficava sem saber o que fazer com essa informação.
 *
 * ## Por que um pedido, e não um botão que inicia
 *
 * Porque uma rota HTTP **não pode** iniciar uma equipe, e fingir que pode seria
 * pior que a ausência do botão. A equipe é ancorada num agente vivo do Harness
 * (`request.parent`), usado como dono, como sessão de origem e como âncora do
 * coordenador — e um agente vivo só existe dentro de uma chamada de ferramenta,
 * não numa requisição HTTP. Um botão "Iniciar equipe" que abrisse uma rota
 * teria de inventar esse agente, e inventar dono é a espécie de atalho que este
 * repositório recusa.
 *
 * O que existe de verdade é a conversa: ela **tem** o agente vivo, e o
 * assistente **tem** a ferramenta de iniciar equipe. Então o caminho honesto é
 * levar a pessoa até lá com o pedido escrito, em vez de deixá-la adivinhar as
 * palavras. Ela lê, ajusta e envia — o envio continua sendo dela.
 */

/** O parâmetro que carrega o pedido. Em português, como o resto dos endereços. */
export const ASSISTANT_REQUEST_PARAM = 'pedido'

/** Teto do texto que viaja no endereço. */
export const MAX_ASSISTANT_REQUEST_CHARS = 500

/**
 * O endereço da conversa com o pedido preparado.
 * @param request - o texto sugerido; vazio devolve o endereço simples.
 * @returns o caminho para navegar.
 */
export function assistantRequestAddress(request: string): string {
  const text = request.trim().slice(0, MAX_ASSISTANT_REQUEST_CHARS)
  if (text === '') return ASSISTANT_PATH
  return `${ASSISTANT_PATH}?${ASSISTANT_REQUEST_PARAM}=${encodeURIComponent(text)}`
}

/**
 * O pedido que veio no endereço, se veio um utilizável.
 *
 * O texto é tratado como HOSTIL: ele chega da barra de endereço, que qualquer
 * pessoa edita e qualquer link de fora pode montar. Ele nunca é enviado sozinho
 * — só preenche o campo, à vista, para a pessoa ler antes de mandar. Cortar no
 * teto e recusar vazio impede que um endereço colado encha a caixa de texto
 * com uma parede que ninguém vai ler até o fim.
 * @param search - a parte de consulta do endereço.
 * @returns o texto, ou `null` quando não há pedido nenhum.
 */
export function assistantRequestFrom(search: string): string | null {
  let raw: string | null
  try { raw = new URLSearchParams(search).get(ASSISTANT_REQUEST_PARAM) }
  catch { return null }
  if (raw === null) return null
  const text = raw.trim().slice(0, MAX_ASSISTANT_REQUEST_CHARS)
  return text === '' ? null : text
}
