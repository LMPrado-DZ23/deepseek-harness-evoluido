import { createHash } from 'node:crypto'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportedDomain, sealBundle } from '../src/bundle.ts'
import { readStorageBundleFile, readVerifiedStorageBundleFile } from '../src/import-file.ts'

const scratch: string[] = []
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dz23-import-file-'))
  scratch.push(value)
  return value
}

function validBundle() {
  const descriptor = { name: 'studio_hello', version: 1, tables: ['records'], hasGlobal: false }
  return sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [
    exportedDomain(descriptor, { tables: { records: { one: { note: 'ok' } } }, global: null }),
  ], '2026-09-04T00:00:00.000Z')
}

describe('bounded storage import reader', () => {
  it('reads a valid bundle through one descriptor and enforces the actual EOF byte count', async () => {
    const root = await directory()
    const input = join(root, 'bundle.json')
    const serialized = JSON.stringify(validBundle())
    await writeFile(input, serialized)
    await expect(readStorageBundleFile(input, { maxBytes: Buffer.byteLength(serialized), maxDomains: 1, maxRecords: 1, maxDepth: 64 }))
      .resolves.toEqual(validBundle())
    await expect(readStorageBundleFile(input, { maxBytes: Buffer.byteLength(serialized) - 1, maxDomains: 1, maxRecords: 1, maxDepth: 64 }))
      .rejects.toThrow('byte limit')
  })

  it('refuses excessive structural depth before JSON materialization', async () => {
    const root = await directory()
    const input = join(root, 'deep.json')
    await writeFile(input, `${'['.repeat(20)}0${']'.repeat(20)}`)
    await expect(readStorageBundleFile(input, { maxBytes: 1024, maxDomains: 1, maxRecords: 1, maxDepth: 8 }))
      .rejects.toThrow('nesting-depth limit')
  })

  it('refuses a symlink as the input or as an ancestor', async () => {
    const root = await directory()
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await writeFile(real, JSON.stringify(validBundle()))
    try {
      await symlink(real, linked, 'file')
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM') return
      throw error
    }
    await expect(readStorageBundleFile(linked)).rejects.toThrow()
  })

  it('hashes, verifies and parses the same private descriptor', async () => {
    const root = await directory()
    const input = join(root, 'bundle.json')
    const serialized = JSON.stringify(validBundle())
    const digest = createHash('sha256').update(serialized).digest('hex')
    await writeFile(input, serialized)
    await writeFile(`${input}.sha256`, `${digest}  bundle.json\n`)
    await expect(readVerifiedStorageBundleFile(input)).resolves.toMatchObject({ inputSha256: digest, bytes: Buffer.byteLength(serialized), bundle: validBundle() })
    await writeFile(`${input}.sha256`, `${'0'.repeat(64)}  bundle.json\n`)
    await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow('não corresponde')
  })

  it('refuses hardlinked input and cancellation before reading', async () => {
    const root = await directory()
    const input = join(root, 'bundle.json')
    const alias = join(root, 'alias.json')
    const serialized = JSON.stringify(validBundle())
    await writeFile(input, serialized)
    await link(input, alias)
    await writeFile(`${input}.sha256`, `${createHash('sha256').update(serialized).digest('hex')}  bundle.json\n`)
    await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow('private regular file')
    await rm(alias)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(readVerifiedStorageBundleFile(input, undefined, controller.signal)).rejects.toThrow('cancelled')
  })

  it('refuses a symlink, hardlink or FIFO in place of the verification sidecar', async () => {
    const root = await directory()
    const input = join(root, 'bundle.json')
    const digestFile = join(root, 'digest.txt')
    const serialized = JSON.stringify(validBundle())
    const digest = createHash('sha256').update(serialized).digest('hex')
    await writeFile(input, serialized)
    await writeFile(digestFile, `${digest}  bundle.json\n`)
    try {
      await symlink(digestFile, `${input}.sha256`, 'file')
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM') return
      throw error
    }
    await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow()
    await rm(`${input}.sha256`)
    await link(digestFile, `${input}.sha256`)
    await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow('sidecar is invalid')
    await rm(`${input}.sha256`)
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [`${input}.sha256`])
      // O_NONBLOCK is deliberately not needed: lstat/open identity validation
      // rejects the FIFO before any read is attempted.
      await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow()
    }
  })

  it('refuses a FIFO input before it can block the operator', async () => {
    if (process.platform === 'win32') return
    const root = await directory()
    const input = join(root, 'bundle.json')
    execFileSync('mkfifo', [input])
    await expect(readVerifiedStorageBundleFile(input)).rejects.toThrow('not a regular file')
  })
})
