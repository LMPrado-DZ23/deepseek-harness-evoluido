import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = resolve(packageRoot, '..', '..', 'node_modules', '.bin', 'vitest')

const mutations = [
  {
    name: 'scope-validation',
    file: 'src/manager-capacity.ts',
    from: 'if (!isBuilderRuntimeScopeId(scopeId)) return Promise.reject',
    to: 'if (false) return Promise.reject',
    tests: ['tests/manager-capacity.spec.ts'],
  },
  {
    name: 'registry-mode-0440',
    file: 'src/manager-registry.ts',
    from: '(mode !== 0o400 && mode !== 0o600 && mode !== 0o640)',
    to: '(mode !== 0o400 && mode !== 0o600 && mode !== 0o640 && mode !== 0o440)',
    tests: ['tests/manager-registry.spec.ts'],
  },
  {
    name: 'checkpoint-version',
    file: 'src/manager-state.ts',
    from: 'if (value.version !== 1 || value.installation_id !== installationId',
    to: 'if (false || value.installation_id !== installationId',
    tests: ['tests/manager-state.spec.ts'],
  },
  {
    name: 'policy-envelope-pin',
    file: 'src/supervisor-config.ts',
    from: "    ['policy.sha256', input.policySha256Bytes],\n",
    to: '',
    tests: ['tests/supervisor-config.spec.ts'],
  },
  {
    name: 'config-single-read',
    file: 'src/supervisor-config.ts',
    from: '    const raw = secureText(configBytes)',
    to: "    const raw = secureText(await readSecureFileBytes(configPath, 'config', runtime))",
    tests: ['tests/supervisor-config.spec.ts'],
  },
  {
    name: 'authority-close-order',
    file: 'src/manager-state.ts',
    from: '          await opened.handle.close()\n          closed = true\n          this.#heldInstallation = undefined',
    to: '          closed = true\n          this.#heldInstallation = undefined\n          await opened.handle.close()',
    tests: ['tests/manager-state.spec.ts'],
  },
  {
    name: 'manager-lease-close-order',
    file: 'src/manager-main.ts',
    from: '    await lease.close()\n    this.#lease = undefined',
    to: '    this.#lease = undefined\n    await lease.close()',
    tests: ['tests/manager-main.spec.ts'],
  },
  {
    name: 'runtime-owned-before-health',
    file: 'src/manager-main.ts',
    from: '        this.#runtimes.set(slot.scopeId, current)\n        if (runtime.scopeId !== slot.scopeId)',
    to: '        if (runtime.scopeId !== slot.scopeId)',
    tests: ['tests/manager-main.spec.ts'],
  },
  {
    name: 'capacity-release-after-close',
    file: 'src/manager-main.ts',
    from: '      error => { closing = undefined; throw error },',
    to: '      error => { composition.releaseAll(); closing = undefined; throw error },',
    tests: ['tests/manager-main.spec.ts'],
  },
  {
    name: 'capacity-retained-on-drain-timeout',
    file: 'src/manager-main.ts',
    from: '      finally { runtime.clearScheduledTimeout(forced) }',
    to: '      finally { runtime.clearScheduledTimeout(forced); composition.releaseAll() }',
    tests: ['tests/manager-main.spec.ts'],
  },
  {
    name: 'reload-rearm',
    file: 'src/manager-main.ts',
    from: '    } finally { this.#reloadExecution = undefined }\n  }\n\n  async #reload()',
    to: '    } finally { }\n  }\n\n  async #reload()',
    tests: ['tests/manager-main.spec.ts'],
  },
  {
    name: 'health-mkdir-fail-closed',
    file: 'src/manager-health.ts',
    from: "catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('INVALID_HEALTH_STORE') }",
    to: "catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }",
    tests: ['tests/manager-health.spec.ts'],
  },
]

let killed = 0
for (const mutation of mutations) {
  const path = join(packageRoot, mutation.file)
  const original = await readFile(path, 'utf8')
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) throw new Error(`MUTATION_PATTERN_${mutation.name}_${occurrences}`)
  await writeFile(path, original.replace(mutation.from, mutation.to), 'utf8')
  try {
    const exitCode = await run(vitest, ['run', '--config', 'vitest.config.ts', ...mutation.tests])
    if (exitCode === 0) throw new Error(`SURVIVED_${mutation.name}`)
    killed += 1
    process.stdout.write(`KILLED ${mutation.name}\n`)
  } finally {
    await writeFile(path, original, 'utf8')
  }
}

process.stdout.write(`MUTATION_SCORE=${killed}/${mutations.length}\n`)
if (killed !== mutations.length) process.exitCode = 1

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: packageRoot, stdio: 'ignore' })
    child.once('error', rejectRun)
    child.once('exit', code => resolveRun(code ?? 1))
  })
}
