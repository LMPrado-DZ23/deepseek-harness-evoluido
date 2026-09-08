import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentRunRecord } from './model.js'
import { t } from './i18n.js'
import { DelegationError, type WorktreeDiff, type WorktreePort, type WorktreeSnapshot } from './service.js'

const execFileAsync = promisify(execFile)
const MAX_FILTER_DRIVERS = 128
const MAX_FILTER_DRIVER_NAME_LENGTH = 128
const SAFE_FILTER_DRIVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

interface GitBinding {
  readonly workTree: string
  readonly gitDir: string
  readonly commonDir: string
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function isStrictChild(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function isolatedGitEnvironment(indexFile?: string): NodeJS.ProcessEnv {
  const allowed = new Set(process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
    : ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'])
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    const canonical = process.platform === 'win32' ? key.toUpperCase() : key
    if (allowed.has(canonical)) environment[canonical] = value
  }
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  return indexFile === undefined
    ? isolated
    : { ...isolated, GIT_INDEX_FILE: indexFile }
}

function protectedGitArguments(extraConfig: readonly string[] = []): readonly string[] {
  return [
    '-c', 'core.quotepath=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    ...extraConfig,
  ]
}

async function gitBound(binding: GitBinding, args: readonly string[], indexFile?: string, extraConfig: readonly string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    ...protectedGitArguments(extraConfig), `--git-dir=${binding.gitDir}`, `--work-tree=${binding.workTree}`, ...args,
  ], {
    cwd: binding.commonDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: isolatedGitEnvironment(indexFile),
  })
  return stdout
}

async function gitWithInputBound(
  binding: GitBinding,
  args: readonly string[],
  input: string,
  extraConfig: readonly string[] = [],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', [
      ...protectedGitArguments(extraConfig), `--git-dir=${binding.gitDir}`, `--work-tree=${binding.workTree}`, ...args,
    ], { cwd: binding.workTree, env: isolatedGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolvePromise()
      : reject(new Error(stderr.trim() || t('git.commandFailed', { code: String(code) }))))
    child.stdin.end(input)
  })
}

async function disabledFilterConfiguration(binding: GitBinding): Promise<readonly string[]> {
  let output = ''
  try {
    output = await gitBound(binding, ['config', '--includes', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'])
  } catch (error) {
    if ((error as { readonly code?: number }).code === 1) return []
    throw error
  }
  const names = new Set<string>()
  for (const key of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key)
    const name = match?.[1]
    if (name === undefined
      || name.length > MAX_FILTER_DRIVER_NAME_LENGTH
      || !SAFE_FILTER_DRIVER_NAME.test(name)) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.filterUnsafe'))
    }
    names.add(name)
    if (names.size > MAX_FILTER_DRIVERS) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.filterLimit'))
    }
  }
  const nodePath = process.execPath.replaceAll('\\', '/').replaceAll('"', '\\"')
  const passThrough = `"${nodePath}" -e "process.stdin.pipe(process.stdout)"`
  return [...names].flatMap(name => [
    '-c', `filter.${name}.clean=${passThrough}`,
    '-c', `filter.${name}.smudge=${passThrough}`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`,
  ])
}

async function safeTextFile(path: string, maximumBytes: number): Promise<string> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink() || !info.isFile() || info.size === 0 || info.size > maximumBytes) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.boundaryChanged'))
  }
  return readFile(path, 'utf8')
}

async function filesystemBinding(workTreeInput: string): Promise<GitBinding> {
  const requested = resolve(workTreeInput)
  const rootInfo = await lstat(requested).catch(() => undefined)
  if (rootInfo === undefined || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.worktreeDirectory'))
  }
  const workTree = await realpath(requested)
  if (!samePath(workTree, requested)) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.worktreePath'))
  }
  const markerPath = join(workTree, '.git')
  const marker = await lstat(markerPath).catch(() => undefined)
  if (marker === undefined || marker.isSymbolicLink()) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.boundaryChanged'))
  }
  let gitDir: string
  if (marker.isDirectory()) {
    gitDir = await realpath(markerPath)
  } else if (marker.isFile() && marker.size <= 4_096) {
    const descriptor = await safeTextFile(markerPath, 4_096)
    const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/u.exec(descriptor)
    if (match === null) throw new DelegationError('WORKTREE_TAMPERED', t('git.linkInvalid'))
    const declared = resolve(workTree, match[1]!)
    const declaredInfo = await lstat(declared).catch(() => undefined)
    if (declaredInfo === undefined || declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.linkTarget'))
    }
    gitDir = await realpath(declared)
  } else {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.boundaryChanged'))
  }
  const commonDescriptorPath = join(gitDir, 'commondir')
  const commonDescriptorInfo = await lstat(commonDescriptorPath).catch(() => undefined)
  let commonDir = gitDir
  if (commonDescriptorInfo !== undefined) {
    const descriptor = (await safeTextFile(commonDescriptorPath, 1_024)).trim()
    if (descriptor === '' || /[\r\n\0]/u.test(descriptor)) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.commonDirectory'))
    }
    const declared = resolve(gitDir, descriptor)
    const declaredInfo = await lstat(declared).catch(() => undefined)
    if (declaredInfo === undefined || declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.commonDirectory'))
    }
    commonDir = await realpath(declared)
  }
  for (const [base, name, kind] of [
    [gitDir, 'HEAD', 'file'], [commonDir, 'objects', 'directory'], [commonDir, 'refs', 'directory'],
  ] as const) {
    const entry = await lstat(join(base, name)).catch(() => undefined)
    if (entry === undefined || entry.isSymbolicLink()
      || (kind === 'file' ? !entry.isFile() : !entry.isDirectory())) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.structureInvalid'))
    }
  }
  for (const [base, name] of [
    [commonDir, 'config'], [gitDir, 'config.worktree'], [gitDir, 'index'],
  ] as const) {
    const entry = await lstat(join(base, name)).catch(() => undefined)
    if (entry !== undefined && (entry.isSymbolicLink() || !entry.isFile())) {
      throw new DelegationError('WORKTREE_TAMPERED', t('git.structureUnsafe'))
    }
  }
  return { workTree, gitDir, commonDir }
}

async function verifiedRepositoryBinding(repositoryPath: string): Promise<GitBinding> {
  const binding = await filesystemBinding(repositoryPath)
  await validateReciprocalWorktreeLink(binding)
  const [topLevel, absoluteGitDir, commonDir] = await Promise.all([
    gitBound(binding, ['rev-parse', '--show-toplevel']),
    gitBound(binding, ['rev-parse', '--path-format=absolute', '--git-dir']),
    gitBound(binding, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ])
  if (!samePath(topLevel.trim(), binding.workTree)
    || !samePath(absoluteGitDir.trim(), binding.gitDir)
    || !samePath(commonDir.trim(), binding.commonDir)) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.repositoryBoundary'))
  }
  return binding
}

async function validateReciprocalWorktreeLink(binding: GitBinding): Promise<void> {
  if (samePath(binding.gitDir, binding.commonDir)) return
  const reciprocal = (await safeTextFile(join(binding.gitDir, 'gitdir'), 4_096)).trim()
  if (reciprocal === '' || /[\r\n\0]/u.test(reciprocal)) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.reciprocalInvalid'))
  }
  const reciprocalReal = await realpath(resolve(binding.gitDir, reciprocal)).catch(() => undefined)
  const markerReal = await realpath(join(binding.workTree, '.git')).catch(() => undefined)
  if (reciprocalReal === undefined || markerReal === undefined || !samePath(reciprocalReal, markerReal)) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.reciprocalChanged'))
  }
}

async function verifiedWorktreeBinding(repositoryPath: string, worktreePath: string, baseCommit: string): Promise<GitBinding> {
  const repository = await verifiedRepositoryBinding(repositoryPath)
  const binding = await filesystemBinding(worktreePath)
  const worktreeAdminRoot = join(repository.commonDir, 'worktrees')
  if (!samePath(binding.commonDir, repository.commonDir)
    || !isStrictChild(worktreeAdminRoot, binding.gitDir)
    || !samePath(dirname(binding.gitDir), worktreeAdminRoot)) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.worktreeOwner'))
  }
  await validateReciprocalWorktreeLink(binding)
  const [topLevel, absoluteGitDir, commonDir, head, listed] = await Promise.all([
    gitBound(binding, ['rev-parse', '--show-toplevel']),
    gitBound(binding, ['rev-parse', '--path-format=absolute', '--git-dir']),
    gitBound(binding, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitBound(binding, ['rev-parse', 'HEAD']),
    gitBound(repository, ['worktree', 'list', '--porcelain']),
  ])
  const listedWorktrees = listed.split(/\r?\n/u)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
  if (!samePath(topLevel.trim(), binding.workTree)
    || !samePath(absoluteGitDir.trim(), binding.gitDir)
    || !samePath(commonDir.trim(), repository.commonDir)
    || head.trim() !== baseCommit
    || !listedWorktrees.some(path => samePath(path, binding.workTree))) {
    throw new DelegationError('WORKTREE_TAMPERED', t('git.worktreeBoundary'))
  }
  return binding
}

export class GitWorktreeManager implements WorktreePort {
  constructor(private readonly worktreeRoot: string) {}

  async create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot> {
    const root = resolve(repositoryPath)
    const repository = await verifiedRepositoryBinding(root)
    if (!samePath(repository.workTree, root)) throw new Error(t('git.repositoryRootExact'))
    const worktreePath = resolve(this.worktreeRoot, runId)
    const expectedRoot = `${resolve(this.worktreeRoot)}${sep}`
    if (!worktreePath.startsWith(expectedRoot)) throw new Error(t('git.worktreeOutsideStudio'))
    const baseCommit = (await gitBound(repository, ['rev-parse', 'HEAD'])).trim()
    const filterConfiguration = await disabledFilterConfiguration(repository)
    const mainFingerprint = await this.mainFingerprint(root)
    await gitBound(repository, ['worktree', 'add', '--detach', '--no-checkout', worktreePath, baseCommit], undefined, filterConfiguration)
    const binding = await verifiedWorktreeBinding(root, worktreePath, baseCommit)
    // Conditional includes may activate only for the linked-worktree gitdir.
    // Re-read and neutralize filter drivers from the exact binding that will
    // materialize files; the main repository's config view is not sufficient.
    const worktreeFilterConfiguration = await disabledFilterConfiguration(binding)
    await gitBound(binding, ['reset', '--hard', baseCommit], undefined, worktreeFilterConfiguration)
    await verifiedWorktreeBinding(root, worktreePath, baseCommit)
    return { repositoryPath: root, worktreePath, baseCommit, mainFingerprint }
  }

  async diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff> {
    const binding = await verifiedWorktreeBinding(snapshot.repositoryPath, snapshot.worktreePath, snapshot.baseCommit)
    const filterConfiguration = await disabledFilterConfiguration(binding)
    const temporaryRoot = await mkdtemp(join(resolve(this.worktreeRoot), '.dz23-index-'))
    const indexFile = join(temporaryRoot, 'index')
    try {
      await gitBound(binding, ['read-tree', snapshot.baseCommit], indexFile, filterConfiguration)
      await gitBound(binding, ['add', '-N', '--', '.'], indexFile, filterConfiguration)
      const status = await gitBound(binding, ['status', '--porcelain=v1', '-z'], indexFile, filterConfiguration)
      const files = status.split('\0').filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/'))
      const text = await gitBound(binding, ['diff', '--binary', '--no-ext-diff', '--no-textconv', snapshot.baseCommit, '--'], indexFile, filterConfiguration)
      return { text, bytes: Buffer.byteLength(text), files }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  async mainFingerprint(repositoryPath: string): Promise<string> {
    const repository = await verifiedRepositoryBinding(repositoryPath)
    const filterConfiguration = await disabledFilterConfiguration(repository)
    const status = await gitBound(repository, ['status', '--porcelain=v1', '-z'], undefined, filterConfiguration)
    const diff = await gitBound(repository, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], undefined, filterConfiguration)
    return createHash('sha256').update(status).update(diff).digest('hex')
  }

  async applyProposal(record: AgentRunRecord): Promise<void> {
    const snapshot: WorktreeSnapshot = {
      repositoryPath: record.repository_path,
      worktreePath: record.worktree_path,
      baseCommit: record.base_commit,
      mainFingerprint: '',
    }
    const current = await this.diff(snapshot)
    const currentHash = createHash('sha256').update(current.text).digest('hex')
    if (currentHash !== record.diff_sha256
      || current.bytes !== record.diff_bytes
      || JSON.stringify([...current.files].sort()) !== JSON.stringify([...record.changed_files].sort())) {
      throw new DelegationError('PROPOSAL_TAMPERED', t('git.proposalChangedAfterReview'))
    }
    const repository = await verifiedRepositoryBinding(record.repository_path)
    const filterConfiguration = await disabledFilterConfiguration(repository)
    const status = await gitBound(repository, ['status', '--porcelain=v1', '-z'], undefined, filterConfiguration)
    const occupied = status.split('\0').filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/'))
    if (pathsOverlap(occupied, record.changed_files)) {
      throw new DelegationError('WRITE_CONFLICT', t('git.projectChangedSameFiles'))
    }
    const committedSinceBase = (await gitBound(repository, [
      'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', record.base_commit, 'HEAD', '--',
    ], undefined, filterConfiguration)).split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'))
    if (pathsOverlap(committedSinceBase, record.changed_files)) {
      throw new DelegationError('WRITE_CONFLICT', t('git.projectChangedTheseFiles'))
    }
    await gitWithInputBound(repository, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], current.text, filterConfiguration)
    await gitWithInputBound(repository, ['apply', '--binary', '--whitespace=nowarn', '-'], current.text, filterConfiguration)
  }
}
