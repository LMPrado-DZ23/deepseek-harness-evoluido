export const BUILD_STEPS = ['install', 'build', 'test', 'e2e'] as const
export type BuildStep = typeof BUILD_STEPS[number]

export type BuildState =
  | 'PREPARED'
  | 'INSTALLING'
  | 'INSTALL_OK'
  | 'BUILDING'
  | 'BUILD_OK'
  | 'TEST_RUNNING'
  | 'TEST_OK'
  | 'E2E_RUNNING'
  | 'E2E_OK'
  | 'FAILED'
  | 'CANCELLED'

export type TerminalBuildState = Extract<BuildState, 'E2E_OK' | 'FAILED' | 'CANCELLED'>

export interface ManagedBuild {
  readonly build_ref: string
  readonly build_id: string
  readonly state: BuildState
  readonly exported: boolean
  readonly cleanup_pending: boolean
}

export interface ExportedArtifact {
  readonly relative_path: string
  readonly sha256: string
  readonly files: number
  readonly bytes: number
}

export interface FinishResult {
  readonly build_ref: string
  readonly final_state: TerminalBuildState
  readonly exported: ExportedArtifact | null
  readonly cleanup_pending: boolean
  readonly cleaned: boolean
}

export interface StepResult {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
  readonly timed_out: boolean
  readonly termination_reason: null | 'timeout' | 'output_limit'
  readonly output_limit_exceeded: boolean
}

export interface BuilderAttestation {
  readonly state: 'OK' | 'BLOCKED_EXTERNAL'
  readonly protocol_version: 1
  readonly scope_id: `s_${string}`
  readonly image_id: `sha256:${string}`
  readonly policy_sha256: string
}

export class BuilderSupervisorError extends Error {
  constructor(readonly code: BuilderErrorCode) { super(code) }
}

export type BuilderErrorCode =
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_CHANGED_DURING_STAGE'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_OUTSIDE_ROOT'
  | 'ARTIFACT_QUOTA_EXCEEDED'
  | 'ARTIFACT_TIMEOUT'
  | 'ARTIFACT_UNSAFE_ENTRY'
  | 'BUILD_ALREADY_EXISTS'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_NOT_TERMINAL'
  | 'CAPACITY_EXCEEDED'
  | 'CLEANUP_INCOMPLETE'
  | 'EXPORT_INVALID'
  | 'RECOVERY_FAILED'
  | 'INVALID_STEP_ORDER'
  | 'REQUEST_REPLAY'
  | 'REQUEST_ID_CONFLICT'
  | 'REPLAY_CAPACITY'

export function isTerminalState(state: BuildState): state is TerminalBuildState {
  return state === 'E2E_OK' || state === 'FAILED' || state === 'CANCELLED'
}
