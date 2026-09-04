export const CAPACITY_RESOURCES = ['prompt-job', 'build', 'preview'] as const

export type CapacityResource = typeof CAPACITY_RESOURCES[number]

export type CapacityLimit = Readonly<{
  global: number
  perTenant: number
  perProject: number
}>

export type CapacityLimits = Readonly<Record<CapacityResource, CapacityLimit>>

export type CapacityScope = Readonly<{
  orgId: string
  tenantId: string
  projectId: string
}>

export type CapacityRequest = Readonly<{
  resource: CapacityResource
  units?: number
}>

export type AcquireBundleRequest = Readonly<{
  ownerId: string
  scope: CapacityScope
  requests: readonly CapacityRequest[]
  ttlMs?: number
}>

export type LeaseReference = Readonly<{
  leaseId: string
  fencingToken: number
}>

export type CapacityLease = LeaseReference & Readonly<{
  ownerId: string
  scope: CapacityScope
  allocations: Readonly<Record<CapacityResource, number>>
  acquiredAt: number
  expiresAt: number
}>

export type TenantCapacityUsage = Readonly<{
  orgId: string
  tenantId: string
  units: number
}>

export type ProjectCapacityUsage = CapacityScope & Readonly<{ units: number }>

export type ResourceCapacityUsage = Readonly<{
  resource: CapacityResource
  global: number
  tenants: readonly TenantCapacityUsage[]
  projects: readonly ProjectCapacityUsage[]
}>

export type CapacitySnapshot = Readonly<{
  capturedAt: number
  limits: CapacityLimits
  leases: readonly CapacityLease[]
  usage: readonly ResourceCapacityUsage[]
}>

export type ReconcileResult = Readonly<{
  reconciledAt: number
  expired: readonly LeaseReference[]
  activeLeaseCount: number
}>

export type CapacityLimitLevel = 'global' | 'tenant' | 'project'

export type CapacityErrorCode =
  | 'CAPACITY_EXCEEDED'
  | 'INVALID_CAPACITY_REQUEST'
  | 'LEASE_NOT_FOUND'
  | 'STALE_FENCING_TOKEN'
  | 'LEASE_ID_COLLISION'

export class CapacityGovernorError extends Error {
  constructor(
    readonly code: CapacityErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message)
    this.name = 'CapacityGovernorError'
  }
}

export interface CapacityGovernor {
  acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease>
  heartbeat(reference: LeaseReference, ttlMs?: number): Promise<CapacityLease>
  release(reference: LeaseReference): Promise<void>
  reconcile(): Promise<ReconcileResult>
  snapshot(): Promise<CapacitySnapshot>
}

export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = Object.freeze({
  'prompt-job': Object.freeze({ global: 4, perTenant: 2, perProject: 1 }),
  build: Object.freeze({ global: 1, perTenant: 1, perProject: 1 }),
  preview: Object.freeze({ global: 4, perTenant: 2, perProject: 1 }),
})

export const DEFAULT_LEASE_TTL_MS = 120_000
export const MIN_LEASE_TTL_MS = 1_000
export const MAX_LEASE_TTL_MS = 3_600_000
