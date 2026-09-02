import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials';
export interface MagicCodeMessage {
    readonly to: string;
    readonly code: string;
    readonly expiresInMinutes: number;
}
export interface InvitationMessage {
    readonly to: string;
    readonly token: string;
    readonly workspaceName: string;
    readonly role: 'owner' | 'admin' | 'builder' | 'viewer';
    readonly expiresInHours: number;
}
export interface EmailSender {
    sendMagicCode(message: MagicCodeMessage): Promise<void>;
    sendInvitation(message: InvitationMessage): Promise<void>;
}
/** Test/development capture. It never writes the code to console or logger. */
export declare class MemoryEmailSender implements EmailSender {
    readonly messages: MagicCodeMessage[];
    readonly invitations: InvitationMessage[];
    sendMagicCode(message: MagicCodeMessage): Promise<void>;
    sendInvitation(message: InvitationMessage): Promise<void>;
}
export declare class SmtpEmailSender implements EmailSender {
    #private;
    private readonly credentials;
    private readonly secretRef;
    constructor(credentials: CredentialProvider, secretRef: CredentialRef);
    sendMagicCode(message: MagicCodeMessage): Promise<void>;
    sendInvitation(message: InvitationMessage): Promise<void>;
}
//# sourceMappingURL=email.d.ts.map