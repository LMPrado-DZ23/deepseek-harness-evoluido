import type { StudioPermission, StudioRole } from '@dz23-studio/policy'

export type StagingPermission = Extract<StudioPermission, 'project.read' | 'project.publish_staging'>

export interface StagingAuthorizationSubject {
  readonly role: StudioRole
  readonly sessionId: string
}

export interface StagingAuthorizationPort {
  allows(role: StudioRole, permission: StagingPermission): boolean
}

export function isStagingAuthorized(subject: StagingAuthorizationSubject, permission: StagingPermission, authorization: StagingAuthorizationPort): boolean {
  return subject.sessionId.trim() !== '' && authorization.allows(subject.role, permission)
}
