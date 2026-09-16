/**
 * O teto de tentativas de conferência de código, POR E-MAIL.
 *
 * Ele existia por REGISTRO, e um teto por registro não é um teto de conta: cada
 * `/magic/start` cria um registro novo com `attempts: 0`, então cinco reenvios
 * davam vinte e cinco palpites, e mais endereços davam mais.
 *
 * Mas o motivo principal é outro, e é o achado que a revisão adversarial trouxe:
 * o teto por registro era um ORÁCULO DE EXISTÊNCIA. Quem não tem conta não
 * ganha registro nenhum — `requestMagicCode` devolve `suppressed` e não grava —,
 * e a conferência respondia `not-found` (404) para esse caso e `invalid` (401)
 * ou `locked` (429) para quem tem conta. O corpo era idêntico nos três; o
 * STATUS não. Todo o trabalho da OS-33 para igualar corpo e relógio em
 * `/magic/start` era desfeito pelo pedido seguinte.
 *
 * Contando POR E-MAIL, quem não existe percorre exatamente a mesma escada:
 * erra, erra, e trava — e a trava deixa de dizer que a conta existe.
 */
/** Quantas conferências erradas cabem numa janela antes da trava. */
export const MAX_FALHAS_DE_CONFERENCIA = 5;
/** Quanto tempo a trava dura, e também o tamanho da janela em que as falhas somam. */
export const JANELA_DE_CONFERENCIA_MS = 15 * 60_000;
/**
 * Quantos e-mails ficam vigiados ao mesmo tempo.
 *
 * O teto existe porque a chave é escolhida por quem ataca: sem ele, pedir
 * conferência para um milhão de endereços inventados seria um jeito de encher a
 * memória do Studio pela porta de entrada. Quando ele é alcançado, o registro
 * mais ANTIGO sai — nunca o que está travando alguém agora.
 */
export const MAX_EMAILS_VIGIADOS = 4_096;
/**
 * Se este e-mail está travado agora.
 * @param estado - o que se sabe sobre as falhas dele, ou `undefined`.
 * @param agora - o instante, em milissegundos.
 * @returns `true` quando a próxima conferência deve ser recusada sem ser feita.
 */
export function travado(estado, agora) {
    if (estado === undefined)
        return false;
    // A janela expira sozinha: uma trava que não passa vira uma forma de manter
    // outra pessoa para fora de graça, e o custo disso cai em quem não atacou.
    if (agora - estado.desde >= JANELA_DE_CONFERENCIA_MS)
        return false;
    return estado.falhas >= MAX_FALHAS_DE_CONFERENCIA;
}
/**
 * O estado depois de mais uma falha.
 * @param estado - o estado anterior, ou `undefined`.
 * @param agora - o instante, em milissegundos.
 * @returns o estado novo; a janela recomeça quando a anterior já passou.
 */
export function contarFalha(estado, agora) {
    if (estado === undefined || agora - estado.desde >= JANELA_DE_CONFERENCIA_MS)
        return { falhas: 1, desde: agora };
    return { falhas: estado.falhas + 1, desde: estado.desde };
}
/**
 * Tira do mapa o que já não vigia ninguém, e depois o mais antigo, até caber.
 *
 * Feito ANTES de inserir, e não quando o mapa já estourou: um teto conferido
 * depois da inserção é um teto que já foi ultrapassado.
 * @param mapa - o mapa de e-mails vigiados; alterado no lugar.
 * @param agora - o instante, em milissegundos.
 */
export function podar(mapa, agora) {
    for (const [chave, estado] of mapa) {
        if (agora - estado.desde >= JANELA_DE_CONFERENCIA_MS)
            mapa.delete(chave);
    }
    while (mapa.size >= MAX_EMAILS_VIGIADOS) {
        const antigo = mapa.keys().next();
        if (antigo.done === true)
            break;
        mapa.delete(antigo.value);
    }
}
