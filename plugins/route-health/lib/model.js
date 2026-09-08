import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export const routeStateSchema = z.enum(['OK', 'DEGRADED', 'DOWN', 'NOT_CONFIGURED']);
export const routeHealthRecordSchema = z.object({
    record_id: z.string().min(1),
    org_id: z.string().min(1),
    tenant_id: z.string().min(1),
    route: z.string().min(1),
    state: routeStateSchema,
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    average_latency_ms: z.number().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    /**
     * Quantas requisições entraram na conta SEM preço configurado.
     *
     * Sem este campo, `estimated_cost_usd` somava 0 para elas e o resultado era
     * apresentado como custo medido: "não sei o preço" virava "custou zero".
     *
     * É opcional de propósito. Torná-lo obrigatório exigiria subir a versão do
     * domínio, e `open()` falha com `version-mismatch` em qualquer instalação que
     * já rodou - não existe passo de migração. Registro antigo, sem o campo,
     * significa zero não precificadas.
     */
    /**
     * A janela de contexto desta rota, em tokens (M-03).
     *
     * DECLARADA por quem configurou a rota, nunca adivinhada: o Studio não tem
     * como medir a janela de um provedor de fora, e um número inventado aqui
     * viraria "cabe" ou "não cabe" na tela de alguém. AUSENTE quer dizer
     * DESCONHECIDA, e a tela tem de dizer desconhecida — não zero, que seria
     * lido como "não cabe nada".
     *
     * Opcional pelo mesmo motivo dos demais: a versão do domínio não pode subir,
     * porque `open()` falha com `version-mismatch` em qualquer instalação que já
     * rodou e não existe passo de migração neste seam.
     */
    context_window_tokens: z.number().int().positive().optional(),
    /**
     * Se esta rota aceita ferramentas (M-03).
     *
     * Também DECLARADA. Ausente = desconhecido. `false` e "não sei" são coisas
     * diferentes: com `false` o Studio pode escolher outra rota para uma tarefa
     * com ferramentas; com "não sei" ele não pode afirmar nada.
     */
    supports_tools: z.boolean().optional(),
    /**
     * A privacidade DESTA rota (M-03): `local` quando ela é a IA que roda neste
     * computador, `externa` quando o texto sai daqui.
     *
     * Este NÃO é declarado: é derivado do mesmo fato que `enforceRoutePrivacy`
     * usa para bloquear — ser, ou não ser, a rota local configurada. Deixar isto
     * como configuração permitiria alguém marcar uma rota externa como local e a
     * tela passaria a mentir sobre para onde o texto vai.
     */
    privacy: z.enum(['local', 'externa']).optional(),
    unpriced_requests: z.number().int().nonnegative().optional(),
    /**
     * Falhas seguidas desde o último sucesso desta rota, NESTE escopo.
     *
     * A contagem é por registro - `org_id`/`tenant_id`/rota - e nunca global:
     * uma contagem global fecharia a rota de um locatário por causa da chave
     * quebrada de outro.
     */
    consecutive_failures: z.number().int().nonnegative().optional(),
    /**
     * Quando o circuito desta rota abriu, ou `null` com ele fechado.
     *
     * Sem isto, uma rota que falha sempre era tentada de novo a cada requisição:
     * cada pessoa pagava a espera inteira do erro para descobrir o que a
     * requisição anterior já sabia.
     *
     * Os dois campos são OPCIONAIS pelo mesmo motivo de `unpriced_requests`:
     * torná-los obrigatórios exigiria subir a versão do domínio, e `open()`
     * falha com `version-mismatch` em qualquer instalação que já rodou - não
     * existe passo de migração. Registro antigo, sem os campos, significa
     * circuito fechado, que é exatamente o estado dele antes desta mudança.
     */
    circuit_opened_at: z.iso.datetime().nullable().optional(),
    /**
     * Se esta rota está ligada NESTE escopo.
     *
     * O liga/desliga é por escopo e por rota: desligar globalmente tiraria a rota
     * de locatários que não pediram nada.
     *
     * Opcional pelo mesmo motivo dos campos acima - a versão do domínio não pode
     * subir. Registro antigo, sem o campo, significa LIGADA, que é exatamente o
     * mundo em que ele foi gravado.
     */
    enabled: z.boolean().optional(),
    last_failure: z.string().nullable(),
    updated_at: z.iso.datetime(),
}).strict();
/**
 * O perfil de rota como ele é ACEITO em disco e na borda HTTP.
 *
 * Os três nomes novos e os dois valores do binário anterior convivem na mesma
 * enumeração de propósito: a versão do domínio não pode subir, então o registro
 * gravado com `local-only` ou `any` precisa continuar validando. Quem decide
 * comportamento usa `routePrivacyProfile`, que traduz os antigos; ninguém
 * compara com o valor cru.
 */
export const routePrivacySchema = z.enum(['privado-local', 'equilibrado', 'melhor-qualidade', 'local-only', 'any']);
export const routeSwitchEventSchema = z.object({
    event_id: z.string().min(1),
    org_id: z.string().min(1),
    tenant_id: z.string().min(1),
    from_route: z.string().min(1),
    to_route: z.string().min(1),
    reason: z.string().min(1),
    explicit_route: z.boolean(),
    created_at: z.iso.datetime(),
}).strict();
export const STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN = 'studio_route_health';
export const STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN = 'studio.route.health';
export const studioRouteHealthDomainSpec = defineDomain({
    name: STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN,
    version: 1,
    tables: {
        routes: domainTable(routeHealthRecordSchema),
        events: domainTable(routeSwitchEventSchema),
    },
});
