import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  validateAssistantRepository,
  type AssistantRepositoryConfig,
  type ValidatedRepositoryConfig,
} from '@dz23-studio/assistant-bridge'
import { KeyedMutex, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import { roleAllows } from '@dz23-studio/policy'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { t } from './i18n.js'

export const ASSISTANT_AGENT_PRESET = 'dz23-assistant'

export type AssistantRepositoryLaunchConfig = AssistantRepositoryConfig

export interface AssistantSessionControllerPort {
  create(request: {
    readonly cwd: string
    readonly sessionId?: SessionId
    readonly agentPreset: string
  }): Promise<{ readonly sessionId: SessionId; readonly agentPreset?: string }>
  inspect(sessionId: SessionId): Promise<{
    readonly meta: { readonly cwd?: string; readonly agentPreset?: string }
  }>
}

export interface AssistantSessionLaunch {
  readonly session_id: string
  readonly reused: boolean
  readonly preset: typeof ASSISTANT_AGENT_PRESET
}

export class AssistantSessionLaunchError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'FORBIDDEN' | 'SESSION_CONFLICT' | 'SESSION_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

export interface AssistantSessionLauncherOptions {
  readonly identity: Pick<StudioIdentityService, 'bindHarnessSession' | 'isSharedHarnessClientAllowed' | 'releaseHarnessSession'>
  readonly tenancy: Pick<StudioTenancyService, 'authorizationFor'>
  readonly sessions: AssistantSessionControllerPort
  readonly repositories: readonly AssistantRepositoryLaunchConfig[]
  /**
   * A pasta de trabalho PESSOAL, quando o espaço não tem repositório.
   *
   * O assistente nascia amarrado a um repositório git configurado à mão em
   * `DZ23_ASSISTANT_REPOSITORIES`; sem ele, "Conversar com o FRIGG" respondia
   * "não configurado" — e a instalação pessoal nunca o configura. Pedido do
   * titular em 19/09/2026: o FRIGG deve fazer o que um agente geral faz
   * (pesquisar, ler e escrever arquivos, rodar comandos). Isso precisa de um
   * lugar para trabalhar, e não de um repositório. Cada espaço ganha a sua
   * pasta, 0700, debaixo desta raiz; as ferramentas de repositório continuam
   * exigindo repositório.
   */
  readonly workspaceRoot?: string
  readonly reportFailure?: (phase: 'inspect' | 'create' | 'adopt', error: unknown) => void
}

/**
 * Creates or resumes the one governed Assistant conversation owned by a
 * Studio device session. The Harness remains the sole chat implementation;
 * this service only binds its durable Session to the authenticated identity.
 */
export class AssistantSessionLauncher {
  readonly #mutex = new KeyedMutex()
  readonly #activeByIdentitySession = new Map<string, string>()

  private constructor(
    private readonly options: Omit<AssistantSessionLauncherOptions, 'repositories'>,
    private readonly repositories: readonly ValidatedRepositoryConfig[],
  ) {}

  static async create(options: AssistantSessionLauncherOptions): Promise<AssistantSessionLauncher> {
    const repositories = await validateRepositories(options.repositories)
    return new AssistantSessionLauncher(options, repositories)
  }

  launch(identitySession: SessionRecord): Promise<AssistantSessionLaunch> {
    if (!this.options.identity.isSharedHarnessClientAllowed(identitySession)) {
      return Promise.reject(new AssistantSessionLaunchError('FORBIDDEN', t('assistant.personalOnly')))
    }
    return this.launchTenantConversation(identitySession)
  }

  /**
   * A pasta em que a conversa desta pessoa trabalha: o repositório liberado,
   * ou a pasta pessoal do espaço. `undefined` quando não há nenhuma.
   * @param identitySession - a sessão.
   * @param permissao - a permissão exigida (ler a lista, ou mandar arquivo).
   * @returns o caminho.
   */
  async pastaDeTrabalho(identitySession: SessionRecord, permissao: 'project.read' | 'project.write'): Promise<string | undefined> {
    const authorization = this.options.tenancy.authorizationFor(identitySession.user_id, identitySession.org_id, identitySession.tenant_id)
    if (authorization === undefined || !roleAllows(authorization.role, permissao)) {
      throw new AssistantSessionLaunchError('FORBIDDEN', t('assistant.forbidden'))
    }
    const repository = this.repositories.find(candidate => (
      candidate.orgId === identitySession.org_id && candidate.tenantId === identitySession.tenant_id
      && candidate.workspaceId === identitySession.tenant_id
    ))
    return repository?.repositoryPath ?? this.#pastaPessoal(identitySession)
  }

  launchTenantConversation(identitySession: SessionRecord): Promise<AssistantSessionLaunch> {
    return this.#mutex.run(`assistant-session:${identitySession.session_id}`, () => (
      this.#launchLocked(identitySession)
    ))
  }

  async #launchLocked(identitySession: SessionRecord): Promise<AssistantSessionLaunch> {
    const authorization = this.options.tenancy.authorizationFor(
      identitySession.user_id,
      identitySession.org_id,
      identitySession.tenant_id,
    )
    if (authorization === undefined || !roleAllows(authorization.role, 'project.write')) {
      throw new AssistantSessionLaunchError('FORBIDDEN', t('assistant.forbidden'))
    }
    const repository = this.repositories.find(candidate => (
      candidate.orgId === identitySession.org_id
      && candidate.tenantId === identitySession.tenant_id
      && candidate.workspaceId === identitySession.tenant_id
    ))
    const cwd = repository?.repositoryPath ?? await this.#pastaPessoal(identitySession)
    if (cwd === undefined) {
      throw new AssistantSessionLaunchError(
        'NOT_CONFIGURED',
        t('assistant.notConfigured'),
      )
    }

    const existing = await this.#existingSession(identitySession, cwd)
    if (existing !== undefined) {
      await this.options.identity.bindHarnessSession(identitySession, existing)
      return { session_id: existing, reused: true, preset: ASSISTANT_AGENT_PRESET }
    }

    let created: { readonly sessionId: SessionId; readonly agentPreset?: string }
    try {
      created = await this.options.sessions.create({
        cwd,
        agentPreset: ASSISTANT_AGENT_PRESET,
      })
    } catch (error) {
      this.options.reportFailure?.('create', error)
      throw new AssistantSessionLaunchError(
        'SESSION_UNAVAILABLE',
        t('assistant.createUnavailable'),
      )
    }
    if (created.agentPreset !== ASSISTANT_AGENT_PRESET) {
      throw new AssistantSessionLaunchError(
        'SESSION_CONFLICT',
        t('assistant.presetConflict'),
      )
    }
    await this.options.identity.bindHarnessSession(identitySession, String(created.sessionId))
    this.#activeByIdentitySession.set(identitySession.session_id, String(created.sessionId))
    return {
      session_id: String(created.sessionId),
      reused: false,
      preset: ASSISTANT_AGENT_PRESET,
    }
  }

  /**
   * Drops a pointer the Harness itself refused to resume. Losing the pointer is
   * never worse than keeping it: the conversation is already unreachable. A
   * failure to record the release must not break opening a new conversation, so
   * it is reported and swallowed.
   */
  async #release(identitySession: SessionRecord, harnessSessionId: string, reason: string): Promise<void> {
    this.#activeByIdentitySession.delete(identitySession.session_id)
    try {
      await this.options.identity.releaseHarnessSession(identitySession, harnessSessionId, reason)
    } catch (error) {
      this.options.reportFailure?.('inspect', error)
    }
  }

  /** A pasta do espaço, criada na primeira vez; `undefined` sem raiz configurada. */
  async #pastaPessoal(identitySession: SessionRecord): Promise<string | undefined> {
    if (this.options.workspaceRoot === undefined) return undefined
    const pasta = pastaDoEspaco(this.options.workspaceRoot, identitySession.org_id, identitySession.tenant_id)
    await mkdir(pasta, { recursive: true, mode: 0o700 })
    const entrada = await lstat(pasta)
    const raizReal = await realpath(this.options.workspaceRoot)
    const pastaReal = await realpath(pasta)
    if (!entrada.isDirectory() || pastaReal !== pastaDoEspaco(raizReal, identitySession.org_id, identitySession.tenant_id)) {
      throw new AssistantSessionLaunchError('FORBIDDEN', t('assistant.forbidden'))
    }
    return pastaReal
  }

  async #existingSession(
    identitySession: SessionRecord,
    cwd: string,
  ): Promise<string | undefined> {
    const active = this.#activeByIdentitySession.get(identitySession.session_id)
    const candidates = [...new Set([
      ...(active === undefined ? [] : [active]),
      ...[...identitySession.harness_session_ids].reverse(),
    ])]
    for (const rawId of candidates) {
      const sessionId = rawId as SessionId
      let inspected: Awaited<ReturnType<AssistantSessionControllerPort['inspect']>>
      try {
        inspected = await this.options.sessions.inspect(sessionId)
      } catch (error) {
        if (error instanceof ApiSessionNotFound) {
          await this.#release(identitySession, rawId, t('assistant.releasedMissing'))
          continue
        }
        this.options.reportFailure?.('inspect', error)
        throw new AssistantSessionLaunchError(
          'SESSION_UNAVAILABLE',
          t('assistant.inspectUnavailable'),
        )
      }
      if (inspected.meta.agentPreset !== ASSISTANT_AGENT_PRESET) {
        await this.#release(identitySession, rawId, t('assistant.releasedForeign'))
        continue
      }
      if (inspected.meta.cwd !== cwd) {
        throw new AssistantSessionLaunchError(
          'SESSION_CONFLICT',
          t('assistant.repositoryConflict'),
        )
      }
      try {
        const adopted = await this.options.sessions.create({
          cwd,
          sessionId,
          agentPreset: ASSISTANT_AGENT_PRESET,
        })
        if (adopted.agentPreset !== ASSISTANT_AGENT_PRESET) throw new Error('preset mismatch')
      } catch (error) {
        this.options.reportFailure?.('adopt', error)
        throw new AssistantSessionLaunchError(
          'SESSION_CONFLICT',
          t('assistant.adoptConflict'),
        )
      }
      this.#activeByIdentitySession.set(identitySession.session_id, rawId)
      return rawId
    }
    return undefined
  }
}

async function validateRepositories(
  values: readonly AssistantRepositoryLaunchConfig[],
): Promise<readonly ValidatedRepositoryConfig[]> {
  if (!Array.isArray(values)) throw new Error(t('assistant.repositoriesList'))
  const repositories = await Promise.all(values.map(validateAssistantRepository))
  const keys = repositories.map(repository => `${repository.orgId}\u0000${repository.tenantId}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error(t('assistant.duplicateRepository'))
  }
  return repositories
}

/**
 * A pasta de um espaço: o NOME é derivado do escopo (org e espaço), nunca
 * escrito por quem pede, então nenhum valor de fora escolhe o caminho.
 * @param raiz - a raiz absoluta.
 * @param orgId - a organização.
 * @param tenantId - o espaço.
 * @returns o caminho.
 */
export function pastaDoEspaco(raiz: string, orgId: string, tenantId: string): string {
  if (!isAbsolute(raiz)) throw new Error(t('assistant.workspaceRootAbsolute'))
  const nome = createHash('sha256').update(`${orgId}\u0000${tenantId}`).digest('hex').slice(0, 32)
  return join(raiz, nome)
}

