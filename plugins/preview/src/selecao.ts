/**
 * A SELEÇÃO VISUAL, do lado de DENTRO do aplicativo gerado.
 *
 * ## Por que o roteiro é servido, e não copiado para o template
 *
 * O template é copiado uma vez, quando o aplicativo nasce. Um roteiro escrito
 * lá dentro ficaria congelado na versão do dia, e a próxima correção só
 * alcançaria os aplicativos criados depois dela — os que já existem ficariam
 * com a versão velha para sempre, e ninguém saberia quais.
 *
 * Servido pela porta da prévia, ele é UM: todo aplicativo servido hoje recebe o
 * roteiro de hoje, e uma correção vale para todos na hora. É também o único
 * jeito de a origem do FRIGG entrar nele — o template não a conhece, e não deve
 * conhecer.
 *
 * ## O que ele pode fazer, e o que ele não pode
 *
 * Ele lê o que a pessoa clicou — etiqueta, texto visível e rota — e manda para
 * QUEM PEDIU. Ele não lê formulário, não lê armazenamento, não faz requisição e
 * não alcança nada fora do próprio documento.
 *
 * O modo de seleção só liga por mensagem de `window.parent` vinda da origem do
 * FRIGG, e as duas conferências são feitas: a origem sozinha aceitaria qualquer
 * aba daquele host, e a janela sozinha aceitaria qualquer origem que
 * conseguisse embutir a prévia.
 */

/** O tamanho máximo do texto que o roteiro relata por elemento. */
export const LIMITE_DO_TEXTO = 200

/**
 * O roteiro, com a origem do FRIGG cravada dentro.
 *
 * Ele é montado como texto porque é isso que ele é: o corpo de uma resposta
 * `application/javascript`. A origem entra por `JSON.stringify`, e não por
 * concatenação, para nenhuma aspa dela poder fechar a cadeia e virar código.
 * @param studioOrigin - a origem exata do FRIGG.
 * @returns o corpo do roteiro.
 */
export function scriptDeSelecao(studioOrigin: string): string {
  const origem = JSON.stringify(studioOrigin)
  const limite = String(LIMITE_DO_TEXTO)
  return `"use strict";(function(){`
    + `var ligado=false;var realce=null;`
    // O realce é um contorno desenhado no próprio elemento e desfeito na saída:
    // nada é acrescentado ao documento do aplicativo, então nada sobra nele.
    + `function marcar(alvo){if(realce&&realce!==alvo){realce.style.outline="";}`
    + `realce=alvo;if(alvo){alvo.style.outline="2px solid #7c3aed";}}`
    + `function sobre(evento){if(!ligado)return;marcar(evento.target);}`
    + `function escolher(evento){if(!ligado)return;`
    // `capture` + `preventDefault` + `stopPropagation`: com a seleção ligada, o
    // clique é DA SELEÇÃO, e não do aplicativo. Sem isso, escolher o botão
    // "Reiniciar" reiniciaria o jogo enquanto a pessoa só queria apontá-lo.
    + `evento.preventDefault();evento.stopPropagation();`
    + `var alvo=evento.target;if(!alvo||!alvo.tagName)return;`
    + `window.parent.postMessage({type:"DZ23_PREVIEW_SELECT",`
    + `tag:String(alvo.tagName).toLowerCase(),`
    + `text:String(alvo.textContent||"").trim().slice(0,${limite}),`
    + `path:String(window.location.pathname||"/")},${origem});`
    + `ligado=false;marcar(null);}`
    + `window.addEventListener("message",function(evento){`
    // As DUAS conferências. A origem sozinha aceitaria qualquer aba daquele
    // host; a janela sozinha aceitaria qualquer origem que embutisse a prévia.
    + `if(evento.origin!==${origem}||evento.source!==window.parent)return;`
    + `var corpo=evento.data;if(!corpo||corpo.type!=="DZ23_PREVIEW_SELECT_MODE")return;`
    + `ligado=corpo.on===true;if(!ligado)marcar(null);});`
    + `document.addEventListener("mouseover",sobre,true);`
    + `document.addEventListener("click",escolher,true);`
    + `})();`
}

/** Onde o roteiro é servido. */
export const CAMINHO_DO_ROTEIRO = '/__dz23/selecao.js'

/**
 * A etiqueta que o roteiro ganha dentro da página.
 *
 * Montada por junção a partir do caminho, e não escrita inteira: assim o
 * endereço existe UMA vez, e quem serve e quem injeta não podem discordar.
 */
export const TAG_DO_ROTEIRO = ['<script src="', CAMINHO_DO_ROTEIRO, '" defer></script>'].join('')

/**
 * A página com o roteiro dentro, quando ela é uma página.
 *
 * ## O que esta função se recusa a fazer
 *
 * Reescrever bytes de uma resposta que não pediu para ser reescrita é como se
 * quebra um aplicativo de um jeito que ninguém consegue depurar: o código-fonte
 * está certo, o navegador mostra outra coisa. Por isso a inserção acontece
 * apenas quando TODAS as condições valem — é HTML, tem `</body>`, e o roteiro
 * ainda não está lá — e, em qualquer outro caso, o corpo volta intacto, byte
 * por byte.
 *
 * A inserção é ANTES do `</body>` final, e não do primeiro: um documento pode
 * trazer `</body>` dentro de um texto, e quem fecha o corpo é o último.
 * @param corpo - o corpo devolvido pelo aplicativo.
 * @param contentType - o tipo declarado pela resposta.
 * @returns o corpo, com ou sem o roteiro.
 */
export function comRoteiroDeSelecao(corpo: Buffer, contentType: string | undefined): Buffer {
  if (contentType === undefined || !/^text\/html\b/iu.test(contentType.trim())) return corpo
  const texto = corpo.toString('utf8')
  if (texto.includes(TAG_DO_ROTEIRO)) return corpo
  const fim = texto.lastIndexOf('</body>')
  if (fim < 0) return corpo
  return Buffer.from(`${texto.slice(0, fim)}${TAG_DO_ROTEIRO}${texto.slice(fim)}`, 'utf8')
}
