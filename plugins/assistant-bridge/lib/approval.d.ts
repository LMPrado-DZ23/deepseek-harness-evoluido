/** Quantas confirmacoes sucessivas o mesmo pedido pode gerar antes de recusar. */
export declare const MAX_APPROVAL_ATTEMPTS = 32;
/** Nome estavel da acao sensivel, tal como aparece para a pessoa que confirma. */
export type AssistantApprovalAction = 'studio.agent.start.secrets' | 'studio.agent.start.external-network' | 'studio.team.start.secrets' | 'studio.team.start.external-network' | 'studio.team.start.deploy' | 'studio.team.continue.sensitive' | 'studio.agent.resolve-unknown';
export interface AssistantApprovalPrincipal {
    readonly userId: string;
    readonly orgId: string;
    readonly tenantId: string;
    readonly sessionId: string;
}
/**
 * Recorte estrutural da autoridade generica de aprovacao (M90-A). E estrutural
 * de proposito: o bridge nao conhece a implementacao, e a prova pode montar uma
 * autoridade de teste sem simular nada do comportamento de seguranca.
 */
export interface AssistantApprovalPort {
    request(descriptor: {
        readonly org_id: string;
        readonly tenant_id: string;
        readonly user_id: string;
        readonly session_id: string;
        readonly action: string;
        readonly subject_id: string;
        readonly fingerprint: string;
        readonly tier: 'T3';
        readonly request_id: string;
        readonly summary: string;
    }): Promise<{
        readonly approval_id: string;
        readonly state: string;
    }>;
    consume(input: {
        readonly actor: AssistantApprovalPrincipal;
        readonly approvalId: string;
        readonly claimId: string;
        readonly action: string;
        readonly subjectId: string;
        readonly fingerprint: string;
        readonly tier: 'T3';
    }): Promise<{
        readonly user_id: string;
    }>;
}
/**
 * Erro que o modelo recebe no lugar da permissao. Carrega o `approval_id` para
 * que a interface consiga mostrar exatamente qual pedido esta esperando.
 */
export declare class AssistantApprovalRequiredError extends Error {
    readonly approvalId: string;
    readonly action: AssistantApprovalAction;
    constructor(approvalId: string, action: AssistantApprovalAction, message: string);
}
/** A pessoa recusou. Recusa nao roda de novo com outro identificador. */
export declare class AssistantApprovalDeniedError extends Error {
}
/** Limite duro da frase inteira, igual ao da autoridade. */
export declare const APPROVAL_SUMMARY_LIMIT = 300;
/** Quanto de um texto livre (instrucao, motivo) cabe na frase. */
export declare const APPROVAL_EXCERPT_LIMIT = 140;
/**
 * Trecho de um texto livre, cortado no proprio texto - nunca na frase inteira.
 *
 * Cortar a frase montada comia a ULTIMA parte, que e justamente a lista de
 * arquivos que a acao pode mexer: a informacao mais importante era a primeira
 * a sumir.
 * @param value - texto de origem livre (instrucao do modelo, motivo escrito).
 * @param limit - quantos caracteres do texto cabem.
 * @returns o trecho higienizado, com reticencias quando foi cortado.
 */
export declare function approvalExcerpt(value: string, limit?: number): string;
/**
 * A frase que a pessoa le antes de decidir. Cada parte ja chega no tamanho
 * certo; o limite duro aqui e a ultima defesa.
 * @param parts - pedacos ja em portugues, na ordem em que devem ser lidos.
 * @returns a frase pronta para o pedido de confirmacao.
 */
export declare function approvalSummary(parts: readonly string[]): string;
/**
 * Codigo curto que a pessoa consegue comparar a olho. Dois pedidos diferentes
 * nunca ficam identicos na tela: mesmo com instrucoes que so divergem depois do
 * corte, o codigo difere - e sem ele o corte devolvia dois cartoes gemeos.
 * @param fingerprint - impressao digital do que esta sendo pedido.
 * @returns seis caracteres estaveis daquele pedido.
 */
export declare function approvalCode(fingerprint: string): string;
export declare function approvalSubjectId(workspaceId: string, repositoryPath: string): string;
/**
 * Impressao digital canonica do que esta sendo pedido. Trocar qualquer parte
 * (prompt, caminho, provedor, operacao) muda a impressao, e uma confirmacao
 * antiga deixa de servir - e isso que impede confirmar uma coisa e executar outra.
 */
export declare function approvalFingerprint(parts: readonly string[]): string;
/**
 * Exige uma confirmacao humana real para uma operacao T3 e devolve quem
 * confirmou. Falha fechada em toda a saida que nao seja um recibo consumido.
 *
 * O pedido e idempotente enquanto estiver aberto: o modelo repete a mesma
 * chamada e cai no mesmo `approval_id`, que e o que a pessoa confirma. Depois
 * de consumido ou vencido, a proxima chamada abre um pedido NOVO - uma
 * confirmacao vale por uma execucao. Depois de recusado, nada abre.
 */
export declare function requireTier3Approval(port: AssistantApprovalPort, input: {
    readonly principal: AssistantApprovalPrincipal;
    readonly action: AssistantApprovalAction;
    readonly subjectId: string;
    readonly fingerprint: string;
    /** A frase que a pessoa vai ler antes de decidir. */
    readonly summary: string;
}): Promise<{
    readonly approvedBy: string;
}>;
//# sourceMappingURL=approval.d.ts.map