import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentRunRecord } from './model.js'
import { DelegationError, type WorktreeDiff, type WorktreePort, type WorktreeSnapshot } from './service.js'

const execFileAsync = promisify(execFile)

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

async function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolvePromise()
      : reject(new Error(stderr.trim() || `git terminou com código ${String(code)}`)))
    child.stdin.end(input)
  })
}

export class GitWorktreeManager implements WorktreePort {
  constructor(private readonly worktreeRoot: string) {}

  async create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot> {
    const root = resolve(repositoryPath)
    const canonical = (await git(root, ['rev-parse', '--show-toplevel'])).trim()
    if (resolve(canonical) !== root) throw new Error('O caminho informado precisa ser a raiz exata do repositório Git.')
    const worktreePath = resolve(this.worktreeRoot, runId)
    const expectedRoot = `${resolve(this.worktreeRoot)}${sep}`
    if (!worktreePath.startsWith(expectedRoot)) throw new Error('Destino de worktree fora da área controlada pelo Studio.')
    const baseCommit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const mainFingerprint = await this.mainFingerprint(root)
    await git(root, ['worktree', 'add', '--detach', worktreePath, baseCommit])
    const listed = await git(root, ['worktree', 'list', '--porcelain'])
    if (!listed.includes(`worktree ${worktreePath}`)) throw new Error('Git não confirmou o novo worktree.')
    return { repositoryPath: root, worktreePath, baseCommit, mainFingerprint }
  }

  async diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff> {
    await git(snapshot.worktreePath, ['add', '-N', '--', '.'])
    const status = await git(snapshot.worktreePath, ['status', '--porcelain=v1', '-z'])
    const files = status.split('\0').filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/'))
    const text = await git(snapshot.worktreePath, ['diff', '--binary', 'HEAD', '--'])
    return { text, bytes: Buffer.byteLength(text), files }
  }

  async mainFingerprint(repositoryPath: string): Promise<string> {
    const root = resolve(repositoryPath)
    const status = await git(root, ['status', '--porcelain=v1', '-z'])
    const diff = await git(root, ['diff', '--binary', 'HEAD', '--'])
    // This fingerprint is diagnostic only. Do not recursively hash untracked trees:
    // a dependency/cache directory could make every delegation scan unbounded.
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
      throw new DelegationError('PROPOSAL_TAMPERED', 'A proposta mudou depois da revisão e foi bloqueada.')
    }
    const status = await git(record.repository_path, ['status', '--porcelain=v1', '-z'])
    const occupied = status.split('\0').filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/'))
    if (pathsOverlap(occupied, record.changed_files)) {
      throw new DelegationError('WRITE_CONFLICT', 'O projeto mudou nos mesmos arquivos desde a criação da proposta.')
    }
    const committedSinceBase = (await git(record.repository_path, [
      'diff', '--name-only', '-z', record.base_commit, 'HEAD', '--',
    ])).split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'))
    if (pathsOverlap(committedSinceBase, record.changed_files)) {
      throw new DelegationError('WRITE_CONFLICT', 'O projeto mudou nesses arquivos desde que o assistente começou.')
    }
    await gitWithInput(record.repository_path, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], current.text)
    await gitWithInput(record.repository_path, ['apply', '--binary', '--whitespace=nowarn', '-'], current.text)
  }
}

export function assertInsideWorktree(worktreePath: string, candidate: string): string {
  if (!isAbsolute(candidate)) throw new DelegationError('INVALID_PATH', 'O caminho produzido pelo assistente precisa ser absoluto.')
  const rel = relative(resolve(worktreePath), resolve(candidate))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DelegationError('INVALID_PATH', 'O assistente tentou escrever fora da cópia isolada.')
  }
  return rel.replaceAll('\\', '/')
}
