import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `App.tsx` belongs to another agent, so the M4/M5 integration is delivered as
 * a patch instead of an edit. A patch that no longer applies is not a delivery,
 * it is a note — so applying it is checked here, against the tree of this
 * worktree, on every run.
 */
const root = resolve(import.meta.dirname, '..', '..', '..', '..')
const patchPath = 'apps/studio-web/INTEGRACAO_App_tsx_M4_M5.patch'
const patch = readFileSync(resolve(root, patchPath), 'utf8')

const webRoot = resolve(root, 'apps', 'studio-web')
const scratch: string[] = []
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('the App.tsx integration patch', () => {
  it('applies cleanly to the tree of this worktree', () => {
    // Throws (and fails) with git's own message when the patch no longer applies.
    execFileSync('git', ['apply', '--check', patchPath], { cwd: root, stdio: 'pipe' })
  })

  /**
   * Applying is not compiling. Every other check here reads the patch as TEXT — it applies, it
   * touches one file, it matches these regexes — and nothing anywhere ever compiled `App.tsx` WITH
   * the patch in it: renaming any symbol the patch reaches for (`NotificationOptIn`,
   * `startGeneration`, `postGeneration`, `dispatchGenerationFinished`, `HUB_PATH`) passed every
   * gate and broke only when somebody applied the patch by hand. So: apply it into a throwaway copy
   * of `src/` and hand that copy to the repository's own `tsc`, with this project's tsconfig.
   *
   * The copy lives under `apps/studio-web/` so that `node_modules` resolves exactly as it does for
   * the real tree — react, its JSX runtime and every dependency the patched file imports.
   */
  it('COMPILES once applied, with the repository own tsc and this app tsconfig', () => {
    const directory = mkdtempSync(join(webRoot, '.patch-typecheck-'))
    scratch.push(directory)
    cpSync(resolve(webRoot, 'src'), join(directory, 'src'), { recursive: true })
    cpSync(resolve(webRoot, 'tsconfig.json'), join(directory, 'tsconfig.json'))
    // Vite resolves stylesheet side-effect imports; tsc alone does not, and that is not what this
    // guard is about.
    writeFileSync(join(directory, 'src', 'css-side-effect-imports.d.ts'), "declare module '*.css'\n")
    execFileSync('git', ['apply', '-p4', resolve(root, patchPath)], { cwd: join(directory, 'src'), stdio: 'pipe' })
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
    let diagnostics = ''
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', join(directory, 'tsconfig.json')], { cwd: webRoot, stdio: 'pipe' })
    } catch (error) {
      // tsc's own diagnostics — file, line and message — are what tells whoever renamed the symbol
      // which one it was; the bare "command failed" of execFileSync would not.
      diagnostics = String((error as { stdout?: Buffer }).stdout ?? '') || String(error)
    }
    expect(diagnostics, 'o patch aplicado nao compila mais').toBe('')
  }, 180_000)

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
