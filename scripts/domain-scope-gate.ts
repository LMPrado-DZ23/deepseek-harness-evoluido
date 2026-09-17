import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

export type ScopeKind = 'org-tenant' | 'org-root' | 'workspace-tenant' | 'user-owned' | 'tenant-only-poc'

export interface DomainScopeEntry {
  source: string
  exportName: string
  physicalName: string
  tables: Record<string, { scope: ScopeKind; requiredFields: readonly string[]; reason?: string }>
}

/** Explicit and reviewable classification; there is deliberately no wildcard. */
export const STUDIO_DOMAIN_SCOPES: readonly DomainScopeEntry[] = [
  {
    source: 'plugins/integration-hub/src/model.ts', exportName: 'studioIntegrationsDomainSpec', physicalName: 'studio_integrations',
    tables: {
      integrations: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
      exports: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
      events: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
    },
  },
  {
    source: 'plugins/integration-hub/src/model.ts', exportName: 'studioIntegrationSwitchesDomainSpec', physicalName: 'studio_integration_switches',
    tables: {
      // `org-root` porque o desligamento MAIS AMPLO é o da organização inteira:
      // ele vale para todos os inquilinos dela, e classificá-lo como
      // `org-tenant` obrigaria um inquilino no registro — o que faria o botão
      // da organização deixar de alcançar os outros.
      switches: {
        scope: 'org-root', requiredFields: ['org_id'],
        reason: 'O desligamento por organizacao alcanca todos os inquilinos dela; o de projeto carrega inquilino e projeto nos proprios campos.',
      },
    },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioProjectsDomainSpec', physicalName: 'studio_projects',
    tables: { projects: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioAppSpecsDomainSpec', physicalName: 'studio_app_specs',
    tables: { specs: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioDesignSpecsDomainSpec', physicalName: 'studio_design_specs',
    tables: { designs: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioIntakeTurnsDomainSpec', physicalName: 'studio_intake_turns',
    tables: { turns: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioPlansDomainSpec', physicalName: 'studio_plans',
    tables: { plans: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioRunsDomainSpec', physicalName: 'studio_runs',
    tables: { runs: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioEvidenceDomainSpec', physicalName: 'studio_evidence',
    tables: { evidence: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioApprovalsDomainSpec', physicalName: 'studio_approvals',
    tables: { approvals: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/prompt-to-app/src/model.ts', exportName: 'studioCreationKeysDomainSpec', physicalName: 'studio_creation_keys',
    // A reserva de criacao carrega org, inquilino E pessoa, e os tres entram na
    // chave de armazenamento. Sem o escopo aqui, duas pessoas que escolhessem a
    // mesma chave de pedido — ela vem do cliente — se atropelariam, e a segunda
    // receberia a tarefa da primeira.
    tables: { keys: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/agents/src/model.ts', exportName: 'studioAgentRunsDomainSpec', physicalName: 'studio_agent_runs',
    tables: { runs: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'An agent run belongs to one approved workspace.' } },
  },
  {
    source: 'plugins/agents/src/model.ts', exportName: 'studioAgentLeasesDomainSpec', physicalName: 'studio_agent_leases',
    tables: { leases: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'A path lease excludes writers inside one workspace.' } },
  },
  {
    source: 'plugins/agent-team/src/model.ts', exportName: 'studioAgentTeamsDomainSpec', physicalName: 'studio_agent_teams',
    tables: {
      teams: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'A team coordinates only one approved workspace.' },
      tasks: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'Every team task inherits the same workspace boundary.' },
    },
  },
  {
    source: 'plugins/mission/src/model.ts', exportName: 'studioMissionsDomainSpec', physicalName: 'studio_missions',
    tables: {
      // `org-tenant` e nao `workspace-tenant`: uma missao atravessa execucoes de
      // projetos e de equipes diferentes, e amarra-la a um espaco de trabalho
      // faria o escopo AMPLO — que e a razao de ela existir — deixar de caber.
      missions: {
        scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'],
        reason: 'Uma missao atravessa execucoes de projetos e equipes diferentes dentro do mesmo inquilino.',
      },
    },
  },
  {
    source: 'plugins/route-health/src/model.ts', exportName: 'studioRouteHealthDomainSpec', physicalName: 'studio_route_health',
    tables: {
      routes: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
      events: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
    },
  },
  {
    source: 'plugins/staging/src/domain.ts', exportName: 'studioStagingReleasesDomainSpec', physicalName: 'studio_staging_releases',
    tables: {
      releases: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'], reason: 'A staging journal and its physical target binding belong to one organization and tenant.' },
    },
  },
  {
    source: 'plugins/action-approval/src/domain.ts', exportName: 'studioActionApprovalsDomainSpec', physicalName: 'studio_action_approvals',
    tables: {
      approvals: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'], reason: 'Uma confirmação de ação sensível pertence a uma pessoa dentro de uma organização e de um inquilino.' },
    },
  },
  {
    source: 'plugins/business/src/model.ts', exportName: 'studioBusinessDomainSpec', physicalName: 'studio_businesses',
    tables: {
      businesses: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'], reason: 'Uma empresa mora DENTRO do inquilino que o Studio já isola; ela não é um inquilino novo, e a empresa de um nunca aparece para outro.' },
    },
  },
  {
    source: 'plugins/business/src/model.ts', exportName: 'studioBusinessPlansDomainSpec', physicalName: 'studio_business_plans',
    tables: {
      plans: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'], reason: 'Cada versão do plano carrega o escopo da empresa a que pertence: sem ele, a contagem de versões de um inquilino contaria as do outro.' },
    },
  },
  {
    source: 'plugins/emergency-stop/src/model.ts', exportName: 'studioEmergencyStopDomainSpec', physicalName: 'studio_emergency_stop',
    tables: {
      stops: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'], reason: 'Uma parada de emergência vale para uma organização e um inquilino; a parada de um nunca segura o trabalho de outro.' },
    },
  },
  {
    source: 'plugins/hello/src/index.ts', exportName: 'studioHelloDomainSpec', physicalName: 'studio_hello',
    tables: { records: { scope: 'tenant-only-poc', requiredFields: ['tenant_id'], reason: 'PoC domain predates organizations.' } },
  },
  {
    source: 'plugins/identity/src/model.ts', exportName: 'identityUsersDomainSpec', physicalName: 'studio_identity_users',
    tables: {
      users: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
      magic_codes: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
    },
  },
  {
    source: 'plugins/identity/src/model.ts', exportName: 'identityCredentialsDomainSpec', physicalName: 'studio_identity_credentials',
    tables: {
      credentials: { scope: 'user-owned', requiredFields: ['user_id'], reason: 'Passkeys follow the owning user across workspaces.' },
      challenges: { scope: 'user-owned', requiredFields: ['user_id'], reason: 'Short-lived ceremony state is bound to a user and session.' },
    },
  },
  {
    source: 'plugins/identity/src/model.ts', exportName: 'identitySessionsDomainSpec', physicalName: 'studio_identity_sessions',
    tables: { sessions: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/identity/src/model.ts', exportName: 'identityAuditDomainSpec', physicalName: 'studio_identity_audit',
    tables: { events: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/tenancy/src/model.ts', exportName: 'studioOrgsDomainSpec', physicalName: 'studio_orgs',
    tables: { orgs: { scope: 'org-root', requiredFields: ['org_id'], reason: 'An organization is the root above workspaces.' } },
  },
  {
    source: 'plugins/tenancy/src/model.ts', exportName: 'studioWorkspacesDomainSpec', physicalName: 'studio_workspaces',
    tables: { workspaces: { scope: 'workspace-tenant', requiredFields: ['org_id', 'workspace_id'], reason: 'workspace_id is the tenant key in the tenancy model.' } },
  },
  {
    source: 'plugins/tenancy/src/model.ts', exportName: 'studioMembershipsDomainSpec', physicalName: 'studio_memberships',
    tables: {
      memberships: { scope: 'workspace-tenant', requiredFields: ['org_id', 'workspace_id'], reason: 'workspace_id is the tenant key in the tenancy model.' },
      invitations: { scope: 'workspace-tenant', requiredFields: ['org_id', 'workspace_id'], reason: 'workspace_id is the tenant key in the tenancy model.' },
    },
  },
  {
    source: 'plugins/policy/src/index.ts', exportName: 'studioPolicyAuditDomainSpec', physicalName: 'studio_policy_audit',
    tables: { decisions: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/preview/src/model.ts', exportName: 'studioPreviewsDomainSpec', physicalName: 'studio_previews',
    tables: { previews: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
  {
    source: 'plugins/preview/src/model.ts', exportName: 'studioPreviewAdmissionsDomainSpec', physicalName: 'studio_preview_admissions',
    tables: { admissions: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] } },
  },
] as const

export interface DomainDeclaration {
  source: string
  exportName: string
}

export async function discoverDomainDeclarations(root: string): Promise<DomainDeclaration[]> {
  const pluginsRoot = resolve(root, 'plugins')
  const plugins = await readdir(pluginsRoot, { withFileTypes: true })
  const trees = await Promise.all(plugins.filter(entry => entry.isDirectory()).map(async entry => {
    try {
      return await walk(resolve(pluginsRoot, entry.name, 'src'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }))
  const files = trees.flat()
  const declarations: DomainDeclaration[] = []
  for (const filename of files.filter(file => file.endsWith('.ts'))) {
    const text = await readFile(filename, 'utf8')
    const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    file.forEachChild(node => {
      if (!ts.isVariableStatement(node)) return
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue
        const expression = declaration.initializer.expression
        if (!ts.isIdentifier(expression) || expression.text !== 'defineDomain') continue
        declarations.push({
          source: relative(root, filename).replaceAll('\\', '/'),
          exportName: declaration.name.text,
        })
      }
    })
  }
  return declarations.sort(compareDeclaration)
}

/**
 * `entries` is a parameter so a test can hand the gate an EMPTY manifest and see what it does with
 * it — which is the whole point of the guard below, and cannot be reached while the classified list
 * is a module constant.
 */
export async function assertDomainScopeManifest(root: string, entries: readonly DomainScopeEntry[] = STUDIO_DOMAIN_SCOPES): Promise<void> {
  const discovered = await discoverDomainDeclarations(root)
  const classified = entries
    .map(({ source, exportName }) => ({ source, exportName }))
    .sort(compareDeclaration)
  // Two empty lists are EQUAL, and comparing them printed PASS: pointed at a tree with no
  // `defineDomain` in it — a wrong root, a move of the plugins folder, a manifest emptied by a bad
  // merge — the gate said every domain was classified because it had looked at none. By this
  // project's rules a gate that inspected nothing has failed, so it says so and names both counts.
  if (discovered.length === 0 || classified.length === 0) {
    throw new Error(`Studio domain scope gate inspected nothing (discovered=${String(discovered.length)} classified=${String(classified.length)}); a gate with zero items is a failure, not a pass. Check that '${root}' is the repository root.`)
  }
  if (JSON.stringify(discovered) !== JSON.stringify(classified)) {
    throw new Error(`Studio domain scope manifest is incomplete. Discovered=${JSON.stringify(discovered)} classified=${JSON.stringify(classified)}`)
  }
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? walk(path) : Promise.resolve([path])
  }))
  return nested.flat()
}

function compareDeclaration(left: DomainDeclaration, right: DomainDeclaration): number {
  return `${left.source}:${left.exportName}`.localeCompare(`${right.source}:${right.exportName}`)
}
