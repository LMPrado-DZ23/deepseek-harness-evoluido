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
/** Limite do resumo, igual ao da autoridade: a frase e cortada aqui, nao la. */
export declare const APPROVAL_SUMMARY_LIMIT = 300;
/**
 * Uma frase unica, curta e sem caracteres de controle. Parte do conteudo vem
 * do modelo, entao ela e higienizada aqui - e e ela que a pessoa le antes de
 * decidir. Ela entra na impressao digital, logo o texto exibido e exatamente o
 * texto que a confirmacao tranca.
 * @param parts - pedacos ja em portugues, na ordem em que devem ser lidos.
 * @returns a frase pronta para o pedido de confirmacao.
 */
export declare function approvalSummary(parts: readonly string[]): string;
/** Identidade do repositorio dentro do pedido, legivel quando o id ja e legivel. */
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