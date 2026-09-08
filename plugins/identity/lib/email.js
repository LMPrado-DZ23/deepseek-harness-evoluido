import { t } from './i18n.js';
import nodemailer from 'nodemailer';
import { z } from 'zod';
/** Test/development capture. It never writes the code to console or logger. */
export class MemoryEmailSender {
    messages = [];
    invitations = [];
    sendMagicCode(message) {
        this.messages.push(structuredClone(message));
        return Promise.resolve();
    }
    sendInvitation(message) {
        this.invitations.push(structuredClone(message));
        return Promise.resolve();
    }
}
const smtpSecretSchema = z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().min(1),
    pass: z.string().min(1),
    from: z.string().min(1),
}).strict();
export class SmtpEmailSender {
    credentials;
    secretRef;
    constructor(credentials, secretRef) {
        this.credentials = credentials;
        this.secretRef = secretRef;
    }
    async sendMagicCode(message) {
        const { transport, from } = await this.#transport();
        await transport.sendMail({
            from,
            to: message.to,
            subject: t('email.codeSubject'),
            text: t('email.codeBody', { code: message.code, minutes: message.expiresInMinutes }),
        });
    }
    async sendInvitation(message) {
        const { transport, from } = await this.#transport();
        await transport.sendMail({
            from,
            to: message.to,
            subject: t('email.inviteSubject', { workspace: message.workspaceName }),
            text: t('email.inviteBody', { role: message.role, token: message.token, hours: message.expiresInHours }),
        });
    }
    async #transport() {
        const resolved = await this.credentials.resolve(this.secretRef);
        if (resolved === undefined)
            throw new Error(t('email.notConfigured'));
        let raw;
        try {
            raw = JSON.parse(resolved.value);
        }
        catch {
            throw new Error(t('email.invalidConfiguration'));
        }
        const smtp = smtpSecretSchema.parse(raw);
        const transport = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: { user: smtp.user, pass: smtp.pass },
        });
        return { transport, from: smtp.from };
    }
}
