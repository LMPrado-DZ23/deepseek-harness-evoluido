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
    source: 'plugins/agents/src/model.ts', exportName: 'studioAgentRunsDomainSpec', physicalName: 'studio_agent_runs',
    tables: { runs: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'An agent run belongs to one approved workspace.' } },
  },
  {
    source: 'plugins/agents/src/model.ts', exportName: 'studioAgentLeasesDomainSpec', physicalName: 'studio_agent_leases',
    tables: { leases: { scope: 'workspace-tenant', requiredFields: ['org_id', 'tenant_id', 'workspace_id'], reason: 'A path lease excludes writers inside one workspace.' } },
  },
  {
    source: 'plugins/route-health/src/model.ts', exportName: 'studioRouteHealthDomainSpec', physicalName: 'studio_route_health',
    tables: {
      routes: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
      events: { scope: 'org-tenant', requiredFields: ['org_id', 'tenant_id'] },
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
  const sourceRoot = resolve(root, 'plugins')
  const files = await walk(sourceRoot)
  const declarations: DomainDeclaration[] = []
  for (const filename of files.filter(file => file.endsWith('.ts') && file.includes(`${separator()}src${separator()}`))) {
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

export async function assertDomainScopeManifest(root: string): Promise<void> {
  const discovered = await discoverDomainDeclarations(root)
  const classified = STUDIO_DOMAIN_SCOPES
    .map(({ source, exportName }) => ({ source, exportName }))
    .sort(compareDeclaration)
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

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function compareDeclaration(left: DomainDeclaration, right: DomainDeclaration): number {
  return `${left.source}:${left.exportName}`.localeCompare(`${right.source}:${right.exportName}`)
}
