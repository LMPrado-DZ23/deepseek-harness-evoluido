#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()) {
  const { tag } = parseCli(argv)
  const root = resolve(projectRoot)
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })
  validateBuildState({ head, status, tag })
  run(process.env.DZ23_DOCKER_BIN ?? 'docker', buildPlan({ head, tag }), {
    cwd: root,
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
    inherit: true,
  })
  process.stdout.write(`STUDIO_IMAGE_BUILD=PASS image=${tag} revision=${head}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`STUDIO_IMAGE_BUILD=FAIL ${error.message}\n`)
    process.exitCode = 1
  }
}
