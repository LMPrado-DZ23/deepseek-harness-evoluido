import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `App.tsx` belongs to another agent, so the M4/M5 integration is delivered as
 * a patch instead of an edit. A patch that no longer applies is not a delivery,
 * it is a note — so applying it is checked here, against the tree of this
 * worktree, on every run.
 */
const root = resolve(import.meta.dirname, '..', '..', '..', '..')
const patchPath = 'apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch'
const patch = readFileSync(resolve(root, patchPath), 'utf8')

describe('the App.tsx integration patch', () => {
  it('applies cleanly to the tree of this worktree', () => {
    // Throws (and fails) with git's own message when the patch no longer applies.
    execFileSync('git', ['apply', '--check', patchPath], { cwd: root, stdio: 'pipe' })
  })

  it('declares the base it was generated against, and that base is a commit this clone has', () => {
    const declared = /^Base desta geracao .*: ([0-9a-f]{40})$/mu.exec(patch)?.[1]
    expect(declared, 'o patch precisa declarar a base').toBeDefined()
    const type = execFileSync('git', ['cat-file', '-t', declared!], { cwd: root, stdio: 'pipe' }).toString().trim()
    expect(type).toBe('commit')
  })

  it('touches only App.tsx: no other file of another agent is edited by it', () => {
    const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map(match => match[1])
    expect(files).toEqual(['apps/studio-web/src/App.tsx'])
  })

  it('translates the two network causes, for reads and for mutations, and moves to GENERATING only after the 202', () => {
    // Not only `{ offline: true }` any more: both codes are told apart, through the shared helper.
    expect(patch).toMatch(/apiFailureMessage\(cause, navigator\.onLine, 'read'\)/u)
    expect(patch).toMatch(/apiFailureText\(cause, navigator\.onLine, call, t\.health\.attention\)/u)
    // A mutation is the default call kind, which is what selects the blocked-action sentence.
    expect(patch).toMatch(/call: ApiCallKind = 'mutation'/u)
    // The run only exists after the server accepted it; the rejection path is deterministic.
    expect(patch).toMatch(/startGeneration\(/u)
    expect(patch).toMatch(/setProjectState\(GENERATION_REJECTED_STATE\)/u)
    expect(patch).not.toMatch(/^\+\s*setProjectState\('GENERATING'\)\s*$\n\+\s*await safely/mu)
    // The finished-generation event carries the run, which is what makes the notification deduplicable.
    expect(patch).toMatch(/dispatchGenerationFinished\(window, \{ state, runId \}\)/u)
  })

  it('never invents a queue: nothing in it retries, stores or schedules a blocked action', () => {
    // Comments are allowed to say the word "queue" — to say there is none. Code is not.
    const added = patch.split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1).replace(/\/\/.*$/u, ''))
      .join('\n')
    expect(added).not.toMatch(/localStorage|indexedDB|sessionStorage|BackgroundSync|SyncManager|setInterval|pendingActions|queue/iu)
  })
})
