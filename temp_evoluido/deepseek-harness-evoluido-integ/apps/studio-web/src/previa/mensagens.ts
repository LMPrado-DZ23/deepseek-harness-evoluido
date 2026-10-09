/**
 * O que a prévia tem permissão de DIZER para a interface.
 *
 * ## A regra, e ela não tem exceção
 *
 * O que vem de dentro do quadro é DADO, nunca instrução. Lá dentro roda código
 * que um modelo escreveu a partir do que uma pessoa pediu — e o pedido pode ter
 * vindo de qualquer lugar. Uma mensagem que chega daí não autoriza executar
 * comando, abrir outro projeto, ampliar acesso nem publicar.
 *
 * ## Como esta função impede isso por construção
 *
 * Ela não tem vocabulário para autorizar. Os tipos que ela reconhece são três,
 * todos informativos: a prévia PEDIU o bilhete de admissão, a prévia MUDOU de
 * rota, a prévia relatou um ERRO da aplicação. Qualquer outro tipo cai fora, e
 * a conferência é por lista fechada — o que não está escrito aqui não existe,
 * em vez de ser aceito por parecer inofensivo.
 *
 * Origem e janela de origem são conferidas por quem chama, ANTES daqui, e essa
 * ordem importa: esta função recebe o corpo já sabendo de onde ele veio.
 */

export type MensagemDaPrevia =
  | { readonly tipo: 'PEDIU_ADMISSAO' }
  | { readonly tipo: 'MUDOU_DE_ROTA'; readonly caminho: string }
  | { readonly tipo: 'ERRO'; readonly mensagem: string }
  /**
   * A pessoa clicou num pedaço do aplicativo com a seleção ligada.
   *
   * O corpo vem CRU de propósito: quem sabe o que é um elemento é
   * `selecao.ts`, e ele tem a própria lista fechada. Decodificar aqui
   * espalharia o vocabulário do elemento por dois arquivos.
   */
  | { readonly tipo: 'SELECIONOU'; readonly corpo: unknown }

/** Quanto texto de erro a interface aceita mostrar. */
export const LIMITE_DO_ERRO = 500

/**
 * A mensagem, quando ela é uma das três que existem.
 * @param corpo - o `data` do evento, já conferido quanto à origem.
 * @returns a mensagem reconhecida, ou `null` — que é a resposta para tudo o mais.
 */
export function mensagemDaPrevia(corpo: unknown): MensagemDaPrevia | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const tipo = (corpo as { type?: unknown }).type
  if (tipo === 'DZ23_PREVIEW_READY') return { tipo: 'PEDIU_ADMISSAO' }
  if (tipo === 'DZ23_PREVIEW_ROUTE') {
    const caminho = (corpo as { path?: unknown }).path
    /*
      A rota que a prévia ANUNCIA passa pela mesma conferência da rota que a
      pessoa digita. Um aplicativo gerado que anuncie `https://outro.site`
      moveria o quadro para fora sem ninguém ter pedido — e quem confere é
      `rotaDaPrevia`, em quem chama, não este decodificador.
    */
    return typeof caminho === 'string' ? { tipo: 'MUDOU_DE_ROTA', caminho } : null
  }
  if (tipo === 'DZ23_PREVIEW_SELECT') return { tipo: 'SELECIONOU', corpo }
  if (tipo === 'DZ23_PREVIEW_ERROR') {
    const mensagem = (corpo as { message?: unknown }).message
    if (typeof mensagem !== 'string') return null
    /*
      O texto é CORTADO e devolvido como texto puro. Ele vai para a tela, e um
      erro de dentro do aplicativo gerado é conteúdo de origem desconhecida:
      sem limite, ele enche a interface; interpretado, ele vira injeção.
    */
    return { tipo: 'ERRO', mensagem: mensagem.slice(0, LIMITE_DO_ERRO) }
  }
  return null
}
