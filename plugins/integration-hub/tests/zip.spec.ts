import { describe, expect, it } from 'vitest'
import { assertEntryName, crc32, createZip, readZip } from '../src/zip.ts'

describe('dependency-free zip', () => {
  it('round-trips deflated and stored entries with modes, and is reproducible', () => {
    const entries = [
      { name: 'app/server.js', data: Buffer.from('console.log("x".repeat(500))'), mode: 0o755 },
      { name: 'README.md', data: Buffer.from('# oi') },
      { name: 'bin/blob', data: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    ]
    const archive = createZip(entries)
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const back = readZip(archive)
    expect(back.map(entry => [entry.name, entry.data.toString('base64'), entry.mode])).toEqual(entries.map(entry => [entry.name, entry.data.toString('base64'), entry.mode ?? 0o644]))
    expect(createZip(entries).equals(archive)).toBe(true)
    expect(createZip([])).toHaveLength(22)
  })

  it('refuses unsafe or duplicate names and detects corruption', () => {
    for (const name of ['', '/abs', 'a\\b', 'a/../b', './x', 'a//b', 'x\0y']) expect(() => assertEntryName(name), name).toThrow('invalid zip entry name')
    expect(() => createZip([{ name: 'a', data: Buffer.alloc(1) }, { name: 'a', data: Buffer.alloc(1) }])).toThrow('duplicate')
    const archive = createZip([{ name: 'a.txt', data: Buffer.from('hello world hello world hello world') }])
    const corrupted = Buffer.from(archive)
    corrupted[35] = (corrupted[35] ?? 0) ^ 0xff
    expect(() => readZip(corrupted)).toThrow()
    expect(() => readZip(Buffer.from('not a zip'))).toThrow('not a zip')
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('refuses what it cannot represent, and does not trust an archive it is given', () => {
    // The limit test used to run AFTER the writes it guarded, so the caller got a RangeError.
    expect(() => createZip(Array.from({ length: 0x10000 }, (_unused, index) => ({ name: `f${String(index)}`, data: Buffer.alloc(0) }))))
      .toThrow('ZIP (non-64) limits')
    expect(() => createZip([{ name: 'a'.repeat(70_000), data: Buffer.alloc(0) }])).toThrow('too long')
    expect(() => createZip([{ name: 'C:/win', data: Buffer.alloc(0) }])).toThrow('invalid zip entry name')
    expect(() => createZip([{ name: 'a\r\nb', data: Buffer.alloc(0) }])).toThrow('invalid zip entry name')
    // A crafted central directory must be an error, not a silently truncated entry.
    const archive = createZip([{ name: 'ok.txt', data: Buffer.from('ok') }])
    const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const central = archive.readUInt32LE(eocd + 16)
    const forged = Buffer.from(archive)
    forged.writeUInt16LE(0xffff, central + 28) // nameLength beyond the directory
    expect(() => readZip(forged)).toThrow('corrupt central directory')
    expect(() => readZip(Buffer.from('nao e um zip'))).toThrow('not a zip archive')
  })
})
