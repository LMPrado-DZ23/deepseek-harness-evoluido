import type { IncomingMessage } from 'node:http';
export type IdentityRateLimitBucket = 'global' | 'magic-start' | 'magic-verify' | 'passkey';
export interface IdentityRateLimitRule {
    readonly limit: number;
    readonly windowMs: number;
}
export interface IdentityRateLimitDecision {
    readonly allowed: boolean;
    readonly limit: number;
    readonly remaining: number;
    readonly retryAfterSeconds: number;
}
export declare const IDENTITY_RATE_LIMITS: Readonly<Record<IdentityRateLimitBucket, IdentityRateLimitRule>>;
/** Per-process limiter. A multi-instance deployment must replace this with a shared atomic store. */
export declare class InMemoryIdentityRateLimiter {
    #private;
    consume(bucket: IdentityRateLimitBucket, key: string, now?: number): IdentityRateLimitDecision;
}
export declare function rateLimitBuckets(route: string): readonly IdentityRateLimitBucket[];
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
export declare function edgeForwardedAddress(header: string | undefined): string | undefined;
/** O que se sabe sobre a borda num pedido. Nenhum destes colapsa em outro. */
export declare const ESTADOS_DA_BORDA: readonly ["SEM_BORDA", "BORDA_IDENTIFICOU", "BORDA_MUDA"];
export type EstadoDaBorda = (typeof ESTADOS_DA_BORDA)[number];
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
export declare function estadoDaBorda(edgeRequired: boolean, enderecoDaBorda: string | undefined): EstadoDaBorda;
/** Stable pseudonymous key. Session ids must come from server-side authentication, never from an untrusted cookie. */
export declare function rateLimitKey(request: IncomingMessage, forwardedAddress?: string, authenticatedSessionId?: string): string;
//# sourceMappingURL=rate-limit.d.ts.map