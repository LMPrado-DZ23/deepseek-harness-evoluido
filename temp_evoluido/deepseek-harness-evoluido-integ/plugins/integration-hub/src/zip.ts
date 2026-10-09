import { promisify } from 'node:util'
import { deflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'

const deflateRawAsync = promisify(deflateRaw)
const S_IFREG = 0o100000

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

/** Hard ceilings of the format itself; the writer refuses in words instead of by RangeError. */
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff
/**
 * What the READER will materialise. The declared uncompressed size in a ZIP header is attacker-
 * controlled and 32 bits wide: using it as the decompression ceiling means a 60 KB archive may ask
 * for ~4 GiB of heap. These are the real ceilings; the declared size is only ever a claim to check.
 */
const READ_MAX_ENTRY_BYTES = 256 * 1024 * 1024
const READ_MAX_TOTAL_BYTES = 512 * 1024 * 1024
/** General-purpose flags that make an entry unreadable or unverifiable here: encryption (0, 6, 13) and a data descriptor (3). */
const REFUSED_FLAGS = 0b0010_0000_0100_1001

export function assertEntryName(name: string): void {
  if (name === '' || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)
    || /^[A-Za-z]:/u.test(name) || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid zip entry name: ${JSON.stringify(name)}`)
  }
  // The header fields are 16-bit: a name that does not fit must be refused HERE, in words, not by a
  // RangeError from a buffer write half-way through the archive.
  if (Buffer.byteLength(name, 'utf8') > 0xffff) throw new Error(`zip entry name is too long: ${String(Buffer.byteLength(name, 'utf8'))} bytes`)
}

type Prepared = { readonly entry: ZipEntry; readonly nameBytes: Buffer; readonly crc: number; readonly payload: Buffer; readonly method: 0 | 8 }

function prepare(entry: ZipEntry, deflated: Buffer): Prepared {
  const useDeflate = deflated.length < entry.data.length
  return { entry, nameBytes: Buffer.from(entry.name, 'utf8'), crc: crc32(entry.data), payload: useDeflate ? deflated : entry.data, method: useDeflate ? 8 : 0 }
}

/**
 * Everything that can be known before a single byte is compressed: names, duplicates, the entry
 * ceiling and the size ceiling. The count used to be checked inside `assemble`, i.e. AFTER every
 * entry had been deflated — the refusal was honest but the CPU had already been spent, which is
 * exactly what a ceiling is supposed to prevent.
 */
function validateEntries(entries: readonly ZipEntry[]): void {
  if (entries.length > MAX_ENTRIES) throw new Error('archive exceeds the ZIP (non-64) limits')
  const seen = new Set<string>()
  let total = 0
  for (const entry of entries) {
    assertEntryName(entry.name)
    if (seen.has(entry.name)) throw new Error(`duplicate zip entry: ${entry.name}`)
    seen.add(entry.name)
    // Local header + central header + two copies of the name + the payload, which never exceeds the
    // uncompressed size. An archive that cannot fit in the 32-bit offsets is refused before the CPU
    // is spent compressing it, not by a RangeError half-way through the write.
    total += 76 + 2 * Buffer.byteLength(entry.name, 'utf8') + entry.data.length
  }
  if (total > MAX_BYTES) throw new Error('archive exceeds the ZIP (non-64) limits')
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  validateEntries(entries)
  return assemble(entries.map(entry => prepare(entry, deflateRawSync(entry.data, { level: 9 }))))
}

/** Same archive as `createZip`, but compression runs in the zlib thread pool so a large prototype does not stall the server. */
export async function createZipAsync(entries: readonly ZipEntry[]): Promise<Buffer> {
  validateEntries(entries)
  const prepared: Prepared[] = []
  for (const entry of entries) prepared.push(prepare(entry, await deflateRawAsync(entry.data, { level: 9 })))
  return assemble(prepared)
}

function assemble(prepared: readonly Prepared[]): Buffer {
  // Kept as a last line of defence even though `validateEntries` already refused before compressing.
  if (prepared.length > MAX_ENTRIES) throw new Error('archive exceeds the ZIP (non-64) limits')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { entry, nameBytes, crc, payload, method } of prepared) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8); local.writeUInt16LE(FIXED_DOS_TIME, 10); local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)
    if (offset + local.length + nameBytes.length + payload.length > MAX_BYTES) throw new Error('archive exceeds the ZIP (non-64) limits')
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10); central.writeUInt16LE(FIXED_DOS_TIME, 12); central.writeUInt16LE(FIXED_DOS_DATE, 14)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36)
    // Regular-file type bit + permission bits, as unzip/tar expect for Unix external attributes.
    central.writeUInt32LE((((S_IFREG | (entry.mode ?? 0o644)) & 0xffff) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const entries = prepared
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  if (offset + centralSize > MAX_BYTES) throw new Error('archive exceeds the ZIP (non-64) limits')
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * The end-of-central-directory record, found by searching backwards for a signature whose own
 * comment length actually reaches the end of the buffer. `lastIndexOf` alone matches a signature
 * that happens to appear INSIDE stored data, which is one byte of attacker control away.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  for (let position = archive.length - 22; position >= 0; position--) {
    if (archive.readUInt32LE(position) !== 0x06054b50) continue
    if (position + 22 + archive.readUInt16LE(position + 20) === archive.length) return position
  }
  throw new Error('not a zip archive')
}

/**
 * Read every entry back (used by tests and by the export self-check). Written for a HOSTILE archive:
 * every field is a claim to be checked against the bytes that are actually there, never a number to
 * be trusted. Nothing here is on a production route today — no ZIP is imported anywhere — and this
 * hardening is what has to exist before one is.
 */
/** O cabeçalho de UMA entrada, já conferido contra os bytes que estão lá. */
export interface ZipHeader {
  readonly name: string
  /** O tamanho descompactado, já conferido contra os tetos do leitor. */
  readonly size: number
  readonly compressedSize: number
  readonly method: number
  readonly crc: number
  readonly mode: number
  /** Onde o payload começa, já conferido para caber antes do diretório central. */
  readonly start: number
}

/**
 * Percorre o diretório central e devolve os CABEÇALHOS, sem descompactar nada.
 *
 * Toda a conferência estrutural mora aqui — e por isso ela existe uma vez só.
 * Duplicar este laço para um "leitor leve" produziria duas descrições do mesmo
 * formato, e a que divergisse em silêncio seria justamente a que decide se um
 * arquivo hostil é aceito. Quem quer os BYTES chama `readZip`, que inflaciona
 * em cima daqui; quem quer só a LISTA chama `listZip`, e não materializa nada.
 *
 * Escrito para um arquivo HOSTIL: todo campo é uma alegação a conferir contra
 * os bytes que realmente estão lá, nunca um número em que confiar.
 *
 * ISTO MUDOU, e o comentário antigo dizia o contrário: ele afirmava que nada
 * daqui estava numa rota de produção. Desde a prévia da Biblioteca, `listZip`
 * está — ela lê o pacote que o próprio produto escreveu, mas lê um ARQUIVO, e
 * um arquivo em disco é editável por quem alcançar o disco. A dureza que já
 * existia deixou de ser preparação e passou a ser a defesa em uso.
 * @param archive - o arquivo inteiro.
 * @returns os cabeçalhos, na ordem do diretório central.
 */
export function zipHeaders(archive: Buffer): ZipHeader[] {
  const eocd = findEndOfCentralDirectory(archive)
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) throw new Error('multi-disk zip archives are not supported')
  const count = archive.readUInt16LE(eocd + 10)
  if (archive.readUInt16LE(eocd + 8) !== count) throw new Error('corrupt central directory')
  const centralStart = archive.readUInt32LE(eocd + 16)
  const centralSize = archive.readUInt32LE(eocd + 12)
  if (centralStart > eocd || centralStart + centralSize !== eocd) throw new Error('corrupt central directory')
  let position = centralStart
  const headers: ZipHeader[] = []
  const seen = new Set<string>()
  let total = 0
  for (let index = 0; index < count; index++) {
    // Every field is read only after the header is known to fit: a crafted directory used to return
    // truncated names and empty data instead of saying the archive is corrupt.
    if (position + 46 > eocd) throw new Error('corrupt central directory')
    if (archive.readUInt32LE(position) !== 0x02014b50) throw new Error('corrupt central directory')
    const flags = archive.readUInt16LE(position + 8)
    const method = archive.readUInt16LE(position + 10)
    const crc = archive.readUInt32LE(position + 16)
    const compressedSize = archive.readUInt32LE(position + 20)
    const size = archive.readUInt32LE(position + 24)
    const nameLength = archive.readUInt16LE(position + 28)
    const extraLength = archive.readUInt16LE(position + 30)
    const commentLength = archive.readUInt16LE(position + 32)
    const mode = (archive.readUInt32LE(position + 38) >>> 16) & 0o7777 // permission bits only; the type bits are the writer's concern
    const localOffset = archive.readUInt32LE(position + 42)
    if (position + 46 + nameLength + extraLength + commentLength > eocd) throw new Error('corrupt central directory')
    const nameBytes = archive.subarray(position + 46, position + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    // The reader is API of this plugin, so it is written for a hostile archive even though today it
    // only ever sees archives this module wrote.
    assertEntryName(name)
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`)
    seen.add(name)
    // An unknown method used to be treated as STORED, which hands the caller the compressed bytes as
    // if they were the file. Encryption and a data descriptor (sizes not in the local header) mean
    // the entry cannot be verified here at all: refused, not guessed.
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method in entry: ${name}`)
    if ((flags & REFUSED_FLAGS) !== 0) throw new Error(`unsupported zip entry flags: ${name}`)
    if (method === 0 && compressedSize !== size) throw new Error(`corrupt entry: ${name}`)
    // The declared size is a claim, not a budget: it is 32 bits wide and entirely under the writer's
    // control. `maxOutputLength: size + 1` therefore permitted a ~4 GiB allocation from a tiny file.
    if (size > READ_MAX_ENTRY_BYTES || compressedSize > READ_MAX_ENTRY_BYTES) throw new Error(`zip entry is too large: ${name}`)
    total += size
    if (total > READ_MAX_TOTAL_BYTES) throw new Error('zip archive is too large')
    if (localOffset + 30 > centralStart) throw new Error(`corrupt entry: ${name}`)
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt entry: ${name}`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    // The local header is not decoration: a reader that trusts only the central directory can be
    // told one name and one size while the bytes on disk say another.
    if (archive.readUInt16LE(localOffset + 6) !== flags || archive.readUInt16LE(localOffset + 8) !== method
      || archive.readUInt32LE(localOffset + 14) !== crc || archive.readUInt32LE(localOffset + 18) !== compressedSize
      || archive.readUInt32LE(localOffset + 22) !== size || localNameLength !== nameLength) {
      throw new Error(`local header does not match the central directory: ${name}`)
    }
    if (localOffset + 30 + localNameLength > centralStart) throw new Error(`corrupt entry: ${name}`)
    if (!archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) {
      throw new Error(`local header does not match the central directory: ${name}`)
    }
    const start = localOffset + 30 + localNameLength + localExtraLength
    // The payload must live BEFORE the central directory, not merely inside the buffer: an entry
    // whose data overlaps the directory it is described by is not an archive this reader accepts.
    if (start > centralStart || start + compressedSize > centralStart) throw new Error(`corrupt entry: ${name}`)
    headers.push({ name, size, compressedSize, method, crc, mode, start })
    position += 46 + nameLength + extraLength + commentLength
  }
  if (position !== eocd) throw new Error('corrupt central directory')
  return headers
}

/**
 * A LISTA do que há dentro, sem materializar byte nenhum de conteúdo.
 *
 * É o que a prévia da Biblioteca usa: nome e tamanho. Descompactar um pacote
 * inteiro para mostrar uma lista gastaria até meio gigabyte de memória para
 * responder a uma pergunta que o diretório central já responde.
 * @param archive - o arquivo inteiro.
 * @returns o nome e o tamanho de cada entrada.
 */
export function listZip(archive: Buffer): readonly { readonly name: string, readonly size: number }[] {
  return zipHeaders(archive).map(header => ({ name: header.name, size: header.size }))
}

/**
 * Read every entry back (used by tests and by the export self-check). A conferência estrutural é a
 * de `zipHeaders`; o que este acrescenta é descompactar e conferir CRC.
 */
export function readZip(archive: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  for (const header of zipHeaders(archive)) {
    const payload = archive.subarray(header.start, header.start + header.compressedSize)
    // `maxOutputLength` is what turns a zip bomb into an error instead of a heap that keeps growing.
    const data = header.method === 8 ? inflateRawSync(payload, { maxOutputLength: header.size + 1 }) : Buffer.from(payload)
    if (data.length !== header.size || crc32(data) !== header.crc) throw new Error(`corrupt entry: ${header.name}`)
    entries.push({ name: header.name, data, mode: header.mode })
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
