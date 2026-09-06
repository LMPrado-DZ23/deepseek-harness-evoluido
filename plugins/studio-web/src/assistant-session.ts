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
  readonly identity: Pick<StudioIdentityService, 'bindHarnessSession'>
  readonly tenancy: Pick<StudioTenancyService, 'authorizationFor'>
  readonly sessions: AssistantSessionControllerPort
  readonly repositories: readonly AssistantRepositoryLaunchConfig[]
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
    if (authorization === undefined || !roleAllows(authorization.role, 'project.read')) {
      throw new AssistantSessionLaunchError('FORBIDDEN', 'Seu acesso a este projeto não está ativo.')
    }
    const repository = this.repositories.find(candidate => (
      candidate.orgId === identitySession.org_id
      && candidate.tenantId === identitySession.tenant_id
      && candidate.workspaceId === identitySession.tenant_id
    ))
    if (repository === undefined) {
      throw new AssistantSessionLaunchError(
        'NOT_CONFIGURED',
        'O administrador ainda não liberou um projeto para esta conversa.',
      )
    }

    const existing = await this.#existingSession(identitySession, repository)
    if (existing !== undefined) {
      await this.options.identity.bindHarnessSession(identitySession, existing)
      return { session_id: existing, reused: true, preset: ASSISTANT_AGENT_PRESET }
    }

    let created: { readonly sessionId: SessionId; readonly agentPreset?: string }
    try {
      created = await this.options.sessions.create({
        cwd: repository.repositoryPath,
        agentPreset: ASSISTANT_AGENT_PRESET,
      })
    } catch (error) {
      this.options.reportFailure?.('create', error)
      throw new AssistantSessionLaunchError(
        'SESSION_UNAVAILABLE',
        'A conversa não pôde ser criada agora. Tente novamente em instantes.',
      )
    }
    if (created.agentPreset !== ASSISTANT_AGENT_PRESET) {
      throw new AssistantSessionLaunchError(
        'SESSION_CONFLICT',
        'A conversa foi recusada porque o perfil seguro não foi aplicado.',
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

  async #existingSession(
    identitySession: SessionRecord,
    repository: ValidatedRepositoryConfig,
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
        if (error instanceof ApiSessionNotFound) continue
        this.options.reportFailure?.('inspect', error)
        throw new AssistantSessionLaunchError(
          'SESSION_UNAVAILABLE',
          'A conversa existente não pôde ser conferida agora. Tente novamente em instantes.',
        )
      }
      if (inspected.meta.agentPreset !== ASSISTANT_AGENT_PRESET) continue
      if (inspected.meta.cwd !== repository.repositoryPath) {
        throw new AssistantSessionLaunchError(
          'SESSION_CONFLICT',
          'A conversa existente pertence a outro projeto e não será aberta.',
        )
      }
      try {
        const adopted = await this.options.sessions.create({
          cwd: repository.repositoryPath,
          sessionId,
          agentPreset: ASSISTANT_AGENT_PRESET,
        })
        if (adopted.agentPreset !== ASSISTANT_AGENT_PRESET) throw new Error('preset mismatch')
      } catch (error) {
        this.options.reportFailure?.('adopt', error)
        throw new AssistantSessionLaunchError(
          'SESSION_CONFLICT',
          'A conversa existente não pôde ser retomada com o perfil seguro.',
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
  if (!Array.isArray(values)) throw new Error('assistantRepositories deve ser uma lista.')
  const repositories = await Promise.all(values.map(validateAssistantRepository))
  const keys = repositories.map(repository => `${repository.orgId}\u0000${repository.tenantId}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error('Existe mais de um projeto do Assistente para a mesma organização e espaço.')
  }
  return repositories
}
