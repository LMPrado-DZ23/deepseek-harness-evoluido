import type { BuildState, BuildStep } from './model.js'
import { BuilderSupervisorError } from './model.js'

const TRANSITIONS: Readonly<Record<BuildStep, readonly [BuildState, BuildState, BuildState]>> = {
  install: ['PREPARED', 'INSTALLING', 'INSTALL_OK'],
  build: ['INSTALL_OK', 'BUILDING', 'BUILD_OK'],
  test: ['BUILD_OK', 'TEST_RUNNING', 'TEST_OK'],
  e2e: ['TEST_OK', 'E2E_RUNNING', 'E2E_OK'],
}

export function beginStep(state: BuildState, step: BuildStep): BuildState {
  const [required, running] = TRANSITIONS[step]
  if (state !== required) throw new BuilderSupervisorError('INVALID_STEP_ORDER')
  return running
}

export function completeStep(state: BuildState, step: BuildStep, successful: boolean): BuildState {
  const [, running, completed] = TRANSITIONS[step]
  if (state !== running) throw new BuilderSupervisorError('INVALID_STEP_ORDER')
  return successful ? completed : 'FAILED'
}
