import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import type { GeneratedFile } from './generator.js'
import type { StudioProjectCategory } from './model.js'

export interface GeneratedAuthLayer {
  readonly required: boolean
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

export function requiresGeneratedAuth(spec: AppSpecV1, category: StudioProjectCategory): boolean {
  return category === 'crud-panel' || category === 'form-database'
}

export function requiresFormSubmissionAuth(spec: AppSpecV1): boolean {
  return (
    spec.sensitive_data.detected.length > 0 || spec.entities.some(entity => entity.kind === 'database' && entity.sensitive)
  )
}

export function generateAuthLayer(spec: AppSpecV1, category: StudioProjectCategory): GeneratedAuthLayer {
  const required = requiresGeneratedAuth(spec, category)
  if (!required) return { required: false, files: [], protectedPaths: [] }
  const files: GeneratedFile[] = [
    { path: 'src/auth/migrations.ts', content: AUTH_MIGRATIONS },
    { path: 'src/auth/email.ts', content: AUTH_EMAIL },
    { path: 'src/auth/service.ts', content: AUTH_SERVICE },
    { path: 'src/auth/runtime.ts', content: AUTH_RUNTIME },
    { path: 'src/auth/actions.ts', content: AUTH_ACTIONS },
    { path: 'src/components/generated/access-panel.tsx', content: ACCESS_PANEL },
    { path: 'app/api/auth/session/route.ts', content: AUTH_SESSION_ROUTE },
    { path: 'tests/generated-auth.spec.ts', content: AUTH_TEST },
  ]
  return { required, files, protectedPaths: files.map(file => file.path) }
}

export async function writeAuthLayer(root: string, layer: GeneratedAuthLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

const AUTH_MIGRATIONS = `import type { DatabaseSync } from 'node:sqlite'

export function migrateAuth(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('CREATE TABLE IF NOT EXISTS auth_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
    const current = Number(database.prepare('SELECT coalesce(max(version),0) AS version FROM auth_schema_migrations').get()?.version ?? 0)
    if (current >= 1) { database.exec('COMMIT'); return }
    database.exec(\`
      CREATE TABLE IF NOT EXISTS auth_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner','member')), created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS auth_invites (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL REFERENCES auth_users(id), expires_at TEXT NOT NULL, used_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS auth_codes (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS auth_codes_email ON auth_codes(email, expires_at);
      CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_token ON auth_sessions(token_hash);
    \`)
    database.prepare('INSERT INTO auth_schema_migrations (version,applied_at) VALUES (?,?)').run(1, new Date().toISOString())
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
}
`

const AUTH_EMAIL = `import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import nodemailer from 'nodemailer'

export interface EmailSender {
  sendCode(message: { email: string; code: string; expiresAt: string }): Promise<void>
  sendInvitation(message: { email: string; expiresAt: string }): Promise<void>
}

export function createEmailSender(env: Readonly<Record<string, string | undefined>> = process.env): EmailSender {
  const mode = env.APP_EMAIL_MODE ?? 'studio-capture'
  if (mode === 'studio-capture' && env.DZ23_STUDIO_VERIFICATION !== '1') throw new Error('STUDIO_CAPTURE_FORBIDDEN_OUTSIDE_VERIFICATION')
  if (mode === 'studio-capture') return new StudioCaptureEmailSender(env.DATA_DIR ?? './data')
  if (mode !== 'smtp') throw new Error('APP_EMAIL_MODE_INVALID')
  const url = required(env.APP_SMTP_URL, 'APP_SMTP_URL')
  const from = required(env.APP_EMAIL_FROM, 'APP_EMAIL_FROM')
  const protocol = new URL(url).protocol
  if (protocol !== 'smtp:' && protocol !== 'smtps:') throw new Error('APP_SMTP_URL_INVALID')
  const transport = nodemailer.createTransport(url, { requireTLS: protocol === 'smtp:' })
  return {
    async sendCode(message) { await transport.sendMail({ from, to: message.email, subject: 'Seu código de acesso', text: \`Use o código \${message.code}. Ele expira em 10 minutos.\` }) },
    async sendInvitation(message) { await transport.sendMail({ from, to: message.email, subject: 'Você recebeu um convite', text: \`Abra o aplicativo e peça seu código até \${message.expiresAt}.\` }) },
  }
}

export class StudioCaptureEmailSender implements EmailSender {
  readonly path: string
  constructor(dataDirectory: string) { this.path = resolve(dataDirectory, 'studio-capture.json') }
  async sendCode(message: { email: string; code: string; expiresAt: string }): Promise<void> { await this.append({ kind: 'code', ...message }) }
  async sendInvitation(message: { email: string; expiresAt: string }): Promise<void> { await this.append({ kind: 'invitation', ...message }) }
  private async append(message: object): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    let current: unknown[] = []
    try { current = JSON.parse(await readFile(this.path, 'utf8')) as unknown[] } catch {}
    await writeFile(this.path, JSON.stringify([...current.slice(-19), message], null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 })
    await chmod(this.path, 0o600)
  }
}

function required(value: string | undefined, name: string): string { if (value === undefined || value === '') throw new Error(\`\${name}_REQUIRED\`); return value }
`

const AUTH_SERVICE = `import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { EmailSender } from './email'
import { migrateAuth } from './migrations'

const TEN_MINUTES = 10 * 60 * 1000
const FIFTEEN_MINUTES = 15 * 60 * 1000
const MINIMUM_ISSUE_INTERVAL = 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const SESSION_TTL = 14 * DAY

export type AppRole = 'owner' | 'member'
export interface AuthSession { id: string; userId: string; email: string; role: AppRole; csrfHash: string; expiresAt: string; revokedAt: string | null }
export class AppAuthError extends Error { constructor(readonly code: 'INVALID' | 'EXPIRED' | 'REVOKED' | 'LOCKED' | 'CSRF' | 'FORBIDDEN', message: string) { super(message) } }
export interface AuthServiceOptions { database: DatabaseSync; sender: EmailSender; ownerEmail: string; now?: () => Date; createId?: () => string; createSecret?: () => string; createCode?: () => string }

export class GeneratedAuthService {
  private readonly database: DatabaseSync
  private readonly sender: EmailSender
  private readonly ownerEmail: string
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly createSecret: () => string
  private readonly createCode: () => string
  constructor(options: AuthServiceOptions) {
    this.database = options.database; this.sender = options.sender; this.ownerEmail = normalizeEmail(options.ownerEmail)
    this.now = options.now ?? (() => new Date()); this.createId = options.createId ?? randomUUID
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'))
    this.createCode = options.createCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'))
    migrateAuth(this.database)
  }
  async requestCode(rawEmail: string): Promise<{ status: 'sent' | 'suppressed'; requestId: string }> {
    const email = normalizeEmail(rawEmail); const now = this.now(); const requestId = this.createSecret(); const nowIso = now.toISOString()
    this.database.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(nowIso)
    const users = Number(this.database.prepare('SELECT count(*) AS total FROM auth_users').get()?.total ?? 0)
    const user = this.database.prepare('SELECT id FROM auth_users WHERE email = ?').get(email)
    const invite = this.database.prepare('SELECT id FROM auth_invites WHERE email = ? AND used_at IS NULL AND expires_at > ?').get(email, nowIso)
    if (user === undefined && invite === undefined && !(users === 0 && email === this.ownerEmail)) return { status: 'suppressed', requestId }
    const windowStart = new Date(now.getTime() - FIFTEEN_MINUTES).toISOString(); const intervalStart = new Date(now.getTime() - MINIMUM_ISSUE_INTERVAL).toISOString()
    const recent = Number(this.database.prepare('SELECT count(*) AS total FROM auth_codes WHERE email = ? AND issued_at > ?').get(email, windowStart)?.total ?? 0)
    const tooSoon = this.database.prepare('SELECT 1 FROM auth_codes WHERE email = ? AND issued_at > ? LIMIT 1').get(email, intervalStart) !== undefined
    if (recent >= 3 || tooSoon) return { status: 'suppressed', requestId }
    const code = this.createCode(); if (!/^\\d{6}$/u.test(code)) throw new AppAuthError('INVALID', 'Código inválido.')
    const expiresAt = new Date(now.getTime() + TEN_MINUTES).toISOString()
    this.database.prepare('INSERT INTO auth_codes (id,request_id,email,code_hash,attempts,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,NULL)').run(this.createId(), requestId, email, hashCode(code), 0, nowIso, expiresAt)
    await this.sender.sendCode({ email, code, expiresAt }); return { status: 'sent', requestId }
  }
  verifyCode(rawEmail: string, requestId: string, code: string): { token: string; csrf: string; session: AuthSession } {
    const email = normalizeEmail(rawEmail); const now = this.now()
    const row = this.database.prepare('SELECT * FROM auth_codes WHERE request_id = ? AND email = ? AND consumed_at IS NULL LIMIT 1').get(requestId, email) as Record<string, unknown> | undefined
    if (row === undefined) throw new AppAuthError('INVALID', 'Código inválido.')
    if (Number(row.attempts) >= 5) throw new AppAuthError('LOCKED', 'Código bloqueado.')
    if (Date.parse(String(row.expires_at)) <= now.getTime()) throw new AppAuthError('EXPIRED', 'Código expirado.')
    if (!matchesCode(code, String(row.code_hash))) {
      const attempts = Number(row.attempts) + 1
      this.database.prepare('UPDATE auth_codes SET attempts = ?, consumed_at = ? WHERE id = ?').run(attempts, attempts >= 5 ? now.toISOString() : null, String(row.id))
      throw new AppAuthError(attempts >= 5 ? 'LOCKED' : 'INVALID', attempts >= 5 ? 'Código bloqueado.' : 'Código inválido.')
    }
    this.database.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now.toISOString(), String(row.id))
    const user = this.ensureUser(email, now)
    const token = this.createSecret(); const csrf = this.createSecret(); const expiresAt = new Date(now.getTime() + SESSION_TTL).toISOString(); const id = this.createId()
    this.database.prepare('INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,expires_at,revoked_at) VALUES (?,?,?,?,?,NULL)').run(id, user.id, hash(token), hash(csrf), expiresAt)
    return { token, csrf, session: { id, userId: user.id, email, role: user.role, csrfHash: hash(csrf), expiresAt, revokedAt: null } }
  }
  authenticate(token: string): AuthSession {
    const row = this.database.prepare('SELECT s.*,u.email,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=?').get(hash(token)) as Record<string, unknown> | undefined
    if (row === undefined) throw new AppAuthError('INVALID', 'Sessão inválida.')
    if (row.revoked_at !== null) throw new AppAuthError('REVOKED', 'Sessão encerrada.')
    if (Date.parse(String(row.expires_at)) <= this.now().getTime()) throw new AppAuthError('EXPIRED', 'Sessão expirada.')
    return { id: String(row.id), userId: String(row.user_id), email: String(row.email), role: String(row.role) as AppRole, csrfHash: String(row.csrf_hash), expiresAt: String(row.expires_at), revokedAt: null }
  }
  validateCsrf(session: AuthSession, cookie: string | undefined, submitted: string | undefined): void {
    if (cookie === undefined || submitted === undefined || cookie !== submitted || !matches(cookie, session.csrfHash)) throw new AppAuthError('CSRF', 'Confirmação de segurança ausente.')
  }
  revoke(token: string): void { this.database.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(this.now().toISOString(), hash(token)) }
  async invite(token: string, csrfCookie: string | undefined, csrfSubmitted: string | undefined, rawEmail: string): Promise<void> {
    const session = this.authenticate(token); this.validateCsrf(session, csrfCookie, csrfSubmitted)
    if (session.role !== 'owner') throw new AppAuthError('FORBIDDEN', 'Somente o proprietário pode convidar pessoas.')
    const email = normalizeEmail(rawEmail); const expiresAt = new Date(this.now().getTime() + DAY).toISOString()
    this.database.prepare('INSERT INTO auth_invites (id,email,invited_by,expires_at,used_at) VALUES (?,?,?,?,NULL) ON CONFLICT(email) DO UPDATE SET invited_by=excluded.invited_by,expires_at=excluded.expires_at,used_at=NULL').run(this.createId(), email, session.userId, expiresAt)
    await this.sender.sendInvitation({ email, expiresAt })
  }
  private ensureUser(email: string, now: Date): { id: string; role: AppRole } {
    const existing = this.database.prepare('SELECT id,role FROM auth_users WHERE email=?').get(email) as { id: string; role: AppRole } | undefined
    if (existing !== undefined) return existing
    const total = Number(this.database.prepare('SELECT count(*) AS total FROM auth_users').get()?.total ?? 0)
    const invited = this.database.prepare('SELECT id FROM auth_invites WHERE email=? AND used_at IS NULL AND expires_at>?').get(email, now.toISOString()) as { id: string } | undefined
    if (!(total === 0 && email === this.ownerEmail) && invited === undefined) throw new AppAuthError('FORBIDDEN', 'Convite necessário.')
    const id = this.createId(); const role: AppRole = total === 0 ? 'owner' : 'member'
    this.database.prepare('INSERT INTO auth_users (id,email,role,created_at) VALUES (?,?,?,?)').run(id, email, role, now.toISOString())
    if (invited !== undefined) this.database.prepare('UPDATE auth_invites SET used_at=? WHERE id=?').run(now.toISOString(), invited.id)
    return { id, role }
  }
}
function normalizeEmail(value: string): string { const email=value.trim().toLowerCase(); if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(email)) throw new AppAuthError('INVALID','E-mail inválido.'); return email }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function matches(value: string, expected: string): boolean { const actual=Buffer.from(hash(value)); const wanted=Buffer.from(expected); return actual.length===wanted.length && timingSafeEqual(actual,wanted) }
function hashCode(value: string): string { const salt=randomBytes(16); return \`\${salt.toString('hex')}:\${scryptSync(value,salt,32).toString('hex')}\` }
function matchesCode(value: string, encoded: string): boolean { const [saltHex,digestHex]=encoded.split(':'); if(saltHex===undefined||digestHex===undefined)return false;const salt=Buffer.from(saltHex,'hex');const actual=scryptSync(value,salt,32);const wanted=Buffer.from(digestHex,'hex');return actual.length===wanted.length&&timingSafeEqual(actual,wanted) }
`

const AUTH_RUNTIME = `import { cookies } from 'next/headers'
import { openDatabase } from '../db/client'
import { createEmailSender } from './email'
import { GeneratedAuthService, type AppRole, type AuthSession } from './service'

export const SESSION_COOKIE = 'dz23_app_session'
export const CSRF_COOKIE = 'dz23_app_csrf'
export const CODE_REQUEST_COOKIE = 'dz23_app_code_request'

function ownerEmail(): string { const value=process.env.APP_OWNER_EMAIL; if (value===undefined || value==='') throw new Error('APP_OWNER_EMAIL_REQUIRED'); return value }
async function useService<T>(work: (service: GeneratedAuthService) => Promise<T> | T): Promise<T> { const database=openDatabase(); try { return await work(new GeneratedAuthService({ database, sender:createEmailSender(), ownerEmail:ownerEmail() })) } finally { database.close() } }
export async function requestAccessCode(email: string): Promise<'sent'|'suppressed'> { const result=await useService(service => service.requestCode(email)); if(result.status==='sent'){const jar=await cookies();jar.set(CODE_REQUEST_COOKIE,result.requestId,{secure:true,httpOnly:true,sameSite:'lax',path:'/',maxAge:10*60})} return result.status }
export async function verifyAccessCode(email: string, code: string): Promise<{ token:string; csrf:string }> { const jar=await cookies(); const requestId=jar.get(CODE_REQUEST_COOKIE)?.value; if(requestId===undefined)throw new Error('CODE_REQUEST_REQUIRED'); const issued=await useService(service => service.verifyCode(email,requestId,code)); jar.delete(CODE_REQUEST_COOKIE); return issued }
export async function currentSession(): Promise<AuthSession | null> { const jar=await cookies(); const token=jar.get(SESSION_COOKIE)?.value; if (token===undefined) return null; try { return await useService(service => service.authenticate(token)) } catch { return null } }
export async function requireFormSession(formData: FormData, roles: readonly AppRole[]=['owner','member']): Promise<AuthSession> { const jar=await cookies(); const token=jar.get(SESSION_COOKIE)?.value; if (token===undefined) throw new Error('AUTH_REQUIRED'); return useService(service => { const session=service.authenticate(token); service.validateCsrf(session,jar.get(CSRF_COOKIE)?.value,String(formData.get('_csrf')??'')); if (!roles.includes(session.role)) throw new Error('ROLE_FORBIDDEN'); return session }) }
export async function setSessionCookies(issued: { token:string; csrf:string }): Promise<void> { const jar=await cookies(); const common={ secure:true, sameSite:'lax' as const, path:'/', maxAge:14*24*60*60 }; jar.set(SESSION_COOKIE,issued.token,{...common,httpOnly:true}); jar.set(CSRF_COOKIE,issued.csrf,{...common,httpOnly:false}) }
export async function csrfForCurrentSession(): Promise<string> { const jar=await cookies(); return jar.get(CSRF_COOKIE)?.value ?? '' }
export async function revokeCurrentSession(formData: FormData): Promise<void> { const jar=await cookies(); const token=jar.get(SESSION_COOKIE)?.value; if (token!==undefined) await useService(service => { const session=service.authenticate(token); service.validateCsrf(session,jar.get(CSRF_COOKIE)?.value,String(formData.get('_csrf')??'')); service.revoke(token) }); jar.delete(SESSION_COOKIE); jar.delete(CSRF_COOKIE) }
export async function inviteFromForm(formData: FormData): Promise<void> { const jar=await cookies(); const token=jar.get(SESSION_COOKIE)?.value; if (token===undefined) throw new Error('AUTH_REQUIRED'); await useService(service => service.invite(token,jar.get(CSRF_COOKIE)?.value,String(formData.get('_csrf')??''),String(formData.get('email')??''))) }
`

const AUTH_ACTIONS = `'use server'
import { redirect } from 'next/navigation'
import { inviteFromForm, requestAccessCode, revokeCurrentSession, setSessionCookies, verifyAccessCode } from './runtime'
export async function requestCodeAction(formData: FormData): Promise<void> { await requestAccessCode(String(formData.get('email')??'')) }
export async function verifyCodeAction(formData: FormData): Promise<void> { const issued=await verifyAccessCode(String(formData.get('email')??''),String(formData.get('code')??'')); await setSessionCookies(issued); redirect('/') }
export async function logoutAction(formData: FormData): Promise<void> { await revokeCurrentSession(formData); redirect('/') }
export async function inviteAction(formData: FormData): Promise<void> { await inviteFromForm(formData) }
`

const ACCESS_PANEL = `import { inviteAction, logoutAction, requestCodeAction, verifyCodeAction } from '../../auth/actions'
import { csrfForCurrentSession, currentSession } from '../../auth/runtime'
export async function AccessPanel() { return <section aria-labelledby="access-title"><h2 id="access-title">Acessar o aplicativo</h2><form action={requestCodeAction} data-testid="request-code-form"><label htmlFor="access-email">E-mail</label><input id="access-email" name="email" type="email" required/><button type="submit">Enviar código</button></form><form action={verifyCodeAction} data-testid="verify-code-form"><label htmlFor="verify-email">E-mail</label><input id="verify-email" name="email" type="email" required/><label htmlFor="access-code">Código de 6 dígitos</label><input id="access-code" name="code" inputMode="numeric" pattern="[0-9]{6}" required/><button type="submit">Entrar</button></form></section> }
export async function AccountPanel() { const session=await currentSession(); if(session===null) return null; const csrf=await csrfForCurrentSession(); return <aside><p data-testid="signed-in-user">Acesso: {session.email} ({session.role==='owner'?'proprietário':'membro'})</p>{session.role==='owner'?<form action={inviteAction}><input type="hidden" name="_csrf" value={csrf}/><label htmlFor="invite-email">Convidar por e-mail</label><input id="invite-email" name="email" type="email" required/><button type="submit">Enviar convite</button></form>:null}<form action={logoutAction}><input type="hidden" name="_csrf" value={csrf}/><button type="submit">Sair</button></form></aside> }
`

const AUTH_SESSION_ROUTE = `import { NextResponse } from 'next/server'
import { currentSession } from '../../../../src/auth/runtime'
export const dynamic = 'force-dynamic'
export async function GET() { const session=await currentSession(); return session===null?NextResponse.json({error:'AUTH_REQUIRED'},{status:401}):NextResponse.json({email:session.email,role:session.role}) }
`

const AUTH_TEST = `// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/client'
import { createEmailSender } from '../src/auth/email'
import { AppAuthError, GeneratedAuthService } from '../src/auth/service'

function fixture() { const directory=mkdtempSync(join(tmpdir(),'dz23-auth-')); const database=openDatabase(directory); let now=new Date('2026-09-03T12:00:00.000Z'); let secret=0; const sent:string[]=[]; const service=new GeneratedAuthService({ database,ownerEmail:'owner@example.test',sender:{sendCode:async m=>{sent.push(m.code)},sendInvitation:async()=>{}},now:()=>now,createId:()=>\`id-\${++secret}\`,createSecret:()=>\`secret-\${++secret}\`,createCode:()=> '123456' }); return {directory,database,service,sent,advance:(ms:number)=>{now=new Date(now.getTime()+ms)},close:()=>{database.close();rmSync(directory,{recursive:true,force:true})}} }
describe('acesso real gerado pelo Studio',()=>{
  it('versiona auth sem avançar as migrações de dados',()=>{const f=fixture();try{expect(f.database.prepare('PRAGMA user_version').get()).toMatchObject({user_version:1});expect(f.database.prepare('SELECT max(version) AS version FROM auth_schema_migrations').get()).toMatchObject({version:1})}finally{f.close()}})
  it('cria o primeiro owner e valida sessão e CSRF',async()=>{const f=fixture();try{const request=await f.service.requestCode('owner@example.test');expect(request.status).toBe('sent');const issued=f.service.verifyCode('owner@example.test',request.requestId,f.sent[0]!);expect(f.service.authenticate(issued.token)).toMatchObject({email:'owner@example.test',role:'owner'});expect(()=>f.service.validateCsrf(issued.session,issued.csrf,undefined)).toThrow(AppAuthError);expect(()=>f.service.validateCsrf(issued.session,issued.csrf,issued.csrf)).not.toThrow();f.service.revoke(issued.token);expect(()=>f.service.authenticate(issued.token)).toThrow('Sessão encerrada')}finally{f.close()}})
  it('isola tentativas por navegador e expira a sessão',async()=>{const f=fixture();try{const first=await f.service.requestCode('owner@example.test');f.advance(61_000);const second=await f.service.requestCode('owner@example.test');for(let attempt=1;attempt<=5;attempt++)expect(()=>f.service.verifyCode('owner@example.test',first.requestId,'000000')).toThrow(attempt===5?'Código bloqueado':'Código inválido');const issued=f.service.verifyCode('owner@example.test',second.requestId,'123456');f.advance(15*24*60*60*1000);expect(()=>f.service.authenticate(issued.token)).toThrow('Sessão expirada')}finally{f.close()}})
  it('permite que o owner convide um member sem elevar o papel',async()=>{const f=fixture();try{const ownerRequest=await f.service.requestCode('owner@example.test');const owner=f.service.verifyCode('owner@example.test',ownerRequest.requestId,'123456');await f.service.invite(owner.token,owner.csrf,owner.csrf,'member@example.test');const memberRequest=await f.service.requestCode('member@example.test');expect(memberRequest.status).toBe('sent');const member=f.service.verifyCode('member@example.test',memberRequest.requestId,'123456');expect(f.service.authenticate(member.token)).toMatchObject({email:'member@example.test',role:'member'});await expect(f.service.invite(member.token,member.csrf,member.csrf,'other@example.test')).rejects.toThrow('Somente o proprietário')}finally{f.close()}})
  it('limita emissão e só permite captura no verificador do Studio',async()=>{const f=fixture();try{expect((await f.service.requestCode('other@example.test')).status).toBe('suppressed');expect((await f.service.requestCode('owner@example.test')).status).toBe('sent');f.advance(61_000);expect((await f.service.requestCode('owner@example.test')).status).toBe('sent');f.advance(61_000);expect((await f.service.requestCode('owner@example.test')).status).toBe('sent');f.advance(61_000);expect((await f.service.requestCode('owner@example.test')).status).toBe('suppressed');expect(()=>createEmailSender({NODE_ENV:'production',APP_EMAIL_MODE:'studio-capture'})).toThrow('STUDIO_CAPTURE_FORBIDDEN_OUTSIDE_VERIFICATION');expect(()=>createEmailSender({NODE_ENV:'development',APP_EMAIL_MODE:'studio-capture'})).toThrow('STUDIO_CAPTURE_FORBIDDEN_OUTSIDE_VERIFICATION');expect(createEmailSender({NODE_ENV:'production',APP_EMAIL_MODE:'studio-capture',DZ23_STUDIO_VERIFICATION:'1'})).toBeInstanceOf(Object);expect(()=>createEmailSender({APP_EMAIL_MODE:'invalid'})).toThrow('APP_EMAIL_MODE_INVALID');expect(()=>createEmailSender({APP_EMAIL_MODE:'smtp',APP_SMTP_URL:'http://example.test',APP_EMAIL_FROM:'owner@example.test'})).toThrow('APP_SMTP_URL_INVALID')}finally{f.close()}})
})
`
