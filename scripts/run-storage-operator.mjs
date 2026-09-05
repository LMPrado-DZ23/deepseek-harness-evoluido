#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

function command(executor, args, options = {}) {
  return executor('docker', ['compose', ...args], options)
}

export async function runStorageRestoreStopped(argv, dependencies = {}) {
  if (argv[0] !== 'restore' || !argv.includes('--write')) {
    throw new Error('Este lançador aceita somente restore --write; backup, verify-backup e status não precisam parar o Studio.')
  }
  const executor = dependencies.executor ?? execute
  const signal = dependencies.signal
  const throwIfAborted = () => {
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
  }
  throwIfAborted()
  const running = await command(executor, ['ps', '--status', 'running', '--services', 'harness'], { capture: true, signal })
  const restartHarness = running.stdout.split(/\r?\n/u).includes('harness')
  await command(executor, ['stop', 'harness'], { signal })
  await command(executor, ['up', '-d', '--wait', 'postgres'], { signal })
  try {
    await command(executor, ['--profile', 'operator', 'run', '--rm', '--no-deps', 'operator', ...argv], { signal })
    throwIfAborted()
  } catch (error) {
    throw new Error(`Restauração falhou com o Harness parado; ele continuará parado. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (restartHarness) await command(executor, ['up', '-d', '--no-deps', '--wait', 'harness'], { signal })
  return { restored: true, harnessRestarted: restartHarness }
}

async function execute(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`docker compose terminou com código ${String(code)}${stderr === '' ? '' : `: ${sanitize(stderr).slice(0, 300)}`}`)))
  })
}

function sanitize(value) {
  let safe = value
  const dsn = process.env.DZ23_POSTGRES_DSN
  if (typeof dsn === 'string' && dsn !== '') safe = safe.replaceAll(dsn, '[redacted]')
  return safe.replaceAll(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, '$1[redacted]@')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Operação cancelada.'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const report = await runStorageRestoreStopped(process.argv.slice(2), { signal: controller.signal })
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } catch (error) {
    process.stderr.write(`${sanitize(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}
