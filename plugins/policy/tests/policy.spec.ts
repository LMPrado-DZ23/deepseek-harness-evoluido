import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  StudioPolicyEngine,
  STUDIO_POLICY_AUDIT_LOGICAL_DOMAIN,
  STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN,
  apply,
  policyAuditRecordSchema,
  type PolicyAuditRecord,
  policyAuditEntryHash,
  POLICY_AUDIT_CHAIN_ROOT,
  verifyPolicyAuditChain,
  policyDecisionEventSchema,
  policyDecisionSchema,
  studioPolicyAuditDomainSpec,
  assertRouteContracts,
  roleAllows,
  roleCanAssign,
  studioRouteContractSchema,
  type PolicyPluginConfig,
  type PolicyTier,
  type ToolPolicyRule,
} from '../src/index.ts'

const TIERS = ['T0', 'T1', 'T2', 'T3'] as const
const RANK: Readonly<Record<PolicyTier, number>> = { T0: 0, T1: 1, T2: 2, T3: 3 }

function rule(overrides: Partial<ToolPolicyRule> = {}): ToolPolicyRule {
  return {
    source: { kind: 'studio' },
    sandboxMode: 'workspace-write',
    ...overrides,
  }
}

function expectedKind(tier: PolicyTier): 'allow' | 'ask' {
  return RANK[tier] <= RANK.T1 ? 'allow' : 'ask'
}

interface TableCase {
  readonly label: string
  readonly rule: ToolPolicyRule
  readonly expectedTier: PolicyTier
}

const conflictCases: TableCase[] = TIERS.flatMap(inferred => TIERS.map(manifest => ({
  label: `conflito ${inferred} x ${manifest}`,
  rule: rule({ inferredTier: inferred, manifestTier: manifest }),
  expectedTier: TIERS[Math.max(RANK[inferred], RANK[manifest])]!,
})))

const singleDeclarationCases: TableCase[] = (['inferredTier', 'manifestTier', 'policyTier'] as const)
  .flatMap(field => TIERS.map(tier => ({
    label: `${field} sozinho ${tier}`,
    rule: rule({ [field]: tier }),
    expectedTier: tier,
  })))

const invalidTierCases: TableCase[] = (['inferredTier', 'manifestTier', 'policyTier'] as const)
  .flatMap(field => ['t0', 'T4', '', 2].map(value => ({
    label: `${field} inválido ${JSON.stringify(value)}`,
    rule: rule({ [field]: value }),
    expectedTier: 'T2' as const,
  })))

const mcpCases: TableCase[] = TIERS.map(tier => ({
  label: `MCP externo declarado ${tier}`,
  rule: rule({ source: { kind: 'mcp', external: true }, inferredTier: tier }),
  expectedTier: tier === 'T3' ? 'T3' : 'T2',
}))

const dangerCases: TableCase[] = TIERS.map(tier => ({
  label: `danger-full-access partindo de ${tier}`,
  rule: rule({ inferredTier: tier, sandboxMode: 'danger-full-access' }),
  expectedTier: 'T3',
}))

const downgradeCases: TableCase[] = [
  {
    label: 'rebaixamento bilateral explícito T2 para T0/T1',
    rule: rule({ inferredTier: 'T2', manifestTier: 'T0', policyTier: 'T1', allowManifestDowngrade: true }),
    expectedTier: 'T1',
  },
  {
    label: 'rebaixamento unilateral continua mais restritivo',
    rule: rule({ inferredTier: 'T3', manifestTier: 'T0', policyTier: 'T1' }),
    expectedTier: 'T3',
  },
]

const sandboxAndT3Cases: TableCase[] = [
  {
    label: 'T1 com workspace-write continua automático',
    rule: rule({ inferredTier: 'T1', sandboxMode: 'workspace-write' }),
    expectedTier: 'T1',
  },
  {
    label: 'T1 sem sandbox sobe para T2',
    rule: { source: { kind: 'studio' }, inferredTier: 'T1' },
    expectedTier: 'T2',
  },
  {
    label: 'T1 com sandbox indisponível sobe para T2',
    rule: rule({ inferredTier: 'T1', sandboxMode: 'unavailable' }),
    expectedTier: 'T2',
  },
  {
    label: 'T1 com efeito externo sobe para T2 mesmo em workspace-write',
    rule: rule({ source: { kind: 'studio', external: true }, inferredTier: 'T1' }),
    expectedTier: 'T2',
  },
  {
    label: 'T3 nunca aceita rebaixamento bilateral para T0',
    rule: rule({ inferredTier: 'T3', manifestTier: 'T0', policyTier: 'T0', allowManifestDowngrade: true }),
    expectedTier: 'T3',
  },
]

const TABLE_CASES = [
  ...conflictCases,
  ...singleDeclarationCases,
  ...invalidTierCases,
  ...mcpCases,
  ...dangerCases,
  ...downgradeCases,
  ...sandboxAndT3Cases,
]

describe('DZ23 STUDIO policy engine', () => {
  it('keeps the mandatory decision table at or above fifty cases', () => {
    expect(TABLE_CASES.length).toBeGreaterThanOrEqual(50)
  })

  it.each(TABLE_CASES)('$label', ({ rule: current, expectedTier }) => {
    const decision = new StudioPolicyEngine({ rules: { tool: current } })
      .evaluate('tool', { strongIdentityVerified: true })
    expect(decision).toMatchObject({
      toolName: 'tool',
      effectiveTier: expectedTier,
      kind: expectedKind(expectedTier),
      ruleSource: 'catalog',
    })
    expect(policyDecisionSchema.parse(decision)).toEqual(decision)
  })

  it('uses the safe T2 default for an unclassified tool and rejects an empty identity', () => {
    const engine = new StudioPolicyEngine()
    expect(engine.evaluate('unknown')).toMatchObject({ effectiveTier: 'T2', kind: 'ask', ruleSource: 'safe-default' })
    expect(engine.evaluate('  ')).toMatchObject({ toolName: '<invalid>', kind: 'deny', ruleSource: 'invalid-rule' })
  })

  it('blocks invalid rules, explicit blocks, and unsigned stable plugins', () => {
    const engine = new StudioPolicyEngine({
      rules: {
        invalid: { source: { kind: 'studio' }, inferredTier: 'T0', extra: true } as never,
        blocked: rule({ inferredTier: 'T0', blocked: true }),
        unsigned: rule({ source: { kind: 'plugin', stableChannel: true }, inferredTier: 'T0' }),
        signed: rule({ source: { kind: 'plugin', signed: true }, inferredTier: 'T0' }),
        preview: rule({ source: { kind: 'plugin', stableChannel: false }, inferredTier: 'T1' }),
      },
    })
    expect(engine.evaluate('invalid')).toMatchObject({ kind: 'deny', ruleSource: 'invalid-rule' })
    expect(engine.evaluate('blocked')).toMatchObject({ kind: 'deny' })
    expect(engine.evaluate('unsigned')).toMatchObject({ kind: 'deny' })
    expect(engine.evaluate('signed')).toMatchObject({ kind: 'allow' })
    expect(engine.evaluate('preview')).toMatchObject({ kind: 'allow' })
  })

  it('fails T3 closed without strong identity and asks after strong identity', () => {
    const engine = new StudioPolicyEngine({ rules: { deploy: rule({ inferredTier: 'T3' }) } })
    expect(engine.evaluate('deploy')).toMatchObject({ kind: 'deny', effectiveTier: 'T3' })
    expect(engine.evaluate('deploy', { strongIdentityVerified: true }))
      .toMatchObject({ kind: 'ask', effectiveTier: 'T3' })
  })

  it('enforces permission declarations and the four roles without billing concepts', () => {
    const secured = new StudioPolicyEngine({
      requireAuthorizationDeclarations: true,
      rules: {
        write: rule({ inferredTier: 'T1', requiredPermission: 'project.write', scope: 'project' }),
        undeclared: rule({ inferredTier: 'T0' }),
      },
    })
    expect(secured.evaluate('missing')).toMatchObject({ kind: 'deny', ruleSource: 'safe-default' })
    expect(secured.evaluate('undeclared')).toMatchObject({ kind: 'deny', ruleSource: 'invalid-rule' })
    expect(secured.evaluate('write')).toMatchObject({ kind: 'deny', reason: expect.stringContaining('vínculo') })
    expect(secured.evaluate('write', {
      authorization: { userId: 'viewer', orgId: 'org', tenantId: 'tenant', role: 'viewer' },
    })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('papel') })
    expect(secured.evaluate('write', {
      authorization: { userId: 'builder', orgId: 'org', tenantId: 'tenant', role: 'builder' },
    })).toMatchObject({ kind: 'allow' })
    expect(roleAllows('owner', 'project.delete')).toBe(true)
    expect(roleAllows('admin', 'project.delete')).toBe(false)
    expect(roleAllows('admin', 'workspace.create')).toBe(false)
    expect(roleAllows('builder', 'project.publish_staging')).toBe(true)
    expect(roleAllows('viewer', 'project.write')).toBe(false)
    expect(roleCanAssign('owner', 'owner')).toBe(true)
    expect(roleCanAssign('admin', 'builder')).toBe(true)
    expect(roleCanAssign('admin', 'admin')).toBe(false)
    expect(roleCanAssign('viewer', 'viewer')).toBe(false)
  })

  it('validates route contracts and rejects missing permissions or duplicates', () => {
    const route = { method: 'GET', path: '/workspaces', access: 'authorized', permission: 'workspace.read', scope: 'org' } as const
    expect(studioRouteContractSchema.parse(route)).toEqual(route)
    expect(() => assertRouteContracts([route, route])).toThrow(/duplicado/)
    expect(() => studioRouteContractSchema.parse({ ...route, permission: null })).toThrow()
    expect(() => studioRouteContractSchema.parse({ ...route, access: 'public' })).toThrow()
  })
})

function execution(name = 'safe', args: unknown = {}) {
  return {
    name,
    callId: 'call-1',
    arguments: args,
    agent: { session: { id: 'session-1' } },
  } as unknown as ToolExecution
}

async function mounted(config: PolicyPluginConfig = {}, useRuntimeDefaults = false) {
  let hook: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  let cleanup: (() => Promise<void>) | undefined
  const records = new Map<string, unknown>()
  const put = vi.fn(async (key: string, value: unknown) => { records.set(key, value) })
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const domain = { table: vi.fn().mockReturnValue({ put, entries: () => new Map(records).entries() }), close }
  const emit = vi.fn()
  const ctx = {
    on: vi.fn((_event, listener) => { hook = listener }),
    emit,
    storageDomain: { open: vi.fn().mockResolvedValue(domain) },
    effect: vi.fn((factory: () => () => Promise<void>) => { cleanup = factory() }),
    provide: vi.fn(),
  }
  const effectiveConfig = useRuntimeDefaults
    ? config
    : {
        createAuditId: () => 'audit-1',
        now: () => new Date('2026-09-02T12:00:00.000Z'),
        ...config,
      }
  await apply(ctx as never, effectiveConfig)
  return { ctx, hook, put, close, cleanup }
}

describe('authoritative tools/pre-execute integration', () => {
  it('delegates an allowed action and writes the final audit event', async () => {
    const { ctx, hook, put, close, cleanup } = await mounted({
      rules: { safe: rule({ inferredTier: 'T0' }) },
      resolveScope: () => ({ orgId: 'org-23', tenantId: 'tenant-23' }),
    })
    await expect(hook?.(execution('safe'), async () => ({ kind: 'allow' })))
      .resolves.toEqual({ kind: 'allow' })
    const event = policyDecisionEventSchema.parse(ctx.emit.mock.calls[0]?.[1])
    expect(event).toMatchObject({ toolName: 'safe', callId: 'call-1', effectiveTier: 'T0', kind: 'allow' })
    const body = {
      audit_id: 'audit-1',
      session_id: 'session-1',
      org_id: 'org-23',
      tenant_id: 'tenant-23',
      created_at: '2026-09-02T12:00:00.000Z',
      tool_name: event.toolName,
      call_id: event.callId,
      effective_tier: event.effectiveTier,
      decision: event.kind,
      reason: event.reason,
      rule_source: event.ruleSource,
      // Primeira entrada: nao ha anterior, e a raiz de zeros diz isso.
      seq: 0,
      previous_sha256: POLICY_AUDIT_CHAIN_ROOT,
    }
    expect(put).toHaveBeenCalledWith('audit-1', policyAuditRecordSchema.parse({
      ...body, entry_sha256: policyAuditEntryHash(body),
    }))
    expect(STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN).toBe('studio_policy_audit')
    expect(STUDIO_POLICY_AUDIT_LOGICAL_DOMAIN).toBe('studio.policy.audit')
    expect(ctx.storageDomain.open).toHaveBeenCalledWith(studioPolicyAuditDomainSpec)
    const runtime = ctx.provide.mock.calls[0]?.[1] as {
      auditRecords(): readonly unknown[]
      setIdentityResolver(resolver: () => { authenticated: boolean; strongIdentityVerified: boolean }): () => void
    }
    expect(runtime.auditRecords()).toHaveLength(1)
    const unsetStrongIdentity = runtime.setIdentityResolver(() => ({ authenticated: true, strongIdentityVerified: true }))
    unsetStrongIdentity()
    await cleanup?.()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    { downstream: { kind: 'ask', reason: 'outra política pede confirmação' } as const, expected: 'ask' },
    { downstream: { kind: 'ask' } as const, expected: 'ask' },
    { downstream: { kind: 'deny', reason: 'outra política bloqueou' } as const, expected: 'deny' },
  ])('preserves a more restrictive downstream $expected decision %#', async ({ downstream, expected }) => {
    const { ctx, hook } = await mounted({ rules: { safe: rule({ inferredTier: 'T0' }) } })
    await expect(hook?.(execution(), async () => downstream)).resolves.toMatchObject({ kind: expected })
    const event = ctx.emit.mock.calls[0]?.[1]
    expect(event).toMatchObject({ kind: expected })
    if ('reason' in downstream) expect(event).toMatchObject({ reason: downstream.reason })
    else expect(event).toMatchObject({ reason: 'Leitura segura autorizada automaticamente.' })
  })

  it('does not delegate an action that requires approval', async () => {
    const next = vi.fn<() => Promise<PreToolDecision>>().mockResolvedValue({ kind: 'allow' })
    const { hook } = await mounted({ rules: { external: rule({ inferredTier: 'T2' }) } })
    await expect(hook?.(execution('external'), next)).resolves.toMatchObject({ kind: 'ask' })
    expect(next).not.toHaveBeenCalled()
  })

  it('converts only a matching, sufficiently strong delegation grant into a scoped allow', async () => {
    const next = vi.fn<() => Promise<PreToolDecision>>().mockResolvedValue({ kind: 'allow' })
    const { ctx, hook, put } = await mounted({
      strongIdentityVerified: () => true,
      rules: {
        write: rule({ inferredTier: 'T2' }),
        deploy: rule({ inferredTier: 'T3', sandboxMode: 'danger-full-access' }),
      },
    })
    const runtime = ctx.provide.mock.calls[0]?.[1] as {
      setDelegationGrantResolver(resolver: (execution: ToolExecution) => { approvedTier: 'T2' | 'T3'; reason: string } | undefined): () => void
    }
    const unset = runtime.setDelegationGrantResolver(current => current.name === 'write'
      ? { approvedTier: 'T2', reason: 'delegação isolada aprovada' }
      : { approvedTier: 'T2', reason: 'insuficiente' })
    await expect(hook?.(execution('write'), next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledOnce()
    expect(put.mock.calls[0]?.[1]).toMatchObject({ decision: 'allow', reason: 'delegação isolada aprovada' })
    await expect(hook?.(execution('deploy'), next)).resolves.toMatchObject({ kind: 'ask' })
    unset()
    await expect(hook?.(execution('write'), next)).resolves.toMatchObject({ kind: 'ask' })
  })

  it('blocks the next tool call immediately when the identity session is invalid', async () => {
    const next = vi.fn<() => Promise<PreToolDecision>>().mockResolvedValue({ kind: 'allow' })
    const { ctx, hook } = await mounted({ rules: { safe: rule({ inferredTier: 'T0' }) } })
    const runtime = ctx.provide.mock.calls[0]?.[1] as {
      setIdentityResolver(resolver: () => { authenticated: boolean; strongIdentityVerified: boolean }): () => void
    }
    runtime.setIdentityResolver(() => ({ authenticated: false, strongIdentityVerified: false }))
    await expect(hook?.(execution('safe'), next)).resolves.toMatchObject({
      kind: 'deny', reason: 'Sessão de identidade ausente, expirada ou revogada.',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('uses membership authorization for role and scope and blocks cross-tenant arguments', async () => {
    const next = vi.fn<() => Promise<PreToolDecision>>().mockResolvedValue({ kind: 'allow' })
    const { ctx, hook, put } = await mounted({
      requireAuthorizationDeclarations: true,
      rules: { safe: rule({ inferredTier: 'T0', requiredPermission: 'project.read', scope: 'project' }) },
    })
    const runtime = ctx.provide.mock.calls[0]?.[1] as {
      setAuthorizationResolver(resolver: () => { userId: string; orgId: string; tenantId: string; role: 'viewer' }): () => void
    }
    const unset = runtime.setAuthorizationResolver(() => ({ userId: 'user', orgId: 'org-a', tenantId: 'tenant-a', role: 'viewer' }))
    await expect(hook?.(execution('safe', { org_id: 'org-a', tenant_id: 'tenant-a' }), next)).resolves.toEqual({ kind: 'allow' })
    expect(put.mock.calls[0]?.[1]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a' })
    await expect(hook?.(execution('safe', { tenant_id: 'tenant-b' }), next)).resolves.toMatchObject({
      kind: 'deny', reason: expect.stringContaining('outra organização ou espaço'),
    })
    await expect(hook?.(execution('safe', null), next)).resolves.toEqual({ kind: 'allow' })
    unset()
  })

  it('blocks an agent-less call because it cannot create a session audit event', async () => {
    const { ctx, hook, put } = await mounted()
    const exec = { name: 'unknown', callId: 'agentless' } as unknown as ToolExecution
    await expect(hook?.(exec, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    expect(ctx.emit.mock.calls[0]?.[1]).toMatchObject({ callId: 'agentless', kind: 'deny' })
    expect(put.mock.calls[0]?.[1]).toMatchObject({ session_id: 'agentless' })
  })

  it('fails closed if the durable audit cannot be written', async () => {
    const { ctx, hook, put } = await mounted({ rules: { safe: rule({ inferredTier: 'T0' }) } })
    put.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(hook?.(execution(), async () => ({ kind: 'allow' }))).resolves.toMatchObject({
      kind: 'deny',
      reason: 'Não foi possível registrar a auditoria; a ação foi bloqueada.',
    })
    expect(ctx.emit.mock.calls[0]?.[1]).toMatchObject({ kind: 'deny' })
  })

  it('fails closed if tenant scope is invalid before the audit write', async () => {
    const { ctx, hook, put } = await mounted({
      rules: { safe: rule({ inferredTier: 'T0' }) },
      resolveScope: () => ({ orgId: '', tenantId: '' }),
    })
    await expect(hook?.(execution(), async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    expect(put).not.toHaveBeenCalled()
    expect(ctx.emit.mock.calls[0]?.[1]).toMatchObject({ kind: 'deny' })
  })

  it('creates production audit identifiers and timestamps when no test clock is supplied', async () => {
    const { hook, put } = await mounted({
      rules: { sensitive: rule({ inferredTier: 'T3' }) },
      strongIdentityVerified: () => true,
    }, true)
    await expect(hook?.(execution('sensitive'), async () => ({ kind: 'allow' })))
      .resolves.toMatchObject({ kind: 'ask' })
    const record = policyAuditRecordSchema.parse(put.mock.calls[0]?.[1])
    expect(record.audit_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(record.created_at))).toBe(false)
    expect(record).toMatchObject({ org_id: 'org_local', tenant_id: 'tenant_local' })
  })

  it('enforces policy inside the real Harness tool registry and durable session', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ToolRuntime)
    const put = vi.fn().mockResolvedValue(undefined)
    ctx.provide('storageDomain', {
      open: vi.fn().mockResolvedValue({ table: vi.fn().mockReturnValue({ put, entries: () => new Map().entries() }), close: vi.fn() }),
    } as never)
    let dispatches = 0
    const probe = defineTool({
      name: 'real_safe_tool',
      description: 'Real policy seam probe.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        dispatches += 1
        return 'executed'
      },
    })
    ctx.tools.register(probe)
    ctx.tools.register({ ...probe, name: 'unclassified_tool' })
    await apply(ctx, {
      rules: { real_safe_tool: rule({ inferredTier: 'T0' }) },
      createAuditId: () => 'real-audit',
      now: () => new Date('2026-09-02T12:00:00.000Z'),
    })
    const session = ctx.sessions.create()
    const agent = { session } as never
    const signal = new AbortController().signal

    const allowed = await ctx.tools.execute({
      signal,
      callId: ToolCallId('real-allowed'),
      name: 'real_safe_tool',
      arguments: {},
      agent,
    })
    expect(allowed).toMatchObject({ isError: false, value: 'executed' })
    expect(dispatches).toBe(1)
    expect(put.mock.calls[0]?.[1])
      .toMatchObject({ call_id: 'real-allowed', effective_tier: 'T0', decision: 'allow' })

    const unknown = await ctx.tools.execute({
      signal,
      callId: ToolCallId('real-unclassified'),
      name: 'unclassified_tool',
      arguments: {},
      agent,
    })
    expect(unknown.isError).toBe(true)
    expect(dispatches).toBe(1)
    expect(put.mock.calls[1]?.[1])
      .toMatchObject({ call_id: 'real-unclassified', effective_tier: 'T2', decision: 'ask' })
    await ctx.fiber.dispose()
  })
})

describe('S-16: a trilha de política é encadeada, e a quebra aparece', () => {
  const entry = (index: number, overrides: Partial<PolicyAuditRecord> = {}): PolicyAuditRecord => {
    const body = {
      audit_id: `audit-${String(index)}`,
      session_id: 'session-1',
      org_id: 'org-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      created_at: `2026-09-02T12:0${String(index)}:00.000Z`,
      tool_name: 'studio_agent_start',
      call_id: `call-${String(index)}`,
      effective_tier: 'T0' as const,
      decision: 'allow' as const,
      reason: 'permitido',
      rule_source: 'catalog' as const,
      seq: index,
      previous_sha256: POLICY_AUDIT_CHAIN_ROOT,
      ...overrides,
    }
    return { ...body, entry_sha256: policyAuditEntryHash(body) }
  }

  /** Uma corrente de verdade: cada elo aponta para o selo do anterior. */
  const chain = (total: number): PolicyAuditRecord[] => {
    const records: PolicyAuditRecord[] = []
    let previous = POLICY_AUDIT_CHAIN_ROOT
    for (let index = 0; index < total; index += 1) {
      const record = entry(index, { previous_sha256: previous })
      records.push(record)
      previous = record.entry_sha256!
    }
    return records
  }

  it('reconhece uma corrente íntegra, em qualquer ordem de leitura', () => {
    const records = chain(4)
    expect(verifyPolicyAuditChain(records)).toMatchObject({ kind: 'intact', entries: 4 })
    // O KV não promete ordem: a verificação ordena pela posição gravada.
    expect(verifyPolicyAuditChain([...records].reverse())).toMatchObject({ kind: 'intact', entries: 4 })
  })

  it('acusa quem reescreveu uma linha', () => {
    // Era exatamente isto que não deixava marca nenhuma: um put(k,v) por cima.
    const records = chain(4)
    records[2] = { ...records[2]!, reason: 'inventado depois', decision: 'deny' }
    expect(verifyPolicyAuditChain(records)).toMatchObject({ kind: 'broken', detail: 'seal', brokenAuditId: 'audit-2' })
  })

  it('acusa quem apagou uma linha do meio', () => {
    const records = chain(4)
    const without = records.filter(record => record.audit_id !== 'audit-2')
    expect(verifyPolicyAuditChain(without)).toMatchObject({ kind: 'broken', detail: 'sequence' })
  })

  it('acusa quem reordenou a trilha', () => {
    const records = chain(3)
    // Trocar o elo sem trocar a posição: o selo continua batendo com o conteúdo,
    // e só o encadeamento denuncia.
    const relinked = { ...records[2]!, previous_sha256: POLICY_AUDIT_CHAIN_ROOT }
    expect(verifyPolicyAuditChain([records[0]!, records[1]!, { ...relinked, entry_sha256: policyAuditEntryHash(({ ...relinked, entry_sha256: undefined } as unknown as Omit<PolicyAuditRecord, 'entry_sha256'>)) }]))
      .toMatchObject({ kind: 'broken', detail: 'link', brokenAuditId: 'audit-2' })
  })

  it('não chama de íntegra uma trilha antiga que nunca teve selo', () => {
    // Registro gravado antes do encadeamento existir. Dizer "íntegra" seria
    // afirmar uma garantia que aquele registro nunca teve.
    const legacy = { ...chain(1)[0]! }
    delete (legacy as { entry_sha256?: string }).entry_sha256
    expect(verifyPolicyAuditChain([legacy])).toMatchObject({ kind: 'unchained', firstUnchainedId: 'audit-0' })
  })

  it('o selo muda quando qualquer campo muda, e não depende da ordem das chaves', () => {
    const { entry_sha256: _seal, ...body } = entry(0)
    expect(policyAuditEntryHash(body)).toBe(policyAuditEntryHash(Object.fromEntries(Object.entries(body).reverse()) as typeof body))
    expect(policyAuditEntryHash(body)).not.toBe(policyAuditEntryHash({ ...body, reason: 'outro' }))
    expect(policyAuditEntryHash(body)).not.toBe(policyAuditEntryHash({ ...body, user_id: 'outra-pessoa' }))
  })
})
