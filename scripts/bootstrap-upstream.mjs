#!/usr/bin/env node
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyUpstreamContent } from './check-upstream-content.mjs'
import { parseUpstreamLock, verifyUpstreamPin } from './upstream-pin-lib.mjs'

function git(root, args, { allowStatuses = [] } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowStatuses.includes(result.status)) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} falhou`)
  }
  return result.stdout.trim()
}

function configValues(runGit, cwd, configPath, key) {
  const output = runGit(cwd, ['config', '--file', configPath, '--get-all', key], { allowStatuses: [1] })
  return output === '' ? [] : output.split(/\r?\n/u)
}

function singleConfigValue(values, key, { optional = false } = {}) {
  if (values.length > 1) throw new Error(`configuração Git ambígua: múltiplos valores para ${key}`)
  if (values.length === 0 && !optional) throw new Error(`configuração Git ausente: ${key}`)
  return values[0]
}

function samePath(left, right) {
  const normalize = value => {
    const resolved = resolve(value).replaceAll('\\', '/')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

async function regularFile(path, label) {
  const stat = await lstat(path).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} não é arquivo regular: ${path}`)
  return stat
}

export async function normalizeSubmoduleWorktreeConfig({ studioRoot, upstreamRoot, runGit = git }) {
  const commonText = runGit(upstreamRoot, ['rev-parse', '--git-common-dir'])
  const commonDirectory = resolve(upstreamRoot, commonText)
  const commonConfig = resolve(commonDirectory, 'config')
  await regularFile(commonConfig, 'configuração comum do submódulo')

  const worktreeText = runGit(upstreamRoot, ['rev-parse', '--git-path', 'config.worktree'])
  const worktreeConfig = isAbsolute(worktreeText) ? resolve(worktreeText) : resolve(upstreamRoot, worktreeText)
  const worktreeRelative = relative(commonDirectory, worktreeConfig)
  if (!worktreeRelative || worktreeRelative.startsWith('..') || isAbsolute(worktreeRelative)) {
    throw new Error('configuração worktree do submódulo saiu do diretório Git comum')
  }

  const commonWorktreeValues = configValues(runGit, studioRoot, commonConfig, 'core.worktree')
  if (commonWorktreeValues.length === 0) return { changed: false, commonConfig, worktreeConfig }
  const commonWorktree = singleConfigValue(commonWorktreeValues, 'core.worktree')
  const effectiveWorktree = isAbsolute(commonWorktree)
    ? resolve(commonWorktree)
    : resolve(commonDirectory, commonWorktree)
  if (!samePath(effectiveWorktree, upstreamRoot)) {
    throw new Error(`core.worktree não aponta para o submódulo fixado: ${commonWorktree}`)
  }

  const version = singleConfigValue(
    configValues(runGit, studioRoot, commonConfig, 'core.repositoryFormatVersion'),
    'core.repositoryFormatVersion',
  )
  if (version !== '0' && version !== '1') throw new Error(`formato Git não suportado: ${version}`)
  const bare = singleConfigValue(configValues(runGit, studioRoot, commonConfig, 'core.bare'), 'core.bare', { optional: true })
  if (bare !== undefined && bare.toLowerCase() !== 'false') throw new Error(`submódulo bare não é suportado: ${bare}`)

  const extensionNamesText = runGit(
    studioRoot,
    ['config', '--file', commonConfig, '--name-only', '--get-regexp', '^extensions\\.'],
    { allowStatuses: [1] },
  )
  const extensionNames = extensionNamesText === '' ? [] : extensionNamesText.split(/\r?\n/u)
  if (extensionNames.some(name => name.toLowerCase() !== 'extensions.worktreeconfig')) {
    throw new Error('configuração comum contém extensão Git que exige auditoria manual')
  }
  const extension = singleConfigValue(
    configValues(runGit, studioRoot, commonConfig, 'extensions.worktreeConfig'),
    'extensions.worktreeConfig',
    { optional: true },
  )
  if (extension !== undefined && !/^(?:true|false)$/iu.test(extension)) {
    throw new Error(`extensions.worktreeConfig inválida: ${extension}`)
  }

  const worktreeStat = await lstat(worktreeConfig).catch(() => undefined)
  if (worktreeStat && (!worktreeStat.isFile() || worktreeStat.isSymbolicLink())) {
    throw new Error(`configuração worktree não é arquivo regular: ${worktreeConfig}`)
  }
  const worktreeBytes = worktreeStat ? await readFile(worktreeConfig) : undefined
  if (worktreeBytes && worktreeBytes.toString('utf8').trim() !== '') {
    throw new Error('configuração worktree existente contém valores que exigem migração manual')
  }
  const commonBytes = await readFile(commonConfig)

  try {
    runGit(studioRoot, ['config', '--file', worktreeConfig, 'core.worktree', commonWorktree])
    if (version === '0') {
      runGit(studioRoot, ['config', '--file', commonConfig, 'core.repositoryFormatVersion', '1'])
    }
    runGit(studioRoot, ['config', '--file', commonConfig, '--unset-all', 'core.worktree'])
    if (extension?.toLowerCase() !== 'true') {
      runGit(studioRoot, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true'])
    }
  } catch (error) {
    const rollbackErrors = []
    await writeFile(commonConfig, commonBytes).catch(rollbackError => rollbackErrors.push(rollbackError))
    const restoreWorktree = worktreeBytes
      ? writeFile(worktreeConfig, worktreeBytes)
      : rm(worktreeConfig, { force: true })
    await restoreWorktree.catch(rollbackError => rollbackErrors.push(rollbackError))
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'falha ao normalizar e restaurar a configuração Git do submódulo')
    }
    throw new Error('falha ao normalizar a configuração Git do submódulo; estado anterior restaurado', { cause: error })
  }

  const normalizedWorktree = runGit(upstreamRoot, ['config', '--get', 'core.worktree'])
  if (normalizedWorktree !== commonWorktree) {
    throw new Error('normalização Git não preservou core.worktree efetivo')
  }
  return { changed: true, commonConfig, worktreeConfig }
}

export async function bootstrapUpstream({
  studioRoot = resolve(process.cwd()),
  runGit = git,
  verifyPin = verifyUpstreamPin,
  verifyContent = verifyUpstreamContent,
  normalizeWorktreeConfig = normalizeSubmoduleWorktreeConfig,
  output = process.stdout,
} = {}) {
  const lock = parseUpstreamLock(await readFile(resolve(studioRoot, 'UPSTREAM.lock'), 'utf8'))

  // O bootstrap apenas materializa o gitlink registrado. Nunca reseta, limpa ou
  // escolhe uma branch para contornar divergência local.
  runGit(studioRoot, ['submodule', 'sync', '--', lock.path])
  runGit(studioRoot, ['submodule', 'update', '--init', '--checkout', '--', lock.path])

  // Primeiro prova commit, árvore, origin, índice e limpeza sem exigir o tipo
  // físico dos symlinks. Só depois converte placeholders de checkout Windows.
  // Assim uma origem divergente jamais é alterada pelo materializador.
  await verifyPin({ studioRoot, requireRealSymlinks: false })
  await verifyContent(studioRoot, { materializeSymlinks: true })
  await normalizeWorktreeConfig({
    studioRoot,
    upstreamRoot: resolve(studioRoot, lock.path),
    runGit,
  })
  const result = await verifyPin({ studioRoot })
  output.write(`UPSTREAM_BOOTSTRAP=PASS commit=${result.commit}\n`)
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapUpstream().catch(error => {
    process.stderr.write(`UPSTREAM_BOOTSTRAP=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
