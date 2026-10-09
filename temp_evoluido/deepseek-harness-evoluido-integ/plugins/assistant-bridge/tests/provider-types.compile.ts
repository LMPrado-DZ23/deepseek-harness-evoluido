import type { AssistantRepositoryConfig } from '../src/service.js'

const localProvider: AssistantRepositoryConfig['providers'][number] = 'spawn-in-process'
void localProvider

// @ts-expect-error P36 does not expose the global Codex provider before the confinement E2E gate.
const codexProvider: AssistantRepositoryConfig['providers'][number] = 'codex'
void codexProvider

// @ts-expect-error P36 does not expose the global Claude Code provider before the confinement E2E gate.
const claudeProvider: AssistantRepositoryConfig['providers'][number] = 'claude-code'
void claudeProvider
