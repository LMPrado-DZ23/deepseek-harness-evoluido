import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { t } from './i18n.js'
import nodemailer from 'nodemailer'
import { z } from 'zod'

export interface MagicCodeMessage {
  readonly to: string
  readonly code: string
  readonly expiresInMinutes: number
}

export interface InvitationMessage {
  readonly to: string
  readonly token: string
  readonly workspaceName: string
  readonly role: 'owner' | 'admin' | 'builder' | 'viewer'
  readonly expiresInHours: number
}

export interface EmailSender {
  sendMagicCode(message: MagicCodeMessage): Promise<void>
  sendInvitation(message: InvitationMessage): Promise<void>
}

/** Test/development capture. It never writes the code to console or logger. */
export class MemoryEmailSender implements EmailSender {
  readonly messages: MagicCodeMessage[] = []
  readonly invitations: InvitationMessage[] = []

  sendMagicCode(message: MagicCodeMessage): Promise<void> {
    this.messages.push(structuredClone(message))
    return Promise.resolve()
  }

  sendInvitation(message: InvitationMessage): Promise<void> {
    this.invitations.push(structuredClone(message))
    return Promise.resolve()
  }
}

const smtpSecretSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().min(1),
}).strict()

export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly secretRef: CredentialRef,
  ) {}

  async sendMagicCode(message: MagicCodeMessage): Promise<void> {
    const { transport, from } = await this.#transport()
    await transport.sendMail({
      from,
      to: message.to,
      subject: t('email.codeSubject'),
      text: t('email.codeBody', { code: message.code, minutes: message.expiresInMinutes }),
    })
  }

  async sendInvitation(message: InvitationMessage): Promise<void> {
    const { transport, from } = await this.#transport()
    await transport.sendMail({
      from,
      to: message.to,
      subject: t('email.inviteSubject', { workspace: message.workspaceName }),
      text: t('email.inviteBody', { role: message.role, token: message.token, hours: message.expiresInHours }),
    })
  }

  async #transport() {
    const resolved = await this.credentials.resolve(this.secretRef)
    if (resolved === undefined) throw new Error(t('email.notConfigured'))
    let raw: unknown
    try {
      raw = JSON.parse(resolved.value)
    } catch {
      throw new Error(t('email.invalidConfiguration'))
    }
    const smtp = smtpSecretSchema.parse(raw)
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    })
    return { transport, from: smtp.from }
  }
}
