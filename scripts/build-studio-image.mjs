#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SAFE_IMAGE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/@-]{0,510}$/u
const SHA40 = /^[0-9a-f]{40}$/u

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  return (result.stdout ?? '').trim()
}

export function validateBuildState({ head, status, tag }) {
  if (!SHA40.test(head)) fail('HEAD Git inválido')
  if (status.length !== 0) fail('árvore Git precisa estar totalmente limpa para vincular a imagem ao commit')
  if (!SAFE_IMAGE.test(tag) || /\s/u.test(tag)) fail('tag de imagem inválida')
  return { head, tag }
}

export function buildPlan({ head, tag }) {
  return [
    'build', '--progress=plain',
    '--build-arg', `STUDIO_COMMIT=${head}`,
    '--label', `org.opencontainers.image.revision=${head}`,
    '--tag', tag,
    '--file', 'deploy/studio/Dockerfile',
    '.',
  ]
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--tag' || argv[1]?.startsWith('--')) {
    fail('Uso: node scripts/build-studio-image.mjs --tag <imagem>')
  }
  return { tag: argv[1] }
}

function assertTemporaryParent(path) {
  const absolute = resolve(path)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dz23-studio-build-')) {
    fail('diretório temporário de build fora da raiz permitida')
  }
  return absolute
}

export async function main(argv = process.argv.slice(2), projectRoot = process.cwd()) {
  const { tag } = parseCli(argv)
  const root = resolve(projectRoot)
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })
  validateBuildState({ head, status, tag })
  const temporaryParent = assertTemporaryParent(await mkdtemp(join(tmpdir(), 'dz23-studio-build-')))
  const snapshotRoot = join(temporaryParent, 'context')
  let registeredWorktree = false
  try {
    run('git', ['worktree', 'add', '--detach', snapshotRoot, head], { cwd: root })
    registeredWorktree = true
    run('git', ['submodule', 'update', '--init', '--recursive', '--checkout', '--no-fetch'], { cwd: snapshotRoot })
    const snapshotHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: snapshotRoot })
    const snapshotStatus = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: snapshotRoot })
    validateBuildState({ head: snapshotHead, status: snapshotStatus, tag })
    if (snapshotHead !== head) fail('snapshot Git diverge do commit validado')
    run(process.env.DZ23_DOCKER_BIN ?? 'docker', buildPlan({ head, tag }), {
      cwd: snapshotRoot,
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
      inherit: true,
    })
    const finalHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })
    const finalStatus = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })
    validateBuildState({ head: finalHead, status: finalStatus, tag })
    if (finalHead !== head) fail('HEAD mudou durante a construção da imagem')
    process.stdout.write(`STUDIO_IMAGE_BUILD=PASS image=${tag} revision=${head} context=detached-worktree\n`)
  } finally {
    if (registeredWorktree) {
      run('git', ['worktree', 'remove', '--force', snapshotRoot], { cwd: root })
    }
    await rm(temporaryParent, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`STUDIO_IMAGE_BUILD=FAIL ${error.message}\n`)
    process.exitCode = 1
  }
}
