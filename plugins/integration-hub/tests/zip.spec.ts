import { describe, expect, it } from 'vitest'
import { assertEntryName, createZipAsync, crc32, createZip, readZip } from '../src/zip.ts'

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

  it('refuses too many entries before touching a byte of any of them', () => {
    // The count used to be checked inside `assemble`, i.e. after every entry had been deflated: the
    // refusal was honest, the CPU was already spent. `data` is a getter here, so "was it read?" is
    // a fact and not an opinion.
    let reads = 0
    const payload = Buffer.from('x'.repeat(256))
    const entries = Array.from({ length: 0x10000 }, (_unused, index) => ({
      name: `f${String(index)}`,
      get data(): Buffer { reads++; return payload },
    }))
    expect(() => createZip(entries)).toThrow('ZIP (non-64) limits')
    expect(reads).toBe(0)
  })

  it('refuses too many entries before compressing, on the async path too', async () => {
    let reads = 0
    const payload = Buffer.from('y'.repeat(256))
    const entries = Array.from({ length: 0x10000 }, (_unused, index) => ({
      name: `g${String(index)}`,
      get data(): Buffer { reads++; return payload },
    }))
    await expect(createZipAsync(entries)).rejects.toThrow('ZIP (non-64) limits')
    expect(reads).toBe(0)
  })
})

/**
 * The reader is not on a production route today — nothing imports a ZIP anywhere in the Studio — so
 * this is preventive. It is also the whole point: an import route may not be opened over a reader
 * that believes what the archive says about itself.
 */
describe('the zip reader against a hostile archive', () => {
  function centralOf(archive: Buffer): { central: number; local: number } {
    const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    const central = archive.readUInt32LE(eocd + 16)
    return { central, local: archive.readUInt32LE(central + 42) }
  }

  it('refuses a declared size that lies, instead of using it as the decompression budget', () => {
    // ~2 MB of zeros deflate to almost nothing. Declaring 0xffffffff used to BECOME the ceiling
    // (`maxOutputLength: size + 1`): a small file that asks for roughly 4 GiB of heap.
    const archive = createZip([{ name: 'a.bin', data: Buffer.alloc(2 * 1024 * 1024) }])
    const { central, local } = centralOf(archive)
    archive.writeUInt32LE(0xffffffff, central + 24)
    archive.writeUInt32LE(0xffffffff, local + 22)
    expect(() => readZip(archive)).toThrow('too large')

    // And a claim that clears the whole-archive ceiling but not the per-entry one: without the
    // per-entry ceiling this reads as a merely "corrupt" entry, after 300 MB had been permitted.
    const single = createZip([{ name: 'a.bin', data: Buffer.alloc(2 * 1024 * 1024) }])
    const there = centralOf(single)
    single.writeUInt32LE(300 * 1024 * 1024, there.central + 24)
    single.writeUInt32LE(300 * 1024 * 1024, there.local + 22)
    expect(() => readZip(single)).toThrow('zip entry is too large')
  })

  it('refuses an unknown compression method instead of handing back the compressed bytes as the file', () => {
    const archive = createZip([{ name: 'a.txt', data: Buffer.from('ok '.repeat(200)) }])
    const { central, local } = centralOf(archive)
    archive.writeUInt16LE(99, central + 10)
    archive.writeUInt16LE(99, local + 8)
    expect(() => readZip(archive)).toThrow('unsupported compression method')
  })

  it('refuses an entry whose local header disagrees with the central directory', () => {
    const archive = createZip([{ name: 'a.txt', data: Buffer.from('ok '.repeat(200)) }])
    const { local } = centralOf(archive)
    archive.writeUInt32LE(0xdeadbeef, local + 14) // a CRC only the local header knows about
    expect(() => readZip(archive)).toThrow('local header does not match')
  })

  it('refuses an encrypted entry and one whose sizes live in a data descriptor', () => {
    for (const flag of [0x0001, 0x0008]) {
      const archive = createZip([{ name: 'a.txt', data: Buffer.from('ok '.repeat(200)) }])
      const { central, local } = centralOf(archive)
      archive.writeUInt16LE(archive.readUInt16LE(central + 8) | flag, central + 8)
      archive.writeUInt16LE(archive.readUInt16LE(local + 6) | flag, local + 6)
      expect(() => readZip(archive), String(flag)).toThrow('unsupported zip entry flags')
    }
  })

  it('refuses two entries with the same name', () => {
    const archive = createZip([{ name: 'a.txt', data: Buffer.from('AAAA') }, { name: 'b.txt', data: Buffer.from('BBBB') }])
    // Both copies of the second name — local header and central directory — become the first name.
    for (let at = archive.indexOf('b.txt'); at >= 0; at = archive.indexOf('b.txt', at + 1)) archive.write('a.txt', at, 'utf8')
    expect(() => readZip(archive)).toThrow('duplicate zip entry')
  })

  it('refuses an entry whose data is not before the central directory', () => {
    const archive = createZip([{ name: 'a.txt', data: Buffer.from('ok '.repeat(200)) }])
    const { central } = centralOf(archive)
    archive.writeUInt32LE(central, central + 42) // the local header would sit on top of the directory
    expect(() => readZip(archive)).toThrow('corrupt entry')
  })

  it('refuses an end-of-central-directory record that does not reach the end of the buffer', () => {
    const archive = Buffer.concat([createZip([{ name: 'a.txt', data: Buffer.from('ok') }]), Buffer.from('lixo depois do fim')])
    expect(() => readZip(archive)).toThrow('not a zip archive')
  })

  it('rejects malformed central and local directory boundaries one invariant at a time', () => {
    const fresh = () => createZip([{ name: 'a.txt', data: Buffer.from('ok') }])
    const mutate = (change: (archive: Buffer, at: ReturnType<typeof centralOf> & { eocd: number }) => void, message: RegExp) => {
      const archive = fresh(); const positions = { ...centralOf(archive), eocd: archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) }
      change(archive, positions)
      expect(() => readZip(archive)).toThrow(message)
    }
    mutate((archive, { eocd }) => archive.writeUInt16LE(1, eocd + 4), /multi-disk/u)
    mutate((archive, { eocd }) => archive.writeUInt16LE(2, eocd + 8), /central directory/u)
    mutate((archive, { eocd }) => archive.writeUInt32LE(eocd + 1, eocd + 16), /central directory/u)
    mutate((archive, { central }) => archive.writeUInt32LE(0, central), /central directory/u)
    mutate((archive, { eocd }) => { archive.writeUInt16LE(0, eocd + 8); archive.writeUInt16LE(0, eocd + 10) }, /central directory/u)
    mutate((archive, { central, local }) => {
      archive.writeUInt32LE(3, central + 24); archive.writeUInt32LE(3, local + 22)
    }, /corrupt entry/u)
    mutate((archive, { local }) => archive.writeUInt32LE(0, local), /corrupt entry/u)
    mutate((archive, { central }) => archive.writeUInt32LE(central - 20, central + 42), /corrupt entry/u)
    mutate((archive, { central, local }) => {
      archive.writeUInt16LE(0, local + 26); archive.writeUInt16LE(0, central + 28)
    }, /central directory|local header|invalid zip entry/u)
    mutate((archive, { local }) => archive.write('b.txt', local + 30, 'utf8'), /local header/u)
  })
})
