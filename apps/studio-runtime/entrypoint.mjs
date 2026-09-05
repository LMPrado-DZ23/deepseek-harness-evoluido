#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { classifyShutdown } from './shutdown-contract.mjs'

const require = createRequire(import.meta.url)
const dshHome = resolve(process.env.DSH_HOME ?? '/var/lib/dz23-studio')
const packagedProfile = dirname(require.resolve('dsh-profile-studio/package.json'))
const imageRevision = (process.env.DZ23_STUDIO_IMAGE_REVISION ?? 'development').replaceAll(/[^A-Za-z0-9._-]/gu, '_')
const managedRoot = join(dshHome, 'profiles', '.dz23-managed')
const managedProfile = join(managedRoot, `studio-${imageRevision}`)
const profileLink = join(dshHome, 'profiles', 'studio')
const dshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const shutdownMarker = join(dshHome, '.last-clean-shutdown.json')

async function ensureLink(path, target) {
  const current = await lstat(path).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (current !== undefined) {
    if (!current.isSymbolicLink()) throw new Error(`PROFILE_DEPENDENCY_CONFLICT: ${path}`)
    if (resolve(dirname(path), await readlink(path)) === resolve(target)) return
    await unlink(path)
  }
  await symlink(target, path, 'dir')
}

async function materializeManagedProfile() {
  await mkdir(join(managedProfile, 'node_modules'), { recursive: true })
  await Promise.all([
    copyFile(join(packagedProfile, 'package.json'), join(managedProfile, 'package.json')),
    copyFile(join(packagedProfile, 'cordis.patch.yml'), join(managedProfile, 'cordis.patch.yml')),
  ])
  const manifest = JSON.parse(await readFile(join(packagedProfile, 'package.json'), 'utf8'))
  const dependencies = Object.keys(manifest.dependencies ?? {})
  for (const dependency of dependencies) {
    const dependencyRoot = await packageRoot(dependency)
    const parts = dependency.split('/')
    const linkPath = dependency.startsWith('@')
      ? join(managedProfile, 'node_modules', parts[0], parts[1])
      : join(managedProfile, 'node_modules', dependency)
    await mkdir(dirname(linkPath), { recursive: true })
    await ensureLink(linkPath, dependencyRoot)
  }
  await writeFile(join(managedProfile, '.image-revision'), `${imageRevision}\n`, { mode: 0o600 })
}

async function packageRoot(name) {
  let current = dirname(require.resolve(name))
  while (current !== dirname(current)) {
    const manifestPath = join(current, 'package.json')
    const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(error => {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    })
    if (manifest?.name === name) return current
    current = dirname(current)
  }
  throw new Error(`PROFILE_DEPENDENCY_NOT_FOUND: ${name}`)
}

await mkdir(managedRoot, { recursive: true })
await materializeManagedProfile()
const current = await lstat(profileLink).catch(error => {
  if (error?.code === 'ENOENT') return undefined
  throw error
})
if (current === undefined) {
  await symlink(managedProfile, profileLink, 'dir')
} else {
  if (!current.isSymbolicLink()) {
    throw new Error(`PROFILE_CONFLICT: ${profileLink} precisa ser um link gerenciado pelo DZ23 STUDIO`)
  }
  const target = resolve(dirname(profileLink), await readlink(profileLink))
  const managedPrefix = `${resolve(managedRoot)}/`
  if (target !== resolve(managedProfile) && !target.replaceAll('\\', '/').startsWith(managedPrefix.replaceAll('\\', '/'))) {
    throw new Error(`PROFILE_CONFLICT: ${profileLink} aponta para um perfil diferente`)
  }
  if (target !== resolve(managedProfile)) {
    const temporaryLink = `${profileLink}.next-${process.pid}`
    await unlink(temporaryLink).catch(error => { if (error?.code !== 'ENOENT') throw error })
    await symlink(managedProfile, temporaryLink, 'dir')
    await rename(temporaryLink, profileLink)
  }
}

const child = spawn(process.execPath, [dshBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
})
const forwardedSignals = ['SIGINT', 'SIGTERM']
const handlers = new Map()
let requestedSignal
for (const signal of forwardedSignals) {
  const handler = () => {
    if (requestedSignal !== undefined) return
    requestedSignal = signal
    child.kill(signal)
  }
  handlers.set(signal, handler)
  process.on(signal, handler)
}
child.once('error', error => {
  process.stderr.write(`DZ23_STUDIO_START=FAIL ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', async (code, signal) => {
  for (const [name, handler] of handlers) process.removeListener(name, handler)
  if (requestedSignal !== undefined) {
    const shutdownOutcome = classifyShutdown(code, signal, requestedSignal)
    if (shutdownOutcome === null) {
      process.stderr.write(`DZ23_STUDIO_SHUTDOWN=FAIL childCode=${String(code)} childSignal=${String(signal)} requestedSignal=${requestedSignal}\n`)
      process.exitCode = typeof code === 'number' && code !== 0 ? code : 1
      return
    }
    let temporary
    try {
      temporary = `${shutdownMarker}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
      await writeFile(temporary, `${JSON.stringify({
        childCode: code,
        childSignal: signal,
        imageRevision,
        requestedSignal,
        shutdownOutcome,
      })}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, shutdownMarker)
      process.exitCode = 0
    } catch (error) {
      process.stderr.write(`DZ23_STUDIO_SHUTDOWN=FAIL ${error.message}\n`)
      process.exitCode = 1
    } finally {
      if (temporary !== undefined) await unlink(temporary).catch(error => {
        if (error?.code !== 'ENOENT') {
          process.stderr.write(`DZ23_STUDIO_SHUTDOWN=FAIL ${error.message}\n`)
          process.exitCode = 1
        }
      })
    }
    return
  }
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
