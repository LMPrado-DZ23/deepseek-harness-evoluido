import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { newMagicCode, newOpaqueSecret, secretHash, secretMatches } from './crypto.js';
import { KeyedMutex } from './mutex.js';
import { t } from './i18n.js';
import { contarFalha, podar, travado } from './verify-attempts.js';
const MINUTE = 60_000;
/**
 * A device session indexes the Assistant conversations opened from it. The list
 * is bounded so an authenticated caller cannot grow one session record without
 * limit. Reaching the ceiling refuses the new binding with an explained error;
 * nothing is dropped to make room, because dropping a live pointer would cost
 * the person a conversation they can still use. Pointers leave the list only
 * through `releaseHarnessSession`, which the launcher calls after the Harness
 * proved the conversation no longer exists.
 */
const MAX_HARNESS_SESSION_BINDINGS = 8;
const DAY = 24 * 60 * MINUTE;
const CHALLENGE_TTL = 5 * MINUTE;
const MAGIC_TTL = 10 * MINUTE;
const SLIDING_TTL = 14 * DAY;
const ABSOLUTE_TTL = 90 * DAY;
const STRONG_AUTH_TTL = 5 * MINUTE;
const MAX_MAGIC_ATTEMPTS = 5;
const SESSION_TOUCH_INTERVAL = MINUTE;
/**
 * O token CSRF de uma sessão.
 *
 * Com semente, ele é `sha256(v2 : token : semente)` — trocar a semente troca o
 * token sem derrubar a sessão. Sem semente (sessão antiga), continua o valor
 * derivado só do token, para essas sessões seguirem funcionando até expirarem.
 */
function derivedCsrfToken(tokenHash, seed) {
    return seed === undefined
        ? secretHash(`dz23-csrf-v1:${tokenHash}`)
        : secretHash(`dz23-csrf-v2:${tokenHash}:${seed}`);
}
/**
 * Campos do registro de sessão que NUNCA atravessam para a rede.
 *
 * Constante exportada e não um recorte na montagem: `csrf_seed` ficou de fora
 * do recorte por ter nascido depois dele.
 */
export const CAMPOS_PRIVADOS_DA_SESSAO = ['token_hash', 'csrf_hash', 'csrf_seed'];
export class IdentityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class StudioIdentityService {
    /**
     * Os endereços que a borda aceita, para conferir Host e Origin.
     *
     * `authenticatedMutation` é a porta de entrada de SEIS plugins (tenancy,
     * prompt-to-app, studio-web, route-health, stuck-runs, team-panel) e conferia
     * só o `x-dz23-csrf`. A checagem de origem que a própria identidade faz nas
     * rotas dela não valia para nenhuma dessas. O cabeçalho customizado exige
     * preflight e a resposta não traz cabeçalho CORS, então a defesa não estava
     * furada — mas ela dependia de uma propriedade do navegador, e não de uma
     * conferência do produto.
     */
    #requestTrust;
    #repository;
    #passkeys;
    #emailSender;
    #rpName;
    #rpId;
    #expectedOrigin;
    #defaultOrgId;
    #defaultTenantId;
    #enrollment;
    #personalModeAllowed;
    #now;
    #createId;
    #createSecret;
    #createMagicCode;
    /** Falhas de conferência de código POR E-MAIL, para o teto não ser um oráculo de existência. */
    #falhasDeConferencia = new Map();
    #mutex = new KeyedMutex();
    #enrollmentResolver = () => undefined;
    #userProvisioner = () => Promise.resolve();
    constructor(options) {
        this.#repository = options.repository;
        this.#passkeys = options.passkeys;
        this.#emailSender = options.emailSender;
        this.#rpName = options.rpName;
        this.#rpId = options.rpId;
        this.#expectedOrigin = options.expectedOrigin;
        this.#defaultOrgId = options.defaultOrgId;
        this.#defaultTenantId = options.defaultTenantId;
        this.#enrollment = typeof options.enrollment === 'string'
            ? options.enrollment
            : { mode: 'bootstrap-email', email: normalizeEmail(options.enrollment.email) };
        this.#personalModeAllowed = options.personalModeAllowed ?? true;
        this.#now = options.now ?? (() => new Date());
        this.#createId = options.createId ?? randomUUID;
        this.#createSecret = options.createSecret ?? newOpaqueSecret;
        this.#createMagicCode = options.createMagicCode ?? newMagicCode;
    }
    isPersonalMode(bindHost) {
        return this.#personalModeAllowed && bindHost === '127.0.0.1' && this.#repository.users().length === 0;
    }
    personalPrincipal(bindHost) {
        if (!this.isPersonalMode(bindHost))
            return undefined;
        return { userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local' };
    }
    /**
     * The upstream Harness browser cookie authenticates one process, not one
     * Studio identity. Expose that client only for a local installation with a
     * single registered person; team/server installations need a tenant-aware
     * transport instead of this process-wide cookie.
     */
    isSharedHarnessClientAllowed(session) {
        if (!this.#personalModeAllowed)
            return false;
        const users = this.#repository.users();
        return users.length === 1 && users[0]?.user_id === session.user_id;
    }
    isEnrollmentOpen(email) {
        if (this.#repository.users().length !== 0)
            return false;
        if (this.#enrollment === 'open')
            return true;
        return typeof this.#enrollment !== 'string'
            && email !== undefined
            && this.#enrollment.email === normalizeEmail(email);
    }
    setEnrollmentResolver(resolver) {
        const previous = this.#enrollmentResolver;
        this.#enrollmentResolver = resolver;
        return () => { this.#enrollmentResolver = previous; };
    }
    setUserProvisioner(provisioner) {
        const previous = this.#userProvisioner;
        this.#userProvisioner = provisioner;
        return () => { this.#userProvisioner = previous; };
    }
    userRecords() {
        return this.#repository.users();
    }
    sendInvitation(message) {
        return this.#emailSender.sendInvitation(message);
    }
    async requestMagicCode(email) {
        const normalized = normalizeEmail(email);
        return this.#mutex.run(`magic-request:${normalized}`, async () => {
            const existing = this.#repository.users().find(user => user.email === normalized);
            const grant = this.#enrollmentResolver(normalized);
            if (existing === undefined && !this.isEnrollmentOpen(normalized) && grant === undefined) {
                await this.#audit('magic_code_suppressed', null, null, this.#defaultOrgId, this.#defaultTenantId, 'failure', t('auth.genericRequestRefused'));
                return 'suppressed';
            }
            const code = this.#createMagicCode();
            if (!/^\d{6}$/.test(code))
                throw new IdentityError('invalid', t('auth.invalidGeneratedCode'));
            const now = this.#now();
            await Promise.all(this.#repository.magicCodes()
                .filter(previous => previous.email === normalized && previous.consumed_at === null)
                .map(previous => this.#repository.putMagicCode({ ...previous, consumed_at: now.toISOString() })));
            const orgId = existing?.org_id ?? grant?.orgId ?? this.#defaultOrgId;
            const tenantId = existing?.tenant_id ?? grant?.tenantId ?? this.#defaultTenantId;
            const record = {
                magic_code_id: this.#createId(),
                email: normalized,
                code_hash: secretHash(code),
                org_id: orgId,
                tenant_id: tenantId,
                attempts: 0,
                created_at: now.toISOString(),
                expires_at: new Date(now.getTime() + MAGIC_TTL).toISOString(),
                consumed_at: null,
            };
            await this.#repository.putMagicCode(record);
            // O ENVIO NAO SEGURA A RESPOSTA, e isso fecha um oraculo de TEMPO.
            //
            // O corpo da resposta ja era identico nos dois casos — 202 tanto para
            // quem tem conta quanto para quem nao tem, com o resultado descartado de
            // proposito na rota. Mas o RELOGIO entregava a mesma informacao: o ramo
            // suprimido fazia UMA escrita de auditoria e voltava, enquanto este aqui
            // esperava o SMTP, que em producao e sincrono e custa dezenas a centenas
            // de milissegundos. Medir o tempo respondia 'essa pessoa tem conta aqui?'
            // com folga.
            //
            // E uma falha de envio era um segundo oraculo, pior: ela SUBIA, e a rota
            // respondia com um status diferente de 202 — so para quem tem conta.
            // Agora ela e registrada e nao sobe: quem pediu o codigo nao tem o que
            // fazer com a excecao, e a trilha tem.
            void this.#emailSender.sendMagicCode({ to: normalized, code, expiresInMinutes: 10 })
                .catch(async () => {
                await this.#audit('magic_code_send_failed', existing?.user_id ?? null, null, orgId, tenantId, 'failure', t('auth.codeSendFailed'));
            })
                // O `catch` é `async`, e ninguém observa a promessa que ele devolve: se
                // a escrita da trilha também falhar — banco travado, disco cheio — o
                // resultado é `unhandledRejection`, cujo padrão do Node é derrubar o
                // processo. É preciso que o envio E o armazenamento falhem juntos, que
                // é exatamente o estado em que o Studio menos pode reiniciar em laço.
                .catch(() => undefined);
            await this.#audit('magic_code_requested', existing?.user_id ?? null, null, orgId, tenantId, 'success', t('auth.codeRequested'));
            return 'sent';
        });
    }
    async verifyMagicCode(email, code, device) {
        const normalized = normalizeEmail(email);
        return this.#mutex.run('magic-verify', async () => this.#verifyMagicCodeLocked(normalized, code, device));
    }
    async #verifyMagicCodeLocked(normalized, code, device) {
        const now = this.#now();
        const agora = now.getTime();
        // A TRAVA É CONFERIDA ANTES DE OLHAR O REGISTRO, e a ordem é o conserto.
        //
        // Quem não tem conta não ganha registro nenhum, e a conferência respondia
        // `not-found` (404) para esse caso e `invalid` (401) ou `locked` (429) para
        // quem tem. O corpo era idêntico nos três; o STATUS não — e todo o trabalho
        // da OS-33 para igualar corpo e relógio em `/magic/start` era desfeito pelo
        // pedido seguinte, com um par de chamadas por e-mail.
        //
        // Contando por E-MAIL, e travando antes de saber se existe registro, quem
        // não existe percorre exatamente a mesma escada: erra, erra, e trava.
        if (travado(this.#falhasDeConferencia.get(normalized), agora)) {
            throw new IdentityError('locked', t('auth.tooManyAttempts'));
        }
        const contar = async () => {
            podar(this.#falhasDeConferencia, agora);
            this.#falhasDeConferencia.set(normalized, contarFalha(this.#falhasDeConferencia.get(normalized), agora));
        };
        const candidate = this.#repository.magicCodes()
            .filter(record => record.email === normalized && record.consumed_at === null)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
        if (candidate === undefined) {
            await contar();
            await this.#audit('login_failed', null, null, 'org_unknown', 'tenant_unknown', 'failure', t('auth.codeMissing'));
            // `invalid` e não `not-found`: 'não existe código' e 'o código está
            // errado' são a mesma frase para quem pergunta, e tinham status
            // diferentes.
            throw new IdentityError('invalid', t('auth.codeInvalidOrExpired'));
        }
        if (Date.parse(candidate.expires_at) <= now.getTime()) {
            await contar();
            await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.codeExpired'));
            throw new IdentityError('expired', t('auth.codeInvalidOrExpired'));
        }
        if (candidate.attempts >= MAX_MAGIC_ATTEMPTS) {
            throw new IdentityError('locked', t('auth.tooManyAttempts'));
        }
        if (!secretMatches(code, candidate.code_hash)) {
            const attempts = candidate.attempts + 1;
            await contar();
            await this.#repository.putMagicCode({ ...candidate, attempts });
            await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.codeIncorrect'));
            throw new IdentityError(attempts >= MAX_MAGIC_ATTEMPTS ? 'locked' : 'invalid', t('auth.codeInvalidOrExpired'));
        }
        // Entrou: a escada zera. Manter a contagem depois de uma entrada legítima
        // travaria quem acabou de provar quem é.
        this.#falhasDeConferencia.delete(normalized);
        await this.#repository.putMagicCode({ ...candidate, consumed_at: now.toISOString() });
        const existing = this.#repository.users().find(user => user.email === normalized);
        const grant = this.#enrollmentResolver(normalized);
        const validGrant = grant !== undefined && grant.orgId === candidate.org_id && grant.tenantId === candidate.tenant_id;
        if (existing === undefined && !this.isEnrollmentOpen(normalized) && !validGrant) {
            await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.bootstrapClosed'));
            throw new IdentityError('invalid', t('auth.codeInvalidOrExpired'));
        }
        const source = validGrant ? 'invitation' : 'bootstrap';
        const user = existing ?? {
            user_id: this.#createId(),
            email: normalized,
            display_name: normalized.split('@')[0],
            bootstrap_owner: source === 'bootstrap',
            org_id: candidate.org_id,
            tenant_id: candidate.tenant_id,
            created_at: now.toISOString(),
        };
        if (existing === undefined) {
            await this.#repository.putUser(user);
            await this.#userProvisioner(user, source);
            if (source === 'bootstrap') {
                await this.#audit('personal_mode_disabled', user.user_id, null, user.org_id, user.tenant_id, 'success', t('auth.firstAccessRegistered'));
                await this.#audit('enrollment_closed', user.user_id, null, user.org_id, user.tenant_id, 'success', t('auth.bootstrapClosedAfterOwner'));
            }
        }
        const issued = await this.#issueSession(user, device);
        await this.#audit('login_succeeded', user.user_id, issued.session.session_id, user.org_id, user.tenant_id, 'success', t('auth.signedInWithCode'));
        return issued;
    }
    async authenticate(token, touch = true) {
        const located = this.#findSessionByToken(token);
        return this.#mutex.run(`session:${located.session_id}`, async () => {
            const session = this.#findSessionByToken(token);
            const now = this.#now();
            this.#assertSessionUsable(session, now);
            if (!touch)
                return session;
            if (now.getTime() - Date.parse(session.last_seen_at) < SESSION_TOUCH_INTERVAL)
                return session;
            const sliding = Math.min(now.getTime() + SLIDING_TTL, Date.parse(session.expires_absolute_at));
            const updated = {
                ...session,
                last_seen_at: now.toISOString(),
                expires_sliding_at: new Date(sliding).toISOString(),
            };
            await this.#repository.putSession(updated);
            return updated;
        });
    }
    validateCsrfToken(session, headerToken) {
        if (headerToken === undefined || !secretMatches(headerToken, session.csrf_hash)) {
            throw new IdentityError('csrf', t('auth.invalidConfirmation'));
        }
    }
    /**
     * Se os cookies desta instalação levam `Secure` — e portanto qual NOME o
     * cookie de sessão tem.
     *
     * Começa em `true` de propósito. O nome forte (`__Host-`) é o que fecha o
     * ataque de cookie sombra, e um serviço montado sem declarar a configuração
     * precisa cair no lado seguro: errar para o nome forte custa uma entrada
     * recusada em desenvolvimento; errar para o fraco custa uma conta.
     */
    #secureCookies = true;
    /**
     * Declara se os cookies levam `Secure`. O plugin chama isto ao montar.
     * @param secure - `false` somente no modo pessoal, em `http://127.0.0.1`.
     */
    setCookieSecurity(secure) {
        this.#secureCookies = secure;
    }
    /** Se os cookies desta instalação levam `Secure`. */
    get cookiesAreSecure() { return this.#secureCookies; }
    /**
     * Declara os endereços confiáveis. O plugin chama isto ao montar a borda.
     * @param trust - hosts e origens aceitos.
     */
    setRequestTrust(trust) {
        this.#requestTrust = trust;
    }
    /**
     * Se a confiança de requisição foi declarada.
     *
     * Ela é lida pelo teste que prova o cabeamento: `authenticatedMutation` só
     * confere Host e Origin quando a borda declarou os endereços, e uma declaração
     * esquecida é exatamente o tipo de coisa que ninguém nota — a rota continua
     * respondendo, só que sem a conferência.
     */
    get requestTrustConfigured() { return this.#requestTrust !== undefined; }
    /**
     * Recusa requisição de host ou origem que a borda não aceita.
     * @param host - o cabeçalho `Host`.
     * @param origin - o cabeçalho `Origin`, quando houver.
     * @param mutating - se o método muda estado.
     */
    assertRequestTrust(host, origin, mutating) {
        const trust = this.#requestTrust;
        if (trust === undefined) {
            // FALHA FECHADA para quem MUDA estado, e o motivo está escrito dez linhas
            // acima, sobre `#secureCookies`: "um serviço montado sem declarar a
            // configuração precisa cair no lado seguro". `#secureCookies` começa em
            // `true`; este começava em "não confere nada" — a mesma decisão, tomada
            // para os dois lados, no mesmo arquivo.
            //
            // Esta função é o ÚNICO ponto em que `Host` e `Origin` são conferidos
            // para as mutações autenticadas de todos os outros plugins, via
            // `authenticatedMutation`. Uma montagem que esqueça `setRequestTrust` —
            // um plugin novo, um harness alternativo, outra ordem de inicialização —
            // deixava todas elas com o cabeçalho `x-dz23-csrf` como única defesa, que
            // é exatamente a propriedade de navegador que este arquivo diz não querer
            // sozinha.
            //
            // Leitura continua passando: recusar leitura numa montagem não declarada
            // derruba o produto inteiro para consertar uma folga de escrita.
            if (mutating)
                throw new IdentityError('invalid', t('http.originNotAllowed'));
            return;
        }
        const normalized = host?.toLowerCase();
        if (normalized === undefined || !trust.allowedHosts.map(value => value.toLowerCase()).includes(normalized)) {
            throw new IdentityError('invalid', t('http.hostNotAllowed'));
        }
        if (mutating && (origin === undefined || !trust.allowedOrigins.includes(origin))) {
            throw new IdentityError('invalid', t('http.originNotAllowed'));
        }
    }
    async csrfTokenFor(session) {
        return this.#mutex.run(`session:${session.session_id}`, async () => {
            const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id);
            if (current === undefined)
                throw new IdentityError('invalid', t('auth.invalidSession'));
            this.#assertSessionUsable(current, this.#now());
            const csrfToken = derivedCsrfToken(current.token_hash, current.csrf_seed);
            const csrfHash = secretHash(csrfToken);
            if (current.csrf_hash !== csrfHash)
                await this.#repository.putSession({ ...current, csrf_hash: csrfHash });
            return csrfToken;
        });
    }
    /**
     * Os dispositivos da pessoa, sem NADA que ajude a forjar a sessão.
     *
     * A lista nomeava dois campos, e `csrf_seed` entrou no registro depois e ficou
     * de fora dela — saindo, por todas as sessões, em toda abertura da tela de
     * dispositivos, para cache de navegador, registro de proxy e captura de tela.
     * A semente sozinha não deriva o token (falta o `token_hash`), mas ela existe
     * justamente para que um vazamento pontual não valha os noventa dias da
     * sessão. Por isso a lista virou constante: um campo novo do registro tem de
     * ser acrescentado A ELA para sair, e não ficar de fora dela para sair.
     */
    listDevices(userId) {
        return this.#repository.sessions()
            .filter(session => session.user_id === userId)
            .map(session => {
            const visivel = { ...session };
            for (const campo of CAMPOS_PRIVADOS_DA_SESSAO)
                delete visivel[campo];
            return visivel;
        });
    }
    async revokeSession(actor, sessionId, reason = t('auth.revokedByUser')) {
        await this.#mutex.run(`session:${sessionId}`, async () => {
            const target = this.#repository.sessions().find(session => session.session_id === sessionId && session.user_id === actor.user_id);
            if (target === undefined)
                throw new IdentityError('not-found', t('auth.deviceNotFound'));
            if (target.revoked_at !== null)
                return;
            const revoked = { ...target, revoked_at: this.#now().toISOString(), revoked_reason: reason };
            await this.#repository.putSession(revoked);
            await this.#audit('session_revoked', actor.user_id, target.session_id, actor.org_id, actor.tenant_id, 'success', reason);
        });
    }
    /**
     * Encerra TODAS as sessões desta pessoa.
     *
     * A foto é tirada DUAS vezes, e a segunda é a que importa. A primeira versão
     * listava as sessões ativas fora de qualquer trava e revogava só aquelas:
     * uma sessão emitida ENTRE a foto e as escritas sobrevivia ao botão "sair de
     * todos os dispositivos" — que é exatamente o botão que a pessoa aperta
     * quando desconfia de invasão, e exatamente a sessão que ela quer derrubar.
     *
     * A segunda passada fecha a janela: ela relê depois das primeiras revogações
     * e alcança o que nasceu no meio. Duas passadas e não um laço até convergir,
     * porque um laço daria a quem estivesse emitindo sessões o poder de segurar
     * esta chamada para sempre.
     * @param actor - de quem são as sessões.
     */
    async revokeAllSessions(actor) {
        await this.#revokeEverySession(actor);
        await this.#revokeEverySession(actor);
        await this.#audit('all_sessions_revoked', actor.user_id, actor.session_id, actor.org_id, actor.tenant_id, 'success', t('auth.allSessionsRevoked'));
    }
    async #revokeEverySession(actor) {
        const activeIds = this.#repository.sessions()
            .filter(session => session.user_id === actor.user_id && session.revoked_at === null)
            .map(session => session.session_id);
        const now = this.#now().toISOString();
        await Promise.all(activeIds.map(sessionId => this.#mutex.run(`session:${sessionId}`, async () => {
            const current = this.#repository.sessions().find(session => session.session_id === sessionId && session.user_id === actor.user_id);
            if (current === undefined || current.revoked_at !== null)
                return;
            await this.#repository.putSession({
                ...current,
                revoked_at: now,
                revoked_reason: t('auth.signedOutAllDevices'),
            });
        })));
    }
    async bindHarnessSession(session, harnessSessionId) {
        if (harnessSessionId.trim() === '')
            throw new IdentityError('invalid', t('auth.invalidAgentSession'));
        await this.#mutex.run('harness-session-bindings', () => this.#mutex.run(`session:${session.session_id}`, async () => {
            const sessions = this.#repository.sessions();
            const current = sessions.find(candidate => candidate.session_id === session.session_id);
            if (current === undefined)
                throw new IdentityError('invalid', t('auth.invalidSession'));
            this.#assertSessionUsable(current, this.#now());
            const existing = sessions.filter(candidate => candidate.harness_session_ids.includes(harnessSessionId));
            if (existing.some(candidate => candidate.session_id !== current.session_id)) {
                await this.#audit('harness_session_bound', current.user_id, current.session_id, current.org_id, current.tenant_id, 'failure', t('assistant.bindingConflictAudit'));
                throw new IdentityError('replay', t('assistant.bindingConflict'));
            }
            if (current.harness_session_ids.includes(harnessSessionId))
                return;
            if (current.harness_session_ids.length >= MAX_HARNESS_SESSION_BINDINGS) {
                await this.#audit('harness_session_bound', current.user_id, current.session_id, current.org_id, current.tenant_id, 'failure', t('assistant.bindingQuotaAudit'));
                throw new IdentityError('invalid', t('assistant.bindingQuota'));
            }
            await this.#repository.putSession({
                ...current,
                harness_session_ids: [...current.harness_session_ids, harnessSessionId],
            });
            await this.#audit('harness_session_bound', current.user_id, current.session_id, current.org_id, current.tenant_id, 'success', t('auth.agentSessionBound'));
        }));
    }
    /**
     * Drops one conversation pointer from a device session. Only the launcher
     * calls this, and only after the Harness itself proved the conversation is
     * gone or is not an Assistant conversation. The audit row is written before
     * the session is rewritten, so a pointer never disappears unrecorded.
     */
    async releaseHarnessSession(session, harnessSessionId, reason) {
        if (harnessSessionId.trim() === '')
            throw new IdentityError('invalid', t('auth.invalidAgentSession'));
        await this.#mutex.run('harness-session-bindings', () => this.#mutex.run(`session:${session.session_id}`, async () => {
            const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id);
            if (current === undefined)
                throw new IdentityError('invalid', t('auth.invalidSession'));
            // A MESMA conferência que `bindHarnessSession` faz. Sem ela, uma sessão
            // revogada ou vencida ainda desvinculava ponteiros de conversa e gravava
            // a auditoria EM NOME DELA — trilha atribuída a uma sessão morta. A
            // direção é "menos acesso", então não havia escalada; o que havia era
            // assimetria entre vincular e desvincular, e um registro que mente sobre
            // quem agiu.
            this.#assertSessionUsable(current, this.#now());
            if (!current.harness_session_ids.includes(harnessSessionId))
                return;
            await this.#audit('harness_session_unbound', current.user_id, current.session_id, current.org_id, current.tenant_id, 'success', `${t('assistant.bindingReleasedAudit')} (${harnessSessionId}) ${reason}`.trim());
            await this.#repository.putSession({
                ...current,
                harness_session_ids: current.harness_session_ids.filter(candidate => candidate !== harnessSessionId),
            });
        }));
    }
    ownsHarnessSession(session, harnessSessionId) {
        if (harnessSessionId.trim() === '')
            return false;
        const bindings = this.#repository.sessions().filter(candidate => candidate.harness_session_ids.includes(harnessSessionId));
        if (bindings.length !== 1 || bindings[0]?.session_id !== session.session_id)
            return false;
        try {
            this.#assertSessionUsable(bindings[0], this.#now());
            return bindings[0].user_id === session.user_id
                && bindings[0].org_id === session.org_id
                && bindings[0].tenant_id === session.tenant_id;
        }
        catch {
            return false;
        }
    }
    #usableHarnessSessionBinding(harnessSessionId) {
        const bindings = this.#repository.sessions().filter(session => session.harness_session_ids.includes(harnessSessionId));
        if (bindings.length !== 1)
            return undefined;
        const session = bindings[0];
        try {
            this.#assertSessionUsable(session, this.#now());
            return session;
        }
        catch {
            return undefined;
        }
    }
    strongIdentityForHarnessSession(harnessSessionId) {
        const session = this.#usableHarnessSessionBinding(harnessSessionId);
        return session !== undefined && this.#strongAuthFresh(session);
    }
    /**
     * Identidade forte de uma sessão de identidade, pelo seu próprio
     * `session_id`. É o que a autoridade de confirmação de ações usa: ela conhece
     * a sessão do principal, não a sessão do Harness. Sessão inexistente,
     * revogada ou vencida não é identidade forte.
     * @param sessionId - identificador durável da sessão de identidade.
     * @returns verdadeiro só com chave de acesso recente naquela mesma sessão.
     */
    strongIdentityForSession(sessionId) {
        const session = this.#repository.sessions().find(candidate => candidate.session_id === sessionId);
        if (session === undefined)
            return false;
        try {
            this.#assertSessionUsable(session, this.#now());
        }
        catch {
            return false;
        }
        return this.#strongAuthFresh(session);
    }
    /**
     * Chave de acesso recente nesta sessão, dentro da janela de identidade forte.
     * @param session - o registro de sessão já verificado como utilizável.
     * @returns verdadeiro enquanto a autenticação forte ainda vale.
     */
    #strongAuthFresh(session) {
        return session.last_strong_auth_method === 'passkey'
            && session.last_strong_auth_at !== null
            && this.#now().getTime() - Date.parse(session.last_strong_auth_at) < STRONG_AUTH_TTL;
    }
    identityStateForHarnessSession(harnessSessionId, bindHost) {
        if (this.isPersonalMode(bindHost))
            return { authenticated: true, strongIdentityVerified: false };
        const authenticated = this.#usableHarnessSessionBinding(harnessSessionId) !== undefined;
        return {
            authenticated,
            strongIdentityVerified: authenticated && this.strongIdentityForHarnessSession(harnessSessionId),
        };
    }
    async beginPasskeyRegistration(token) {
        const session = await this.authenticate(token);
        const user = this.#user(session.user_id);
        const existing = this.#repository.credentials().filter(credential => credential.user_id === user.user_id);
        const options = await this.#passkeys.registrationOptions({
            rpName: this.#rpName,
            rpId: this.#rpId,
            userId: user.user_id,
            userName: user.email,
            excludeCredentialIds: existing.map(credential => credential.credential_id),
        });
        const challengeId = await this.#storeChallenge('registration', user.user_id, session.session_id, options.challenge);
        return { challengeId, options };
    }
    async finishPasskeyRegistration(token, challengeId, response, deviceLabel) {
        const session = await this.authenticate(token);
        await this.#withChallenge(challengeId, 'registration', session.user_id, session.session_id, async (challenge) => {
            const verified = await this.#passkeys.verifyRegistration({
                response,
                challengeMatches: value => secretMatches(value, challenge.challenge_hash),
                expectedOrigin: this.#expectedOrigin,
                expectedRpId: this.#rpId,
            });
            if (this.#repository.credentials().some(credential => credential.credential_id === verified.id)) {
                throw new IdentityError('replay', t('auth.passkeyAlreadyRegistered'));
            }
            await this.#repository.putCredential({
                credential_id: verified.id,
                user_id: session.user_id,
                public_key: Buffer.from(verified.publicKey).toString('base64url'),
                counter: verified.counter,
                transports: verified.transports,
                device_label: deviceLabel,
                created_at: this.#now().toISOString(),
                last_used_at: null,
            });
        });
        await this.#audit('passkey_registered', session.user_id, session.session_id, session.org_id, session.tenant_id, 'success', t('auth.passkeyRegistered'));
    }
    /**
     * Identificadores de chave de acesso FALSOS para um endereço que não tem
     * nenhuma — estáveis por processo e indistinguíveis dos reais.
     *
     * Existe porque `POST /passkey/login/options` é rota PÚBLICA e respondia com
     * `allowCredentials` cheio para quem tem chave e VAZIO para quem não tem.
     * Isso é enumeração de usuário a olho nu: o atacante anônimo descobre quem
     * tem conta, e de quebra recebe os `credential_id` reais, que são
     * identificadores estáveis do dispositivo. O caminho do código mágico foi
     * construído com esse cuidado — responde 202 idêntico nos dois casos —, e
     * aqui a propriedade tinha sido perdida.
     *
     * O tempero é sorteado UMA vez por processo, e é isso que impede o atacante
     * de calcular os falsos por conta própria: derivá-los só do endereço os
     * tornaria previsíveis, e comparar a resposta com o cálculo devolveria o
     * mesmo oráculo com mais passos.
     *
     * O LIMITE, dito em OS-33: eles mudam quando o processo reinicia, e um
     * identificador REAL não muda. Quem gravar respostas antes e depois de um
     * reinício ainda distingue os dois casos. Fechar isso exige um tempero
     * PERSISTIDO, que é custódia de segredo e decisão de operação.
     */
    #passkeyDecoySeed = randomBytes(32);
    #decoyCredentialIds(email) {
        // Duas: a quantidade mais comum entre quem registrou uma chave no celular
        // e outra no computador. Uma quantidade fixa não conta nada sobre ninguém,
        // e variá-la pelo endereço criaria um segundo canal.
        return [0, 1].map(index => createHash('sha256')
            .update(this.#passkeyDecoySeed)
            .update(`${email}\u0000${String(index)}`, 'utf8')
            .digest('base64url'));
    }
    async beginPasskeyLogin(email) {
        const normalized = normalizeEmail(email);
        const user = this.#repository.users().find(candidate => candidate.email === normalized);
        const userId = user?.user_id ?? `unknown-${this.#createId()}`;
        const credentials = this.#repository.credentials().filter(credential => credential.user_id === userId);
        const credentialIds = credentials.length > 0
            ? credentials.map(credential => credential.credential_id)
            : this.#decoyCredentialIds(normalized);
        const options = await this.#passkeys.authenticationOptions({
            rpId: this.#rpId,
            credentialIds,
            requireUserVerification: false,
        });
        const challengeId = await this.#storeChallenge('authentication', userId, null, options.challenge);
        return { challengeId, options };
    }
    async finishPasskeyLogin(challengeId, response, device) {
        return this.#withChallenge(challengeId, 'authentication', undefined, undefined, challenge => (this.#mutex.run(`credential:${response.id}`, async () => {
            const credential = this.#credentialForResponse(response.id, challenge.user_id);
            const verified = await this.#verifyAuthentication(response, challenge, credential, false);
            await this.#updateCounter(credential, verified.newCounter);
            const user = this.#user(challenge.user_id);
            const issued = await this.#issueSession(user, device);
            await this.#audit('login_succeeded', user.user_id, issued.session.session_id, user.org_id, user.tenant_id, 'success', t('auth.signedInWithPasskey'));
            return issued;
        })));
    }
    async beginStepUp(token) {
        const session = await this.authenticate(token);
        const credentials = this.#repository.credentials().filter(credential => credential.user_id === session.user_id);
        if (credentials.length === 0)
            throw new IdentityError('not-found', t('auth.passkeyRequiredBeforeConfirm'));
        const options = await this.#passkeys.authenticationOptions({
            rpId: this.#rpId,
            credentialIds: credentials.map(credential => credential.credential_id),
            requireUserVerification: true,
        });
        const challengeId = await this.#storeChallenge('step-up', session.user_id, session.session_id, options.challenge);
        return { challengeId, options };
    }
    async finishStepUp(token, challengeId, response) {
        const session = await this.authenticate(token);
        await this.#withChallenge(challengeId, 'step-up', session.user_id, session.session_id, challenge => (this.#mutex.run(`credential:${response.id}`, async () => {
            const credential = this.#credentialForResponse(response.id, session.user_id);
            const verified = await this.#verifyAuthentication(response, challenge, credential, true);
            if (!verified.userVerified)
                throw new IdentityError('invalid', t('auth.userVerificationMissing'));
            await this.#updateCounter(credential, verified.newCounter);
            await this.#mutex.run(`session:${session.session_id}`, async () => {
                const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id);
                if (current === undefined)
                    throw new IdentityError('invalid', t('auth.invalidSession'));
                this.#assertSessionUsable(current, this.#now());
                // A elevação TROCA o token CSRF. Sem isto, o valor que valia antes da
                // confirmação forte continuava valendo depois dela — e é justamente
                // depois dela que a sessão pode fazer o que é sensível.
                const seed = this.#createSecret();
                await this.#repository.putSession({
                    ...current,
                    csrf_seed: seed,
                    csrf_hash: secretHash(derivedCsrfToken(current.token_hash, seed)),
                    last_strong_auth_at: this.#now().toISOString(),
                    last_strong_auth_method: 'passkey',
                });
            });
        })));
        await this.#audit('step_up_succeeded', session.user_id, session.session_id, session.org_id, session.tenant_id, 'success', t('auth.strongIdentityConfirmed'));
    }
    auditRecords() {
        return this.#repository.audits();
    }
    sessionRecords() {
        return this.#repository.sessions();
    }
    userForSession(session) {
        return this.#user(session.user_id);
    }
    principalForHarnessSession(harnessSessionId) {
        const session = this.#usableHarnessSessionBinding(harnessSessionId);
        if (session === undefined)
            return undefined;
        try {
            const user = this.#user(session.user_id);
            return { userId: user.user_id, orgId: session.org_id, tenantId: session.tenant_id, sessionId: session.session_id };
        }
        catch {
            return undefined;
        }
    }
    recordAdministrationEvent(eventType, userId, orgId, tenantId, reason) {
        return this.#audit(eventType, userId, null, orgId, tenantId, 'success', reason);
    }
    async #issueSession(user, device) {
        const now = this.#now();
        const token = this.#createSecret();
        const tokenHash = secretHash(token);
        // Toda sessão NOVA nasce com semente. Sem isto, o ramo sem semente — que
        // existe para as sessões gravadas antes do campo — seria o padrão, e o
        // token CSRF voltaria a ser função imutável do token de sessão em todo
        // login novo. O legado é para o legado.
        const csrfSeed = this.#createSecret();
        const csrfToken = derivedCsrfToken(tokenHash, csrfSeed);
        const session = {
            session_id: this.#createId(),
            user_id: user.user_id,
            org_id: user.org_id,
            tenant_id: user.tenant_id,
            token_hash: tokenHash,
            csrf_hash: secretHash(csrfToken),
            csrf_seed: csrfSeed,
            device_label: device.label,
            user_agent: device.userAgent,
            ip_truncated: device.ipTruncated,
            created_at: now.toISOString(),
            last_seen_at: now.toISOString(),
            expires_sliding_at: new Date(now.getTime() + SLIDING_TTL).toISOString(),
            expires_absolute_at: new Date(now.getTime() + ABSOLUTE_TTL).toISOString(),
            last_strong_auth_at: null,
            last_strong_auth_method: null,
            revoked_at: null,
            revoked_reason: null,
            harness_session_ids: [],
        };
        await this.#repository.putSession(session);
        return { token, csrfToken, session };
    }
    #findSessionByToken(token) {
        if (token === '')
            throw new IdentityError('invalid', t('auth.invalidSession'));
        const tokenHash = secretHash(token);
        const session = this.#repository.sessions().find(candidate => candidate.token_hash === tokenHash);
        if (session === undefined)
            throw new IdentityError('invalid', t('auth.invalidSession'));
        return session;
    }
    #assertSessionUsable(session, now) {
        if (session.revoked_at !== null)
            throw new IdentityError('revoked', t('auth.sessionEnded'));
        if (Date.parse(session.expires_absolute_at) <= now.getTime())
            throw new IdentityError('expired', t('auth.sessionExpired'));
        if (Date.parse(session.expires_sliding_at) <= now.getTime())
            throw new IdentityError('expired', t('auth.sessionIdleExpired'));
    }
    #user(userId) {
        const user = this.#repository.users().find(candidate => candidate.user_id === userId);
        if (user === undefined)
            throw new IdentityError('not-found', t('auth.userNotFound'));
        return user;
    }
    /**
     * A credencial daquela resposta, DESTE usuário.
     *
     * A recusa é `invalid` e não `not-found`, e a diferença é um oráculo inteiro:
     * `/passkey/login/options` é rota PÚBLICA e devolve identificadores-isca para
     * quem não tem chave registrada. Apresentar a isca de volta aqui dava 404
     * (a isca não existe na tabela), e apresentar um identificador REAL dava 500
     * (a verificação criptográfica falhava). 404 = não tem chave; 500 = tem. As
     * iscas disfarçavam uma rota e a rota irmã desfazia o disfarce, no mesmo
     * processo, sem o reinício que a OS-33 declarou como único limite.
     */
    #credentialForResponse(credentialId, userId) {
        const credential = this.#repository.credentials().find(candidate => candidate.credential_id === credentialId && candidate.user_id === userId);
        if (credential === undefined)
            throw new IdentityError('invalid', t('auth.passkeyNotFound'));
        return credential;
    }
    async #withChallenge(challengeId, purpose, userId, sessionId, work) {
        return this.#mutex.run(`challenge:${challengeId}`, async () => {
            const challenge = this.#repository.challenges().find(candidate => candidate.challenge_id === challengeId);
            if (challenge === undefined || challenge.purpose !== purpose
                || (userId !== undefined && challenge.user_id !== userId)
                || (sessionId !== undefined && challenge.session_id !== sessionId)) {
                throw new IdentityError('not-found', t('auth.confirmationNotFound'));
            }
            if (challenge.consumed_at !== null)
                throw new IdentityError('replay', t('auth.confirmationAlreadyUsed'));
            try {
                if (Date.parse(challenge.expires_at) <= this.#now().getTime())
                    throw new IdentityError('expired', t('auth.confirmationExpired'));
                return await work(challenge);
            }
            finally {
                await this.#consumeChallenge(challenge);
            }
        });
    }
    async #storeChallenge(purpose, userId, sessionId, challenge) {
        const now = this.#now();
        const challengeId = this.#createId();
        await this.#repository.putChallenge({
            challenge_id: challengeId,
            challenge_hash: secretHash(challenge),
            purpose,
            user_id: userId,
            session_id: sessionId,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + CHALLENGE_TTL).toISOString(),
            consumed_at: null,
        });
        return challengeId;
    }
    async #consumeChallenge(challenge) {
        await this.#repository.putChallenge({ ...challenge, consumed_at: this.#now().toISOString() });
    }
    async #verifyAuthentication(response, challenge, credential, requireUserVerification) {
        // Uma assinatura que não confere é pedido RECUSADO, e não erro do servidor.
        // O verificador lança `Error` puro, que a porta traduz em 500 — e 500 para
        // quem tem chave, contra 401 para quem não tem, é a outra metade do mesmo
        // oráculo. A tradução acontece AQUI, no ponto que conhece o significado, e
        // não na porta, que só veria um erro qualquer.
        try {
            return await this.#rawVerifyAuthentication(response, challenge, credential, requireUserVerification);
        }
        catch (error) {
            if (error instanceof IdentityError)
                throw error;
            throw new IdentityError('invalid', t('passkey.notConfirmed'));
        }
    }
    async #rawVerifyAuthentication(response, challenge, credential, requireUserVerification) {
        return this.#passkeys.verifyAuthentication({
            response,
            challengeMatches: value => secretMatches(value, challenge.challenge_hash),
            expectedOrigin: this.#expectedOrigin,
            expectedRpId: this.#rpId,
            credential: {
                id: credential.credential_id,
                publicKey: Buffer.from(credential.public_key, 'base64url'),
                counter: credential.counter,
                transports: credential.transports,
            },
            requireUserVerification,
        });
    }
    async #updateCounter(credential, newCounter) {
        if (credential.counter !== 0 && newCounter <= credential.counter) {
            throw new IdentityError('counter', t('auth.passkeyPossiblyCloned'));
        }
        await this.#repository.putCredential({ ...credential, counter: newCounter, last_used_at: this.#now().toISOString() });
    }
    async #audit(eventType, userId, sessionId, orgId, tenantId, outcome, reason) {
        const record = {
            audit_id: this.#createId(),
            event_type: eventType,
            user_id: userId,
            session_id: sessionId,
            org_id: orgId,
            tenant_id: tenantId,
            created_at: this.#now().toISOString(),
            outcome,
            reason,
        };
        await this.#repository.putAudit(record);
    }
}
function normalizeEmail(email) {
    const normalized = email.trim().toLowerCase();
    if (!zEmail.test(normalized))
        throw new IdentityError('invalid', t('auth.invalidEmail'));
    return normalized;
}
const zEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
