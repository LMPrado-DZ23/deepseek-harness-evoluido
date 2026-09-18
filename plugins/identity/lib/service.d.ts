import type { EmailSender, InvitationMessage } from './email.js';
import type { AuthenticationOptions, AuthenticationResponse, PasskeyProvider, RegistrationOptions, RegistrationResponse } from './passkey.js';
import type { ChallengeRecord, IdentityAuditRecord, IdentityUser, MagicCodeRecord, PasskeyCredential, SessionRecord } from './model.js';
export type EnrollmentMode = 'closed' | 'open' | {
    readonly mode: 'bootstrap-email';
    readonly email: string;
};
export type MagicCodeRequestResult = 'sent' | 'suppressed';
export interface EnrollmentGrant {
    readonly orgId: string;
    readonly tenantId: string;
    readonly role: InvitationMessage['role'];
}
export type IdentityUserProvisioningSource = 'bootstrap' | 'invitation';
export interface IdentityRepository {
    users(): readonly IdentityUser[];
    putUser(record: IdentityUser): Promise<void>;
    credentials(): readonly PasskeyCredential[];
    putCredential(record: PasskeyCredential): Promise<void>;
    challenges(): readonly ChallengeRecord[];
    putChallenge(record: ChallengeRecord): Promise<void>;
    magicCodes(): readonly MagicCodeRecord[];
    putMagicCode(record: MagicCodeRecord): Promise<void>;
    sessions(): readonly SessionRecord[];
    putSession(record: SessionRecord): Promise<void>;
    audits(): readonly IdentityAuditRecord[];
    putAudit(record: IdentityAuditRecord): Promise<void>;
}
export interface DeviceInput {
    readonly label: string;
    readonly userAgent: string;
    readonly ipTruncated: string;
}
export interface IssuedSession {
    readonly token: string;
    readonly csrfToken: string;
    readonly session: SessionRecord;
}
export interface IdentityPrincipal {
    readonly userId: string;
    readonly orgId: string;
    readonly tenantId: string;
    readonly sessionId: string;
}
export interface IdentityExecutionState {
    readonly authenticated: boolean;
    readonly strongIdentityVerified: boolean;
}
export interface PasskeyCeremony<TOptions> {
    readonly challengeId: string;
    readonly options: TOptions;
}
/**
 * Campos do registro de sessão que NUNCA atravessam para a rede.
 *
 * Constante exportada e não um recorte na montagem: `csrf_seed` ficou de fora
 * do recorte por ter nascido depois dele.
 */
export declare const CAMPOS_PRIVADOS_DA_SESSAO: readonly ["token_hash", "csrf_hash", "csrf_seed"];
export declare class IdentityError extends Error {
    readonly code: 'invalid' | 'expired' | 'revoked' | 'locked' | 'not-found' | 'csrf' | 'replay' | 'counter';
    constructor(code: 'invalid' | 'expired' | 'revoked' | 'locked' | 'not-found' | 'csrf' | 'replay' | 'counter', message: string);
}
export interface IdentityServiceOptions {
    readonly repository: IdentityRepository;
    readonly passkeys: PasskeyProvider;
    readonly emailSender: EmailSender;
    readonly rpName: string;
    readonly rpId: string;
    readonly expectedOrigin: string;
    readonly defaultOrgId: string;
    readonly defaultTenantId: string;
    readonly enrollment: EnrollmentMode;
    readonly personalModeAllowed?: boolean;
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly createSecret?: () => string;
    readonly createMagicCode?: () => string;
}
export declare class StudioIdentityService {
    #private;
    constructor(options: IdentityServiceOptions);
    isPersonalMode(bindHost: '127.0.0.1' | '0.0.0.0'): boolean;
    personalPrincipal(bindHost: '127.0.0.1' | '0.0.0.0'): IdentityPrincipal | undefined;
    /**
     * The upstream Harness browser cookie authenticates one process, not one
     * Studio identity. Expose that client only for a local installation with a
     * single registered person; team/server installations need a tenant-aware
     * transport instead of this process-wide cookie.
     */
    isSharedHarnessClientAllowed(session: SessionRecord): boolean;
    isEnrollmentOpen(email?: string): boolean;
    setEnrollmentResolver(resolver: (email: string) => EnrollmentGrant | undefined): () => void;
    setUserProvisioner(provisioner: (user: IdentityUser, source: IdentityUserProvisioningSource) => Promise<void>): () => void;
    userRecords(): readonly IdentityUser[];
    sendInvitation(message: InvitationMessage): Promise<void>;
    requestMagicCode(email: string): Promise<MagicCodeRequestResult>;
    verifyMagicCode(email: string, code: string, device: DeviceInput): Promise<IssuedSession>;
    authenticate(token: string, touch?: boolean): Promise<SessionRecord>;
    validateCsrfToken(session: SessionRecord, headerToken: string | undefined): void;
    /**
     * Declara se os cookies levam `Secure`. O plugin chama isto ao montar.
     * @param secure - `false` somente no modo pessoal, em `http://127.0.0.1`.
     */
    setCookieSecurity(secure: boolean): void;
    /**
     * O endereço em que o servidor escuta, declarado na montagem.
     *
     * Ele existe porque o MODO PESSOAL depende dele e `personalSession()` é
     * chamada de dentro de `authenticatedMutation`, que recebe o pedido e o
     * serviço — e não o perfil. O padrão é `0.0.0.0`, que é o endereço que FECHA
     * a porta: uma instalação que esqueça de declarar não ganha a porta larga,
     * ganha a estreita.
     */
    setBindHost(host: '127.0.0.1' | '0.0.0.0'): void;
    /**
     * A SESSÃO SINTÉTICA do modo pessoal, ou nenhuma.
     *
     * Ela não é gravada, não tem token e não é revogável: é o principal local
     * vestido de sessão, para que todo consumidor continue lendo `user_id`,
     * `org_id`, `tenant_id` e `session_id` como sempre leu. Os dois campos de
     * hash existem porque o esquema os exige, e são zeros — nenhum segredo, e
     * nada que case com um segredo de verdade.
     *
     * A porta fecha sozinha: basta uma pessoa registrada, ou a borda obrigatória,
     * ou o servidor escutando fora do endereço local.
     * @returns a sessão pessoal, ou `undefined`.
     */
    personalSession(): SessionRecord | undefined;
    /** Se os cookies desta instalação levam `Secure`. */
    get cookiesAreSecure(): boolean;
    /**
     * Declara os endereços confiáveis. O plugin chama isto ao montar a borda.
     * @param trust - hosts e origens aceitos.
     */
    setRequestTrust(trust: {
        readonly allowedHosts: readonly string[];
        readonly allowedOrigins: readonly string[];
    }): void;
    /**
     * Se a confiança de requisição foi declarada.
     *
     * Ela é lida pelo teste que prova o cabeamento: `authenticatedMutation` só
     * confere Host e Origin quando a borda declarou os endereços, e uma declaração
     * esquecida é exatamente o tipo de coisa que ninguém nota — a rota continua
     * respondendo, só que sem a conferência.
     */
    get requestTrustConfigured(): boolean;
    /**
     * Recusa requisição de host ou origem que a borda não aceita.
     * @param host - o cabeçalho `Host`.
     * @param origin - o cabeçalho `Origin`, quando houver.
     * @param mutating - se o método muda estado.
     */
    assertRequestTrust(host: string | undefined, origin: string | undefined, mutating: boolean): void;
    csrfTokenFor(session: SessionRecord): Promise<string>;
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
    listDevices(userId: string): readonly Omit<SessionRecord, (typeof CAMPOS_PRIVADOS_DA_SESSAO)[number]>[];
    revokeSession(actor: SessionRecord, sessionId: string, reason?: string): Promise<void>;
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
    revokeAllSessions(actor: SessionRecord): Promise<void>;
    bindHarnessSession(session: SessionRecord, harnessSessionId: string): Promise<void>;
    /**
     * Drops one conversation pointer from a device session. Only the launcher
     * calls this, and only after the Harness itself proved the conversation is
     * gone or is not an Assistant conversation. The audit row is written before
     * the session is rewritten, so a pointer never disappears unrecorded.
     */
    releaseHarnessSession(session: SessionRecord, harnessSessionId: string, reason: string): Promise<void>;
    ownsHarnessSession(session: SessionRecord, harnessSessionId: string): boolean;
    strongIdentityForHarnessSession(harnessSessionId: string): boolean;
    /**
     * Identidade forte de uma sessão de identidade, pelo seu próprio
     * `session_id`. É o que a autoridade de confirmação de ações usa: ela conhece
     * a sessão do principal, não a sessão do Harness. Sessão inexistente,
     * revogada ou vencida não é identidade forte.
     * @param sessionId - identificador durável da sessão de identidade.
     * @returns verdadeiro só com chave de acesso recente naquela mesma sessão.
     */
    strongIdentityForSession(sessionId: string): boolean;
    identityStateForHarnessSession(harnessSessionId: string, bindHost: '127.0.0.1' | '0.0.0.0'): IdentityExecutionState;
    beginPasskeyRegistration(token: string): Promise<PasskeyCeremony<RegistrationOptions>>;
    finishPasskeyRegistration(token: string, challengeId: string, response: RegistrationResponse, deviceLabel: string): Promise<void>;
    beginPasskeyLogin(email: string): Promise<PasskeyCeremony<AuthenticationOptions>>;
    finishPasskeyLogin(challengeId: string, response: AuthenticationResponse, device: DeviceInput): Promise<IssuedSession>;
    beginStepUp(token: string): Promise<PasskeyCeremony<AuthenticationOptions>>;
    finishStepUp(token: string, challengeId: string, response: AuthenticationResponse): Promise<void>;
    auditRecords(): readonly IdentityAuditRecord[];
    sessionRecords(): readonly SessionRecord[];
    userForSession(session: SessionRecord): IdentityUser;
    principalForHarnessSession(harnessSessionId: string): IdentityPrincipal | undefined;
    recordAdministrationEvent(eventType: Extract<IdentityAuditRecord['event_type'], 'invitation_created' | 'invitation_accepted' | 'role_changed' | 'workspace_created'>, userId: string, orgId: string, tenantId: string, reason: string): Promise<void>;
}
//# sourceMappingURL=service.d.ts.map