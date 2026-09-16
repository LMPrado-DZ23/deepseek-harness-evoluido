import { createHash } from 'node:crypto';
export const IDENTITY_RATE_LIMITS = {
    global: { limit: 300, windowMs: 60_000 },
    'magic-start': { limit: 5, windowMs: 15 * 60_000 },
    'magic-verify': { limit: 10, windowMs: 60_000 },
    passkey: { limit: 20, windowMs: 60_000 },
};
/** Per-process limiter. A multi-instance deployment must replace this with a shared atomic store. */
export class InMemoryIdentityRateLimiter {
    #attempts = new Map();
    consume(bucket, key, now = Date.now()) {
        const rule = IDENTITY_RATE_LIMITS[bucket];
        const recordKey = `${bucket}:${key}`;
        const cutoff = now - rule.windowMs;
        const recent = (this.#attempts.get(recordKey) ?? []).filter(timestamp => timestamp > cutoff);
        if (recent.length >= rule.limit) {
            this.#attempts.set(recordKey, recent);
            return {
                allowed: false,
                limit: rule.limit,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + rule.windowMs - now) / 1000)),
            };
        }
        recent.push(now);
        this.#attempts.set(recordKey, recent);
        return {
            allowed: true,
            limit: rule.limit,
            remaining: rule.limit - recent.length,
            retryAfterSeconds: 0,
        };
    }
}
export function rateLimitBuckets(route) {
    if (route === '/magic/start')
        return ['global', 'magic-start'];
    if (route === '/magic/verify')
        return ['global', 'magic-verify'];
    if (route.startsWith('/passkey/'))
        return ['global', 'passkey'];
    return ['global'];
}
/**
 * O endereço que a BORDA afirmou, num `X-Forwarded-For`.
 *
 * O primeiro elemento do cabeçalho é o que o CLIENTE mandou: um proxy
 * acrescenta o endereço observado ao final, não substitui o que veio. Ler o
 * primeiro elemento era, portanto, deixar o cliente escolher o próprio balde do
 * limitador — três valores forjados, três baldes distintos, e os limites de
 * `magic-start`, `magic-verify` e `passkey` viravam decoração.
 *
 * O ÚLTIMO elemento é o que a borda confiável escreveu, e é o único que um
 * cliente não consegue empurrar. (A borda do Studio também passou a
 * SUBSTITUIR o cabeçalho, em vez de acrescentar; isto aqui é a defesa que
 * sobrevive a uma borda reconfigurada.)
 * @param header - o valor bruto do cabeçalho, ou `undefined`.
 * @returns o endereço da borda, ou `undefined` quando não há nenhum utilizável.
 */
export function edgeForwardedAddress(header) {
    if (header === undefined)
        return undefined;
    const hops = header.split(',').map(hop => hop.trim()).filter(hop => hop !== '');
    return hops.at(-1);
}
/** O que se sabe sobre a borda num pedido. Nenhum destes colapsa em outro. */
export const ESTADOS_DA_BORDA = ['SEM_BORDA', 'BORDA_IDENTIFICOU', 'BORDA_MUDA'];
/**
 * O que a borda disse — ou não disse — sobre quem está do outro lado.
 *
 * `BORDA_MUDA` é o estado que ESTAVA INVISÍVEL, e ele é o mais caro dos três:
 * com borda obrigatória e sem `X-Forwarded-For`, a chave do limitador cai no
 * endereço do SOCKET, que atrás de uma borda é o endereço DA BORDA. Todos os
 * clientes caem no MESMO balde, e o teto global vira o teto da instalação
 * inteira — um visitante qualquer tranca todo mundo para fora sem fazer nada
 * de errado, e ninguém consegue descobrir por quê olhando os registros.
 *
 * Não é brecha: a direção é mais restrição, não menos, e o cliente não apaga um
 * cabeçalho que a borda escreve. É INDISPONIBILIDADE POR CONFIGURAÇÃO, e o que
 * este repositório não aceita é que ela seja silenciosa. Recusar o pedido seria
 * a falha alta e barulhenta que a casa prefere, mas isso mudaria o contrato de
 * `edgeRequired` — trocar contrato de configuração é decisão do Prado. Tornar a
 * falha VISÍVEL não é.
 * @param edgeRequired - se a montagem declara que há borda obrigatória.
 * @param enderecoDaBorda - o que `edgeForwardedAddress` devolveu.
 * @returns o estado.
 */
export function estadoDaBorda(edgeRequired, enderecoDaBorda) {
    if (!edgeRequired)
        return 'SEM_BORDA';
    return enderecoDaBorda === undefined || enderecoDaBorda === '' ? 'BORDA_MUDA' : 'BORDA_IDENTIFICOU';
}
/** Stable pseudonymous key. Session ids must come from server-side authentication, never from an untrusted cookie. */
export function rateLimitKey(request, forwardedAddress, authenticatedSessionId) {
    if (authenticatedSessionId !== undefined && authenticatedSessionId !== '')
        return digest(`session:${authenticatedSessionId}`);
    return digest(`address:${forwardedAddress === undefined || forwardedAddress === ''
        ? request.socket.remoteAddress ?? 'unknown'
        : forwardedAddress}`);
}
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
