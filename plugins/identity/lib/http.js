import { t } from './i18n.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { truncateIp } from './crypto.js';
import { IdentityError } from './service.js';
import { CSRF_COOKIE, parseCookies, parseCookieValues, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_GENERATION_COOKIE, sessionCookieName, shadowCookieDeletions } from './cookies.js';
import { BASE_DA_IDENTIDADE, IDENTITY_ROUTE_CONTRACTS } from './rotas.js';
import { InMemoryIdentityRateLimiter, edgeForwardedAddress, estadoDaBorda, rateLimitBuckets, rateLimitKey } from './rate-limit.js';
const JSON_LIMIT = 64 * 1024;
export const COOKIE_HEADER_LIMIT_BYTES = 8 * 1024;
const COOKIE_HEADER_TOO_LARGE = 'COOKIE_HEADER_TOO_LARGE';
const IDENTITY_INTERNAL_ERROR = 'IDENTITY_INTERNAL_ERROR';
class IdentityHttpInputError extends Error {
}
class CookieHeaderBudgetError extends Error {
}
export { CAMINHOS_DA_REMOCAO, CSRF_COOKIE, parseCookies, parseCookieValues, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_GENERATION_COOKIE, sessionCookieName, shadowCookieDeletions } from './cookies.js';
const emailSchema = z.object({ email: z.email() }).strict();
const magicStartSchema = emailSchema;
const magicVerifySchema = emailSchema.extend({
    code: z.string().regex(/^\d{6}$/),
    device_label: z.string().min(1).max(100),
}).strict();
const challengeSchema = z.object({ challenge_id: z.string().min(1), response: z.unknown() }).strict();
const registerVerifySchema = challengeSchema.extend({ device_label: z.string().min(1).max(100) }).strict();
const revokeSchema = z.object({ session_id: z.string().min(1) }).strict();
export { BASE_DA_IDENTIDADE, IDENTITY_ROUTE_CONTRACTS, caminhosAlcancaveis } from './rotas.js';
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
export function serializeSessionCookies(token, csrfToken, secure = true) {
    void csrfToken;
    const value = encodeURIComponent(token);
    if (secure) {
        return [
            `${SECURE_SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`,
            `${CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        ];
    }
    return [
        // O forte primeiro. `Secure` sem TLS é aceito nos endereços de contexto
        // seguro, que são os únicos que este modo permite.
        `${SECURE_SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`,
        // E o simples, como rede para o navegador que recusar o de cima.
        `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/`,
        `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
    ];
}
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
export function clearSessionCookies(secure = true, host) {
    const secureAttribute = secure ? '; Secure' : '';
    return [
        // OS DOIS NOMES, sempre. Em modo http a sessão é emitida nos dois (ver
        // `serializeSessionCookies`), e limpar só um deixaria a pessoa "saída" com
        // uma sessão ainda válida no outro.
        `${SECURE_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        `${SESSION_COOKIE}=; HttpOnly${secureAttribute}; SameSite=Lax; Path=/; Max-Age=0`,
        `${SESSION_GENERATION_COOKIE}=${secureAttribute}; SameSite=Strict; Path=/; Max-Age=0`,
        `${CSRF_COOKIE}=${secureAttribute}; SameSite=Lax; Path=/; Max-Age=0`,
        ...shadowCookieDeletions(host, SESSION_COOKIE),
    ];
}
export function createIdentityHttpHandler(config) {
    const limiter = config.rateLimiter ?? new InMemoryIdentityRateLimiter();
    // Por HANDLER e não por módulo: dois Studios montados no mesmo processo são
    // duas instalações, e a borda muda de uma não diz nada sobre a outra.
    let bordaMudaJaAvisada = false;
    const secureCookies = config.secureCookies !== false;
    const createSessionGeneration = config.createSessionGeneration ?? (() => randomBytes(16).toString('hex'));
    return async (request, response) => {
        try {
            assertCookieHeaderBudget(request);
            await assertEdgeTrust(request, config);
            assertRequestTrust(request, config);
            /* v8 ignore next -- node:http always supplies a URL for server requests. */
            const path = new URL(request.url ?? '/', 'http://local').pathname;
            const route = path.slice(BASE_DA_IDENTIDADE.length);
            if (!IDENTITY_ROUTE_CONTRACTS.some(contract => contract.method === request.method && contract.path === route)) {
                json(response, 404, { error: t('http.routeNotFound') });
                return;
            }
            // O ÚLTIMO hop, e não o primeiro: o primeiro é o que o cliente mandou.
            const forwardedAddress = config.edgeRequired === true
                ? edgeForwardedAddress(singleHeader(request.headers['x-forwarded-for']))
                : undefined;
            // LIMITE CONHECIDO, e ele NÃO foi consertado aqui de propósito.
            //
            // Com borda obrigatória e sem `X-Forwarded-For`, `forwardedAddress` é
            // `undefined` e a chave cai em `request.socket.remoteAddress` — que
            // atrás de uma borda é o endereço DA BORDA. Todos os clientes caem no
            // MESMO balde, e o teto global de 300 por minuto vira o teto da
            // instalação inteira: um visitante qualquer tranca todo mundo para fora
            // sem fazer nada de errado.
            //
            // Não é brecha (a direção é mais restrição, não menos), e o cliente não
            // consegue apagar um cabeçalho que a borda escreve. É indisponibilidade
            // por configuração errada da borda.
            //
            // Recusar o pedido seria a falha alta e barulhenta que este repositório
            // prefere — mas mudaria o contrato de `edgeRequired` (passaria a EXIGIR
            // o cabeçalho), e há caminho coberto por teste que depende de subir sem
            // ele. Trocar contrato de configuração é decisão do Prado, não minha:
            // está registrado em OS-38 com o próximo passo.
            // A FALHA DE CONFIGURAÇÃO deixa de ser silenciosa.
            //
            // O contrato de `edgeRequired` continua o mesmo — o pedido não é recusado,
            // porque recusar mudaria o contrato e isso é decisão do Prado. O que muda
            // é que a instalação com borda obrigatória e borda MUDA passa a DIZER
            // isso, uma vez, em vez de todo mundo descobrir por um bloqueio que não
            // se explica. "Não esconda falha ambiental" é regra da casa.
            //
            // Uma vez por processo, e não por pedido: um aviso por requisição num
            // limitador é o próprio aviso virando o problema.
            if (estadoDaBorda(config.edgeRequired === true, forwardedAddress) === 'BORDA_MUDA' && !bordaMudaJaAvisada) {
                bordaMudaJaAvisada = true;
                console.warn(t('http.edgeSilent'));
            }
            const key = rateLimitKey(request, forwardedAddress);
            for (const bucket of rateLimitBuckets(route)) {
                const decision = limiter.consume(bucket, key);
                if (!decision.allowed) {
                    response.setHeader('retry-after', String(decision.retryAfterSeconds));
                    response.setHeader('x-ratelimit-limit', String(decision.limit));
                    response.setHeader('x-ratelimit-remaining', '0');
                    json(response, 429, { error: t('http.tooManyAttempts') });
                    return;
                }
            }
            if (request.method === 'POST' && route === '/magic/start') {
                const body = magicStartSchema.parse(await readJson(request));
                await config.service.requestMagicCode(body.email);
                json(response, 202, { message: t('http.magicAccepted') });
                return;
            }
            if (request.method === 'POST' && route === '/magic/verify') {
                const body = magicVerifySchema.parse(await readJson(request));
                const issued = await config.service.verifyMagicCode(body.email, body.code, deviceOf(request, body.device_label));
                const sessionGeneration = createSessionGeneration();
                /* v8 ignore next -- guarda defensiva sobre createSessionGeneration, que sempre devolve 32 hex; o braço de falha existe para falhar fechado se essa invariante mudar, e não é acionável por teste. */
                if (!/^[a-f0-9]{32}$/u.test(sessionGeneration))
                    throw new TypeError();
                response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken, secureCookies));
                json(response, 200, { session_id: issued.session.session_id, csrf_token: issued.csrfToken, session_generation: sessionGeneration });
                return;
            }
            if (request.method === 'POST' && route === '/passkey/login/options') {
                const body = emailSchema.parse(await readJson(request));
                json(response, 200, await config.service.beginPasskeyLogin(body.email));
                return;
            }
            if (request.method === 'POST' && route === '/passkey/login/verify') {
                const body = challengeSchema.parse(await readJson(request));
                const issued = await config.service.finishPasskeyLogin(body.challenge_id, body.response, deviceOf(request, 'Chave de acesso'));
                const sessionGeneration = createSessionGeneration();
                /* v8 ignore next -- guarda defensiva sobre createSessionGeneration, que sempre devolve 32 hex; o braço de falha existe para falhar fechado se essa invariante mudar, e não é acionável por teste. */
                if (!/^[a-f0-9]{32}$/u.test(sessionGeneration))
                    throw new TypeError();
                response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken, secureCookies));
                json(response, 200, { session_id: issued.session.session_id, csrf_token: issued.csrfToken, session_generation: sessionGeneration });
                return;
            }
            if (request.method === 'GET' && route === '/session') {
                const tokens = parseCookieValues(request.headers.cookie, sessionCookieName(secureCookies));
                if (tokens.length === 0) {
                    const principal = config.edgeRequired === true
                        ? undefined
                        : config.service.personalPrincipal(config.bindHost);
                    if (principal === undefined)
                        throw new IdentityError('invalid', t('http.signInToContinue'));
                    json(response, 200, { mode: 'personal', principal });
                    return;
                }
                const { session } = await authenticateCookieRequest(request, config.service, secureCookies, response);
                json(response, 200, { mode: 'authenticated', principal: principalOf(session) });
                return;
            }
            if (request.method === 'GET' && route === '/csrf') {
                const { session } = await authenticateCookieRequest(request, config.service, secureCookies, response);
                json(response, 200, { csrf_token: await config.service.csrfTokenFor(session) });
                return;
            }
            if (request.method === 'GET' && route === '/harness/session') {
                const identitySession = await authenticatedMutation(request, config.service, response);
                if (!config.service.isSharedHarnessClientAllowed(identitySession)) {
                    json(response, 403, { error: t('http.harnessUnavailable') });
                    return;
                }
                const host = singleHeader(request.headers.host);
                const forwardedProtocol = config.edgeRequired === true
                    ? singleHeader(request.headers['x-forwarded-proto'])
                    : undefined;
                const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
                    ? forwardedProtocol
                    : config.bindHost === '127.0.0.1' ? 'http' : 'https';
                const location = config.harnessAuthenticationUrl?.(`${protocol}://${host}/`);
                if (location === undefined) {
                    json(response, 503, { error: t('http.harnessUnavailable') });
                    return;
                }
                response.writeHead(303, {
                    'cache-control': 'no-store',
                    location,
                    'referrer-policy': 'no-referrer',
                });
                response.end();
                return;
            }
            if (request.method === 'POST' && route === '/logout') {
                const candidates = [...new Set(parseCookieValues(request.headers.cookie, sessionCookieName(secureCookies)))];
                if (candidates.length > 64)
                    throw new IdentityError('invalid', t('http.signInToContinue'));
                if (candidates.length === 0) {
                    response.setHeader('set-cookie', clearSessionCookies(secureCookies, singleHeader(request.headers.host)));
                    json(response, 200, { signed_out: true });
                    return;
                }
                let authentication;
                try {
                    authentication = await authenticateCookieRequest(request, config.service, secureCookies, response);
                }
                catch (error) {
                    if (!(error instanceof IdentityError))
                        throw error;
                    response.setHeader('set-cookie', clearSessionCookies(secureCookies, singleHeader(request.headers.host)));
                    json(response, 200, { signed_out: true });
                    return;
                }
                config.service.validateCsrfToken(authentication.session, singleHeader(request.headers['x-dz23-csrf']));
                await config.service.revokeSession(authentication.session, authentication.session.session_id);
                response.setHeader('set-cookie', clearSessionCookies(secureCookies, singleHeader(request.headers.host)));
                json(response, 200, { signed_out: true });
                return;
            }
            const authentication = await authenticateCookieRequest(request, config.service, secureCookies, response);
            const session = authentication.session;
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                config.service.validateCsrfToken(session, singleHeader(request.headers['x-dz23-csrf']));
            }
            if (request.method === 'POST' && route === '/passkey/register/options') {
                json(response, 200, await config.service.beginPasskeyRegistration(authentication.token));
                return;
            }
            if (request.method === 'POST' && route === '/passkey/register/verify') {
                const body = registerVerifySchema.parse(await readJson(request));
                await config.service.finishPasskeyRegistration(authentication.token, body.challenge_id, body.response, body.device_label);
                json(response, 200, { message: t('http.passkeyCreated') });
                return;
            }
            if (request.method === 'POST' && route === '/passkey/step-up/options') {
                json(response, 200, await config.service.beginStepUp(authentication.token));
                return;
            }
            if (request.method === 'POST' && route === '/passkey/step-up/verify') {
                const body = challengeSchema.parse(await readJson(request));
                await config.service.finishStepUp(authentication.token, body.challenge_id, body.response);
                json(response, 200, { message: t('http.sensitiveConfirmed') });
                return;
            }
            if (request.method === 'GET' && route === '/devices') {
                json(response, 200, { devices: config.service.listDevices(session.user_id) });
                return;
            }
            if (request.method === 'POST' && route === '/devices/revoke') {
                const body = revokeSchema.parse(await readJson(request));
                await config.service.revokeSession(session, body.session_id);
                if (body.session_id === session.session_id)
                    response.setHeader('set-cookie', clearSessionCookies(secureCookies, singleHeader(request.headers.host)));
                json(response, 200, { message: t('http.deviceDisconnected') });
                return;
            }
            /* v8 ignore next -- last contracted route: the false side is unreachable because every other contract returns above. O teste percorre IDENTITY_ROUTE_CONTRACTS e prova que nenhuma rota contratada cai na cauda 404. */
            if (request.method === 'POST' && route === '/devices/revoke-all') {
                await config.service.revokeAllSessions(session);
                response.setHeader('set-cookie', clearSessionCookies(secureCookies, singleHeader(request.headers.host)));
                json(response, 200, { message: t('http.allDevicesDisconnected') });
                return;
            }
            /* v8 ignore next 2 -- every contracted route returns above; this is the fail-closed tail. */
            json(response, 404, { error: t('http.routeNotFound') });
        }
        catch (error) {
            if (error instanceof CookieHeaderBudgetError) {
                json(response, 431, { error: COOKIE_HEADER_TOO_LARGE });
                return;
            }
            if (error instanceof IdentityError) {
                const status = error.code === 'not-found' ? 404 : error.code === 'locked' ? 429 : 401;
                json(response, status, { error: error.message });
                return;
            }
            if (error instanceof z.ZodError || error instanceof IdentityHttpInputError) {
                json(response, 400, { error: error instanceof IdentityHttpInputError ? error.message : t('http.invalidRequest') });
                return;
            }
            json(response, 500, { error: IDENTITY_INTERNAL_ERROR });
        }
    };
}
export async function authenticatedMutation(request, service, response) {
    assertCookieHeaderBudget(request);
    // Host e Origin, para TODA rota autenticada — e não só para as da identidade.
    const mutating = request.method !== 'GET' && request.method !== 'HEAD';
    service.assertRequestTrust(singleHeader(request.headers.host), singleHeader(request.headers.origin), mutating);
    /*
      A PORTA DO MODO PESSOAL, e ela fica AQUI porque aqui é o lugar único.
  
      O FRIGG baixado e aberto não tem ninguém registrado: `COMECAR.md` não tem
      passo de login, e `GET /session` já respondia `{"mode":"personal"}`. As
      rotas de trabalho, porém, passavam por esta função e exigiam cookie — então
      o produto ABRIA e não CRIAVA. Medido em 18/09/2026, no primeiro dia em que
      o produto montado subiu.
  
      Espalhar a decisão pelos onze chamadores faria uma segunda verdade sobre
      quem pode trabalhar, e ela divergiria no primeiro conserto de um deles.
  
      O QUE PROTEGE, já que não há CSRF para conferir: a conferência de `Host` e
      `Origin` logo acima, que roda ANTES desta porta e vale para todo método
      mutante. Um site qualquer no navegador da pessoa não consegue forjar
      `Origin`, e é exatamente esse o ataque que o token CSRF existe para barrar
      numa sessão de cookie. Sem cookie não há sessão a que prender um token, e
      inventar um seria teatro.
  
      A porta fecha sozinha assim que alguém se registra — `personalSession` volta
      a ser `undefined` e esta função recusa como sempre recusou.
    */
    // A chamada é OPCIONAL de propósito: um serviço que não ofereça o método —
    // um dublê de teste antigo, por exemplo — simplesmente não tem porta pessoal.
    // A ausência falha na direção SEGURA, que é a única direção em que a
    // tolerância se justifica.
    const pessoal = service.personalSession?.();
    if (pessoal !== undefined && singleSessionToken(request.headers.cookie, service.cookiesAreSecure, request, response) === undefined) {
        return pessoal;
    }
    const { session } = await authenticateCookieRequest(request, service, service.cookiesAreSecure, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        const header = singleHeader(request.headers['x-dz23-csrf']);
        service.validateCsrfToken(session, header);
    }
    return session;
}
export function requiredSessionToken(request, service, response) {
    assertCookieHeaderBudget(request);
    // Recusa a ambiguidade pelo mesmo motivo de `authenticateCookieRequest`:
    // pegar o `[0]` de dois cookies com o mesmo nome deixa QUEM ESCREVE O
    // CABEÇALHO escolher a sessão, e quem escreve pode não ser a pessoa.
    const token = singleSessionToken(request.headers.cookie, service.cookiesAreSecure, request, response);
    if (token === undefined)
        throw new IdentityError('invalid', t('http.signInToContinue'));
    return token;
}
/**
 * O ÚNICO token de sessão do pedido, ou nenhum.
 *
 * "Único" é o requisito, e ele substituiu um laço que tentava até 64 candidatos
 * e ficava com o PRIMEIRO que autenticasse. Esse laço era metade de um ataque:
 * quem conseguisse gravar um segundo cookie com o mesmo nome — subdomínio
 * irmão, ou injeção num HTTP em texto claro — bastava que o token DELE fosse
 * válido para ser aceito, mesmo com o cookie legítimo presente no mesmo
 * cabeçalho. A vítima seguia usando o Studio dentro da sessão do atacante, e
 * `POST /passkey/register/verify` gravava a chave de acesso do dispositivo
 * dela na conta DELE.
 *
 * Recusar a ambiguidade troca um roubo de conta por uma recusa de entrada: a
 * pessoa vê que não conseguiu entrar em vez de não ver nada. O prefixo
 * `__Host-` (ver `cookies.ts`) fecha a porta de gravar o segundo cookie; esta
 * função garante que, mesmo que alguém a abra de novo, ninguém escolhe QUAL
 * dos dois vale.
 *
 * RECUSAR SOZINHO NÃO BASTAVA, e a jornada em navegador real provou: em HTTP
 * claro, com prévias em subdomínio irmão, o aplicativo GERADO grava o cookie
 * sombra e a dona do Studio fica trancada para fora — sem gesto nenhum de
 * recuperação. Quando há `response`, a recusa vem ACOMPANHADA da remoção do
 * cookie do vizinho: o próximo pedido tem um valor só e volta a funcionar. Sem
 * `response` a função só recusa, que é o comportamento antigo e continua
 * seguro — só não se cura.
 * @param header - o cabeçalho `cookie` bruto.
 * @param secure - se os cookies desta instalação levam `Secure`.
 * @param request - o pedido, para descobrir os domínios-pai a limpar.
 * @param response - a resposta, quando dá para emitir a remoção.
 * @returns o token, ou `undefined` quando não há nenhum.
 * @throws IdentityError quando há mais de um valor distinto.
 */
function singleSessionToken(header, secure, request, response) {
    // O NOME COM PREFIXO TEM PRECEDÊNCIA, e quando ele está presente o simples
    // não é sequer olhado.
    //
    // É isto que fecha o plantio do vizinho, e não a remoção lá embaixo: o
    // navegador RECUSA gravar um `__Host-` com `Domain`, então o aplicativo
    // gerado numa prévia irmã não consegue produzir um valor deste nome. Quem
    // consegue é só o próprio host — e aí a ambiguidade voltou a ser o caso que
    // ela sempre foi: alguém com escrita no host, que já tem tudo.
    //
    // A remoção continua existindo para a instalação cujo navegador recusou o
    // `__Host-` e está autenticada pelo nome simples. Ela é rede, não a defesa.
    const strong = [...new Set(parseCookieValues(header, SECURE_SESSION_COOKIE))].filter(value => value !== '');
    if (strong.length > 1)
        throw new IdentityError('invalid', t('http.signInToContinue'));
    if (strong.length === 1)
        return strong[0];
    if (secure)
        return undefined;
    const name = SESSION_COOKIE;
    const values = [...new Set(parseCookieValues(header, name))].filter(value => value !== '');
    if (values.length > 1) {
        if (request !== undefined && response !== undefined && !response.headersSent) {
            const deletions = shadowCookieDeletions(singleHeader(request.headers.host), name);
            if (deletions.length > 0) {
                const existing = response.getHeader('set-cookie');
                const current = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
                response.setHeader('set-cookie', [...current, ...deletions]);
            }
        }
        throw new IdentityError('invalid', t('http.signInToContinue'));
    }
    return values[0];
}
async function authenticateCookieRequest(request, service, secure, response) {
    assertCookieHeaderBudget(request);
    const token = singleSessionToken(request.headers.cookie, secure, request, response);
    if (token === undefined)
        throw new IdentityError('invalid', t('http.signInToContinue'));
    return { token, session: await service.authenticate(token) };
}
async function assertEdgeTrust(request, config) {
    if (config.edgeRequired === true) {
        const actual = singleHeader(request.headers['x-dz23-edge']);
        const expected = await config.resolveEdgeSecret?.();
        if (actual === undefined || expected === undefined || expected === '' || !secretMatches(actual, expected)) {
            throw new IdentityError('invalid', t('http.edgeUnauthorized'));
        }
    }
}
export function assertRequestTrust(request, config) {
    const host = singleHeader(request.headers.host)?.toLowerCase();
    if (host === undefined || !config.allowedHosts.map(value => value.toLowerCase()).includes(host)) {
        throw new IdentityError('invalid', t('http.hostNotAllowed'));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = singleHeader(request.headers.origin);
        if (origin === undefined || !config.allowedOrigins.includes(origin)) {
            throw new IdentityError('invalid', t('http.originNotAllowed'));
        }
    }
}
function secretMatches(actual, expected) {
    const actualDigest = createHash('sha256').update(actual).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(actualDigest, expectedDigest);
}
export function singleHeader(value) {
    return Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
}
function assertCookieHeaderBudget(request) {
    const header = request.headers.cookie;
    if (header !== undefined && Buffer.byteLength(header, 'utf8') > COOKIE_HEADER_LIMIT_BYTES) {
        throw new CookieHeaderBudgetError();
    }
}
export function deviceOf(request, label) {
    return {
        label,
        userAgent: singleHeader(request.headers['user-agent']) ?? '',
        ipTruncated: truncateIp(request.socket.remoteAddress),
    };
}
function principalOf(session) {
    return {
        userId: session.user_id,
        orgId: session.org_id,
        tenantId: session.tenant_id,
        sessionId: session.session_id,
    };
}
async function readJson(request) {
    if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) {
        throw new IdentityHttpInputError(t('http.jsonBodyRequired'));
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        /* v8 ignore next -- node:http request body chunks are Buffers. */
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > JSON_LIMIT)
            throw new IdentityHttpInputError(t('http.requestTooLarge'));
        chunks.push(bytes);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new IdentityHttpInputError(t('http.invalidJson'));
    }
}
function json(response, status, body) {
    /* v8 ignore next -- each handler owns exactly one response settlement. */
    if (response.writableEnded)
        return;
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
}
