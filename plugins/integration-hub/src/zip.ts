import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Minimal ZIP writer/reader (PKZIP 2.0, deflate or store, no ZIP64), enough to
 * package a prototype without adding a dependency. Entries are written in the
 * order given; names use forward slashes and never start with `/` or contain
 * `..`. Timestamps are fixed to a constant so identical input yields an
 * identical archive (reproducible digests).
 */
export interface ZipEntry {
  readonly name: string
  readonly data: Buffer
  /** Unix mode bits placed in the external attributes (default 0644, executables 0755). */
  readonly mode?: number
}

const FIXED_DOS_TIME = 0x0000 // 00:00:00
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1 // 2026-01-01

export function assertEntryName(name: string): void {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid zip entry name: ${JSON.stringify(name)}`)
  }
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const seen = new Set<string>()
  for (const entry of entries) {
    assertEntryName(entry.name)
    if (seen.has(entry.name)) throw new Error(`duplicate zip entry: ${entry.name}`)
    seen.add(entry.name)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8); local.writeUInt16LE(FIXED_DOS_TIME, 10); local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10); central.writeUInt16LE(FIXED_DOS_TIME, 12); central.writeUInt16LE(FIXED_DOS_DATE, 14)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((entry.mode ?? 0o644) & 0xffff) << 16 >>> 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  if (entries.length > 0xffff || offset + centralSize > 0xffffffff) throw new Error('archive exceeds the ZIP (non-64) limits')
  return Buffer.concat([...locals, ...centrals, end])
}

/** Read every entry back (used by tests and by the export self-check). */
export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('not a zip archive')
  const count = archive.readUInt16LE(eocd + 10)
  let position = archive.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(position) !== 0x02014b50) throw new Error('corrupt central directory')
    const method = archive.readUInt16LE(position + 10)
    const crc = archive.readUInt32LE(position + 16)
    const compressedSize = archive.readUInt32LE(position + 20)
    const size = archive.readUInt32LE(position + 24)
    const nameLength = archive.readUInt16LE(position + 28)
    const extraLength = archive.readUInt16LE(position + 30)
    const commentLength = archive.readUInt16LE(position + 32)
    const mode = archive.readUInt32LE(position + 38) >>> 16
    const localOffset = archive.readUInt32LE(position + 42)
    const name = archive.subarray(position + 46, position + 46 + nameLength).toString('utf8')
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`corrupt entry: ${name}`)
    entries.push({ name, data, mode })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
