export const BUILD_STEPS = ['install', 'build', 'unit', 'e2e'] as const
export type BuildStep = typeof BUILD_STEPS[number]

export type BuildState =
  | 'PREPARED'
  | 'INSTALLING'
  | 'INSTALL_OK'
  | 'BUILDING'
  | 'BUILD_OK'
  | 'UNIT_RUNNING'
  | 'UNIT_OK'
  | 'E2E_RUNNING'
  | 'E2E_OK'
  | 'FAILED'
  | 'CANCELLED'

export type TerminalBuildState = Extract<BuildState, 'E2E_OK' | 'FAILED' | 'CANCELLED'>

export interface ManagedBuild {
  readonly build_ref: string
  readonly build_id: string
  readonly state: BuildState
}

export interface StepResult {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
  readonly timed_out: boolean
  readonly output_limited: boolean
}

export class BuilderSupervisorError extends Error {
  constructor(readonly code: BuilderErrorCode) { super(code) }
}

export type BuilderErrorCode =
  | 'ARTIFACT_CHANGED_DURING_STAGE'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'ARTIFACT_OUTSIDE_ROOT'
  | 'ARTIFACT_UNSAFE_ENTRY'
  | 'BUILD_ALREADY_EXISTS'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_NOT_TERMINAL'
  | 'CLEANUP_INCOMPLETE'
  | 'INVALID_STEP_ORDER'
  | 'REQUEST_REPLAY'
  | 'REPLAY_CAPACITY'

export function isTerminalState(state: BuildState): state is TerminalBuildState {
  return state === 'E2E_OK' || state === 'FAILED' || state === 'CANCELLED'
}
