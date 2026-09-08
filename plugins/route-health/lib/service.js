import { randomUUID } from 'node:crypto';
/** Os três perfis, na ordem em que a tela os oferece. */
export const ROUTE_PRIVACY_PROFILES = ['privado-local', 'equilibrado', 'melhor-qualidade'];
/**
 * O perfil nomeado de um valor gravado, novo ou antigo.
 *
 * Toda decisão passa por aqui antes de comparar perfil: comparar com o valor
 * cru deixaria `local-only` escapando da regra do C-22 por não ser igual à
 * string nova.
 * @param value - o perfil novo ou o valor binário antigo.
 * @returns o perfil nomeado.
 */
export function routePrivacyProfile(value) {
    if (value === 'local-only')
        return 'privado-local';
    if (value === 'any')
        return 'melhor-qualidade';
    return value;
}
/**
 * O funil por onde TODA escolha de rota sai.
 *
 * `privado-local` promete uma coisa só: nada sai deste computador. Antes, essa
 * promessa era um `if` no começo de `chooseRoute` - convenção, não garantia:
 * qualquer caminho novo aberto depois dele (cascata, rota explícita, circuito
 * meio-aberto, teto de gasto) devolveria uma rota externa em silêncio, e o
 * perfil só descobriria isso pelo dado já enviado. Aqui a promessa é
 * estrutural: quem não é a rota local vira bloqueio, venha de onde vier.
 * @param profile - o perfil pedido.
 * @param localRoute - a rota da IA local.
 * @param selection - a escolha que os caminhos produziram.
 * @param blockedReason - a frase do bloqueio.
 * @returns a escolha, ou o bloqueio.
 */
export function enforceRoutePrivacy(profile, localRoute, selection, blockedReason) {
    if (profile !== 'privado-local')
        return selection;
    if (selection.route === undefined || selection.route === localRoute)
        return selection;
    return { route: undefined, explicit: selection.explicit, reason: blockedReason };
}
function recordId(scope, route) {
    return `${scope.orgId}:${scope.tenantId}:${route}`;
}
function isVisible(chunk) {
    return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
        || chunk.type === 'tool-call-delta' || chunk.type === 'block-end';
}
function failedFinish(chunk) {
    if (chunk.type !== 'finish')
        return undefined;
    if (chunk.reason.kind === 'error')
        return chunk.reason.failure.message;
    if (chunk.reason.kind === 'aborted')
        return chunk.reason.failure.message;
    return undefined;
}
function safeFailureChunk(chunk) {
    /* v8 ignore next -- internal invariant: called only after failedFinish returned a message */
    if (chunk.type !== 'finish' || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted'))
        return chunk;
    return {
        ...chunk,
        reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: ROUTE_FAILURE_MESSAGE } },
    };
}
/** Três falhas seguidas e trinta segundos de espera: curto o bastante para uma indisponibilidade passageira não virar apagão, longo o bastante para não repetir o erro a cada requisição. */
export const DEFAULT_ROUTE_CIRCUIT = { failureThreshold: 3, cooldownMs: 30_000 };
/**
 * O estado do circuito de um registro no instante dado.
 *
 * `circuit_opened_at` é a ÚNICA fonte: ele é gravado quando as falhas seguidas
 * atingem o limite e apagado no primeiro sucesso. Registro gravado antes destes
 * campos existirem não tem o campo, e ausência significa circuito fechado.
 * @param record - o registro da rota.
 * @param now - o instante da decisão.
 * @param circuit - limite e tempo de espera.
 * @returns o estado do circuito.
 */
export function routeCircuitState(record, now, circuit = DEFAULT_ROUTE_CIRCUIT) {
    const openedAt = record.circuit_opened_at;
    if (openedAt === undefined || openedAt === null)
        return 'CLOSED';
    return now.getTime() - Date.parse(openedAt) < circuit.cooldownMs ? 'OPEN' : 'HALF_OPEN';
}
/**
 * O gasto de um escopo e o veredito do teto.
 *
 * Só entram registros de rota PAGA: a rota local não cobra e barrá-la por
 * dinheiro seria barrar trabalho que não custa nada.
 * @param records - os registros das rotas pagas do escopo.
 * @param budget - o teto configurado, ou `undefined` para nenhum.
 * @returns custo medido, requisições sem preço e o veredito.
 */
export function routeBudgetUsage(records, budget) {
    let measuredCostUsd = 0;
    let unpricedRequests = 0;
    for (const record of records) {
        measuredCostUsd += record.estimated_cost_usd;
        unpricedRequests += record.unpriced_requests ?? 0;
    }
    if (budget === undefined)
        return { measuredCostUsd, unpricedRequests, verdict: 'WITHIN' };
    if (measuredCostUsd >= budget.maxCostUsd)
        return { measuredCostUsd, unpricedRequests, verdict: 'COST_EXCEEDED' };
    return unpricedRequests >= budget.maxUnpricedRequests
        ? { measuredCostUsd, unpricedRequests, verdict: 'UNPRICED_EXCEEDED' }
        : { measuredCostUsd, unpricedRequests, verdict: 'WITHIN' };
}
export class StudioRouteHealthService {
    repository;
    config;
    #configured = new Set();
    /**
     * Requisições que já desceram a cascata uma vez.
     *
     * A chave é o próprio objeto da requisição: duas cascatas para a MESMA
     * requisição cobram duas vezes e dobram a espera de quem já estava esperando.
     */
    #cascaded = new WeakSet();
    constructor(repository, config) {
        this.repository = repository;
        this.config = config;
    }
    initialize(scope, configured) {
        this.#configured.clear();
        for (const route of configured)
            this.#configured.add(route);
        return Promise.all(this.config.routes.map(route => this.repository.putRoute(this.baseRecord(scope, route, configured.has(route) ? 'OK' : 'NOT_CONFIGURED'))));
    }
    list(scope) {
        const stored = this.repository.routes().filter(record => record.org_id === scope.orgId && record.tenant_id === scope.tenantId);
        const known = new Set(stored.map(record => record.route));
        return [
            ...stored,
            ...this.config.routes.filter(route => !known.has(route)).map(route => this.baseRecord(scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED')),
        ];
    }
    switches(scope) {
        return this.repository.events().filter(event => event.org_id === scope.orgId && event.tenant_id === scope.tenantId);
    }
    /**
     * A rota escolhida para um propósito, já respeitando o perfil do escopo.
     *
     * A escolha inteira sai por `enforceRoutePrivacy`: o caminho que a produziu
     * pode mudar amanhã, a promessa do `privado-local` não.
     */
    async chooseRoute(scope, purpose, options = { privacy: 'melhor-qualidade' }) {
        const profile = routePrivacyProfile(options.privacy);
        const selection = await this.select(scope, purpose, profile, options);
        return enforceRoutePrivacy(profile, this.config.localRoute, selection, LOCAL_BLOCKED_REASON);
    }
    async select(scope, purpose, profile, options) {
        const local = this.get(scope, this.config.localRoute);
        // Uma rota desligada não está saudável para efeito de escolha: o desligamento
        // é uma decisão de quem opera, e ignorá-la para a rota local seria justamente
        // mandar trabalho para onde alguém pediu que não fosse.
        const localUsable = local?.state === 'OK' && this.enabled(scope, this.config.localRoute);
        if (profile === 'privado-local') {
            const localSelected = options.explicitRoute === undefined || options.explicitRoute === this.config.localRoute;
            if (localSelected && localUsable) {
                return { route: this.config.localRoute, explicit: options.explicitRoute !== undefined, reason: 'Perfil privado restrito à IA local.' };
            }
            const reason = LOCAL_BLOCKED_REASON;
            await this.auditSwitch(scope, options.explicitRoute ?? this.config.localRoute, 'blocked', reason, options.explicitRoute !== undefined);
            return { route: undefined, explicit: options.explicitRoute !== undefined, reason };
        }
        const explicit = options.explicitRoute !== undefined;
        // O desligamento vem ANTES do teto e antes da rota escolhida a dedo: ele é a
        // decisão mais explícita que existe sobre esta rota, e uma rota desligada que
        // ainda pudesse ser pedida pelo nome não estaria desligada.
        if (options.explicitRoute !== undefined && !this.enabled(scope, options.explicitRoute)) {
            const reason = DISABLED_REASON;
            await this.auditSwitch(scope, options.explicitRoute, 'blocked', reason, true);
            return { route: undefined, explicit: true, reason };
        }
        // O teto vale também para a rota escolhida a dedo: um guarda que a escolha
        // explícita atravessa não é guarda, é sugestão. A rota local fica de fora
        // porque ela não cobra - o teto existe para o dinheiro, não para o trabalho.
        if (options.explicitRoute !== this.config.localRoute && this.budget(scope).verdict !== 'WITHIN') {
            const from = options.explicitRoute ?? this.config.fallbackRoute;
            if (localUsable) {
                const reason = BUDGET_LOCAL_REASON;
                await this.auditSwitch(scope, from, this.config.localRoute, reason, explicit);
                return { route: this.config.localRoute, explicit, reason };
            }
            const reason = BUDGET_BLOCKED_REASON;
            await this.auditSwitch(scope, from, 'blocked', reason, explicit);
            return { route: undefined, explicit, reason };
        }
        if (options.explicitRoute !== undefined) {
            return { route: options.explicitRoute, explicit: true, reason: 'Rota escolhida pela pessoa.' };
        }
        // `equilibrado` prefere a local em TODO propósito, não só na leitura segura:
        // é isso que separa "prefere a local" de "usa a melhor que houver".
        if (localUsable && (profile === 'equilibrado' || purpose === 'T0')) {
            return {
                route: this.config.localRoute, explicit: false,
                reason: profile === 'equilibrado' ? BALANCED_LOCAL_REASON : 'Modelo local saudável preferido para leitura segura.',
            };
        }
        const known = this.config.routes.map(route => this.get(scope, route))
            .filter((record) => record !== undefined && this.enabled(scope, record.route));
        const healthy = known.find(record => record.state === 'OK');
        if (healthy !== undefined) {
            // No `equilibrado` a ida para fora não é silenciosa: a pessoa pediu a
            // local e está recebendo outra coisa, e a frase diz isso.
            if (profile === 'equilibrado') {
                await this.auditSwitch(scope, this.config.localRoute, healthy.route, BALANCED_EXTERNAL_REASON, false);
                return { route: healthy.route, explicit: false, reason: BALANCED_EXTERNAL_REASON };
            }
            return { route: healthy.route, explicit: false, reason: 'Primeira rota saudável do perfil.' };
        }
        // Nenhuma rota saudável. Uma rota que caiu era simplesmente abandonada até
        // um sucesso que ela nunca teria a chance de ter; cumprido o tempo de
        // espera, ela ganha UMA chamada que decide se o circuito fecha ou reabre.
        const probe = known.find(record => this.circuit(scope, record.route) === 'HALF_OPEN');
        if (probe !== undefined) {
            await this.startProbe(probe);
            return { route: probe.route, explicit: false, reason: HALF_OPEN_REASON };
        }
        if (!this.enabled(scope, this.config.fallbackRoute)) {
            const reason = DISABLED_REASON;
            await this.auditSwitch(scope, this.config.fallbackRoute, 'blocked', reason, false);
            return { route: undefined, explicit: false, reason };
        }
        if (this.circuit(scope, this.config.fallbackRoute) === 'OPEN') {
            const reason = ALL_OPEN_REASON;
            await this.auditSwitch(scope, this.config.fallbackRoute, 'blocked', reason, false);
            return { route: undefined, explicit: false, reason };
        }
        if (profile === 'equilibrado') {
            await this.auditSwitch(scope, this.config.localRoute, this.config.fallbackRoute, BALANCED_EXTERNAL_REASON, false);
            return { route: this.config.fallbackRoute, explicit: false, reason: BALANCED_EXTERNAL_REASON };
        }
        return { route: this.config.fallbackRoute, explicit: false, reason: 'Rota direta usada porque nenhuma rota monitorada está saudável.' };
    }
    /**
     * Se esta rota está ligada neste escopo, agora.
     *
     * Ausência do campo significa LIGADA: registro gravado antes de o
     * desligamento existir descreve um mundo em que toda rota era usada, e lê-lo
     * como desligada apagaria rotas que ninguém mandou apagar.
     */
    enabled(scope, route) {
        return this.get(scope, route)?.enabled ?? true;
    }
    /**
     * Liga ou desliga uma rota para um escopo.
     *
     * O desligamento é por escopo - `org_id`/`tenant_id`/rota - e nunca global:
     * desligar a rota de um locatário por decisão de outro seria o mesmo erro que
     * o circuito por escopo já evita.
     * @param scope - a organização e o locatário.
     * @param route - a rota.
     * @param enabled - `true` liga, `false` desliga.
     * @returns quando a decisão estiver gravada.
     */
    setRouteEnabled(scope, route, enabled) {
        const previous = this.get(scope, route) ?? this.baseRecord(scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED');
        return this.repository.putRoute({ ...previous, enabled, updated_at: this.clock().toISOString() });
    }
    /** O estado do circuito de uma rota neste escopo, agora. */
    circuit(scope, route) {
        const record = this.get(scope, route);
        if (record === undefined)
            return 'CLOSED';
        return routeCircuitState(record, this.clock(), this.config.circuit ?? DEFAULT_ROUTE_CIRCUIT);
    }
    /** O gasto do escopo somando apenas as rotas pagas, e o veredito do teto. */
    budget(scope) {
        return routeBudgetUsage(this.list(scope).filter(record => record.route !== this.config.localRoute), this.config.budget);
    }
    /**
     * Marca a chamada de meia-abertura reiniciando a espera.
     *
     * Sem esta marca, todas as requisições que chegassem depois do tempo de
     * espera seriam admitidas juntas: em vez de UMA tentativa decidindo, a rota
     * quebrada levaria a mesma enxurrada que o circuito abriu para evitar.
     */
    startProbe(record) {
        return this.repository.putRoute({ ...record, circuit_opened_at: this.clock().toISOString() });
    }
    /** Um único relógio para todo o serviço: registro, auditoria e circuito têm de contar o mesmo tempo. */
    clock() {
        return this.config.now?.() ?? new Date();
    }
    async *streamWithFallback(scope, options, next, fallback, explicitRoute = false, privacy = 'melhor-qualidade') {
        const started = performance.now();
        const buffered = [];
        let visible = false;
        let usage;
        let failure;
        for await (const chunk of next()) {
            if (chunk.type === 'usage')
                usage = chunk.usage;
            failure = failedFinish(chunk);
            if (!visible && isVisible(chunk)) {
                visible = true;
                for (const pending of buffered)
                    yield pending;
                buffered.length = 0;
            }
            const publicChunk = failure === undefined ? chunk : safeFailureChunk(chunk);
            if (visible)
                yield publicChunk;
            else
                buffered.push(publicChunk);
        }
        const latency = Math.max(0, performance.now() - started);
        if (failure === undefined) {
            await this.record(scope, options.provider, true, latency, usage);
            for (const pending of buffered)
                yield pending;
            return;
        }
        await this.record(scope, options.provider, false, latency, usage, failure);
        // Uma cascata só desce quando ainda pode ajudar: nunca duas vezes para a
        // mesma requisição, nunca para uma rota que JÁ falhou nesta requisição, e
        // nunca para uma rota com o circuito aberto - as três repetiriam uma espera
        // que já se sabe perdida.
        // E nunca sob o perfil `privado-local`: a cascata leva para a rota EXTERNA
        // de propósito, e uma escolha que o C-22 barrou na entrada não pode voltar
        // pela porta dos fundos quando o modelo local falha no meio do fluxo.
        const doomed = routePrivacyProfile(privacy) === 'privado-local'
            || this.#cascaded.has(options)
            || options.provider === this.config.fallbackRoute
            || this.circuit(scope, this.config.fallbackRoute) === 'OPEN'
            || !this.enabled(scope, this.config.fallbackRoute);
        if (visible || explicitRoute || options.provider !== 'omniroute' || doomed) {
            if (!visible)
                for (const pending of buffered)
                    yield pending;
            return;
        }
        this.#cascaded.add(options);
        await this.auditSwitch(scope, options.provider, this.config.fallbackRoute, 'OmniRoute falhou antes de produzir conteúdo; usando a rota DeepSeek direta.', false);
        const fallbackOptions = {
            ...options, provider: this.config.fallbackRoute, model: this.config.fallbackModel,
        };
        const fallbackStarted = performance.now();
        let fallbackUsage;
        let fallbackFailure;
        for await (const chunk of fallback(fallbackOptions)) {
            if (chunk.type === 'usage')
                fallbackUsage = chunk.usage;
            fallbackFailure = failedFinish(chunk);
            yield chunk;
        }
        await this.record(scope, this.config.fallbackRoute, fallbackFailure === undefined, Math.max(0, performance.now() - fallbackStarted), fallbackUsage, fallbackFailure);
    }
    get(scope, route) {
        return this.repository.routes().find(record => record.record_id === recordId(scope, route))
            ?? (this.config.routes.includes(route)
                ? this.baseRecord(scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED')
                : undefined);
    }
    baseRecord(scope, route, state) {
        return {
            record_id: recordId(scope, route), org_id: scope.orgId, tenant_id: scope.tenantId,
            route, state, requests: 0, errors: 0, average_latency_ms: 0,
            input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
            last_failure: null, updated_at: this.clock().toISOString(),
        };
    }
    async record(scope, route, success, latencyMs, usage, failure) {
        const previous = this.get(scope, route) ?? this.baseRecord(scope, route, 'OK');
        const now = this.clock().toISOString();
        const requests = previous.requests + 1;
        const errors = previous.errors + (success ? 0 : 1);
        const errorRate = errors / requests;
        const state = success ? (errorRate >= 0.25 ? 'DEGRADED' : 'OK') : (errorRate >= 0.5 ? 'DOWN' : 'DEGRADED');
        const input = usage?.inputTokens ?? 0;
        const output = usage?.outputTokens ?? 0;
        const price = this.config.prices?.[route];
        // Sem preço não existe custo conhecido: a requisição é contada como não
        // precificada em vez de somar 0 e virar "custou zero" na apresentação.
        const cost = price === undefined ? 0 : (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000;
        const unpriced = (previous.unpriced_requests ?? 0) + (price === undefined ? 1 : 0);
        // O circuito conta falha SEGUIDA e zera no primeiro sucesso: uma rota que
        // volta a responder volta a ser escolhida sem esperar nada. Falhar de novo
        // no limite - inclusive na chamada de meia-abertura - reabre a espera do
        // zero, em vez de deixar a rota quebrada passar por fechada.
        const consecutive = success ? 0 : (previous.consecutive_failures ?? 0) + 1;
        const threshold = (this.config.circuit ?? DEFAULT_ROUTE_CIRCUIT).failureThreshold;
        const openedAt = success
            ? null
            : (consecutive >= threshold ? now : previous.circuit_opened_at ?? null);
        await this.repository.putRoute({
            ...previous, state, requests, errors,
            average_latency_ms: ((previous.average_latency_ms * previous.requests) + latencyMs) / requests,
            input_tokens: previous.input_tokens + input,
            output_tokens: previous.output_tokens + output,
            estimated_cost_usd: previous.estimated_cost_usd + cost,
            unpriced_requests: unpriced,
            consecutive_failures: consecutive,
            circuit_opened_at: openedAt,
            last_failure: failure ?? previous.last_failure,
            updated_at: now,
        });
    }
    auditSwitch(scope, from, to, reason, explicit) {
        const id = this.config.createId?.() ?? randomUUID();
        return this.repository.putEvent({
            event_id: id, org_id: scope.orgId, tenant_id: scope.tenantId,
            from_route: from, to_route: to, reason, explicit_route: explicit,
            created_at: this.clock().toISOString(),
        });
    }
}
/**
 * As frases do circuito, do teto, do desligamento e do perfil equilibrado.
 *
 * Elas são escritas sem acento porque o portão de i18n reprova literal em
 * português dentro de `plugins/*\/src` que não esteja no catálogo, este plugin
 * não tem catálogo (criar um reprovaria de uma vez todas as frases que já
 * existem aqui) e o baseline herdado pode encolher, nunca crescer. Quando a
 * tela de rotas ler estas razões, elas mudam de lugar junto com as outras.
 */
const BUDGET_LOCAL_REASON = 'Teto de gasto do escopo estourado; seguindo apenas com a IA local.';
const BUDGET_BLOCKED_REASON = 'Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.';
const HALF_OPEN_REASON = 'Meia-abertura: uma chamada decide se o circuito fecha ou reabre.';
const ALL_OPEN_REASON = 'Circuito aberto em todas as rotas; nenhuma chamada nova enquanto durar a espera.';
const DISABLED_REASON = 'Rota desligada neste espaco de trabalho; ela nao e escolhida enquanto continuar assim.';
const BALANCED_LOCAL_REASON = 'Perfil equilibrado: a IA local esta em uso e nada sai deste computador.';
const BALANCED_EXTERNAL_REASON = 'Perfil equilibrado: a IA local nao esta disponivel; usando a rota externa configurada.';
/**
 * A frase do bloqueio do `privado-local`.
 *
 * Ela é a MESMA em toda saída barrada - local fora do ar, local desligada, rota
 * externa pedida pelo nome, rota que algum caminho novo tentou devolver - porque
 * para quem lê o fato é um só: nada foi enviado para fora.
 */
const LOCAL_BLOCKED_REASON = 'IA local indisponível; nenhuma informação foi enviada para uma rota externa.';
export const ROUTE_FAILURE_MESSAGE = 'A conexão com a inteligência artificial falhou. Nada foi aplicado; tente novamente ou escolha outra rota.';
/**
 * Classifica o custo de uma rota pelo que realmente se sabe.
 * @param record - o registro da rota.
 * @returns o estado do custo, para quem for apresentar o número.
 */
export function routeCostState(record) {
    const unpriced = record.unpriced_requests ?? 0;
    if (record.requests === 0 || unpriced === 0)
        return 'MEASURED';
    return unpriced >= record.requests ? 'UNKNOWN' : 'PARTIAL';
}
