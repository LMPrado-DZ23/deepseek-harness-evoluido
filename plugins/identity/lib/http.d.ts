import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionRecord } from './model.js';
import { type StudioIdentityService } from './service.js';
import { InMemoryIdentityRateLimiter } from './rate-limit.js';
export declare const COOKIE_HEADER_LIMIT_BYTES: number;
export { CAMINHOS_DA_REMOCAO, CSRF_COOKIE, parseCookies, parseCookieValues, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_GENERATION_COOKIE, sessionCookieName, shadowCookieDeletions } from './cookies.js';
export { BASE_DA_IDENTIDADE, IDENTITY_ROUTE_CONTRACTS, caminhosAlcancaveis } from './rotas.js';
export interface IdentityHttpConfig {
    readonly service: StudioIdentityService;
    readonly bindHost: '127.0.0.1' | '0.0.0.0';
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
    readonly edgeRequired?: boolean;
    readonly resolveEdgeSecret?: () => Promise<string | undefined>;
    readonly harnessAuthenticationUrl?: (baseUrl: string) => string | undefined;
    readonly rateLimiter?: InMemoryIdentityRateLimiter;
    readonly secureCookies?: boolean;
    readonly createSessionGeneration?: () => string;
}
/**
 * Os cookies de uma sessão recém-emitida.
 *
 * EM MODO HTTP O COOKIE VAI DUAS VEZES, e é assim de propósito.
 *
 * O modo `loopback-http` só é aceito quando todo endereço permitido é
 * `localhost`, `*.localhost` ou `127.0.0.1` (ver `assertLoopbackHttpCookies`) —
 * exatamente os endereços que o navegador trata como CONTEXTO SEGURO. Ali ele
 * aceita `Secure` sobre http.
 *
 * ACEITAR `Secure` SOBRE HTTP NÃO É ACEITAR O PREFIXO `__Host-`, e este
 * comentário já afirmou que sim. Medido nos dois Chromium, mesmo servidor,
 * mesmo endereço `studio.dz23.localhost` sem TLS:
 *
 * | Chromium | `Secure` sobre http | prefixo `__Host-` sobre http |
 * | --- | --- | --- |
 * | 133.0.6943.16 | aceita | RECUSA |
 * | 141.0.7390.37 | aceita | aceita |
 *
 * Onde o prefixo é aceito, `__Host-` COM `Domain` é recusado e o nome simples
 * com `Domain` é aceito — e é essa recusa que fecha o plantio do vizinho.
 * **Onde o prefixo é recusado, essa defesa não existe**, e sobra
 * `shadowCookieDeletions`, que a própria `cookies.ts` diz não ser a defesa
 * porque não alcança `Path=/api`. Está registrado em `INTERNAL_BLOCKERS.md`.
 *
 * Essa última linha é o buraco: em `p-<hex>.dz23.localhost` roda o aplicativo
 * GERADO, que ninguém leu, e uma linha de `document.cookie` dele planta
 * `dz23_studio_session=<qualquer coisa>; Domain=dz23.localhost`. O nome com
 * prefixo é o único que ele NÃO consegue escrever.
 *
 * SEPARAR OS DOMÍNIOS foi implementado e MEDIDO em 18/09/2026, e não serve
 * enquanto a prévia for HTTP: o cookie de admissão dela é `SameSite=Strict`, e
 * um quadro de outro site é contexto cross-site — o navegador não o envia, a
 * troca do bilhete devolve `204` e o `GET /` seguinte volta `401`. `SameSite=None`
 * exige `Secure`, que exige TLS no host da prévia, e instalar CA raiz é
 * proibido. A separação está registrada em `T-37` como bloqueada em
 * certificado, e o que fecha o buraco sem TLS é a remoção alcançar o `Path`
 * que ela não alcançava.
 *
 * Emitir os dois, em vez de trocar de nome, é o que torna isto seguro de
 * aplicar: onde o navegador aceitar o `__Host-`, ele passa a ser o que vale e o
 * plantio do vizinho deixa de alcançar qualquer coisa; onde não aceitar — um
 * navegador que recuse `Secure` sobre http —, a sessão continua entrando pelo
 * nome simples, como antes. Ninguém fica sem conseguir entrar por causa desta
 * mudança.
 * @param token - o token da sessão.
 * @param csrfToken - mantido na assinatura por compatibilidade; não é emitido.
 * @param secure - se a instalação tem TLS.
 * @returns os valores de `Set-Cookie`.
 */
export declare function serializeSessionCookies(token: string, csrfToken: string, secure?: boolean): readonly string[];
/**
 * Os cookies a expirar quando a pessoa sai — e os do VIZINHO junto.
 *
 * `host` entra porque "sair" é o único gesto explícito de recuperação que a
 * pessoa tem, e ele não pode dizer "pronto, saiu" deixando de pé um cookie de
 * sessão que um subdomínio irmão plantou no domínio-pai. Sem isso, quem estava
 * trancada por um plantio continuava trancada depois de sair.
 * @param secure - se a instalação tem TLS.
 * @param host - o `Host` do pedido, para alcançar os domínios-pai.
 * @returns os valores de `Set-Cookie`.
 */
export declare function clearSessionCookies(secure?: boolean, host?: string): readonly string[];
export declare function createIdentityHttpHandler(config: IdentityHttpConfig): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export declare function authenticatedMutation(request: IncomingMessage, service: StudioIdentityService, response?: ServerResponse): Promise<SessionRecord>;
export declare function requiredSessionToken(request: IncomingMessage, service: StudioIdentityService, response?: ServerResponse): string;
export declare function assertRequestTrust(request: IncomingMessage, config: Pick<IdentityHttpConfig, 'allowedHosts' | 'allowedOrigins'>): void;
export declare function singleHeader(value: string | string[] | undefined): string | undefined;
export declare function deviceOf(request: IncomingMessage, label: string): {
    label: string;
    userAgent: string;
    ipTruncated: string;
};
//# sourceMappingURL=http.d.ts.map