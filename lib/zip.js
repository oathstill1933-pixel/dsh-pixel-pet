/**
 * 最小的 zip 写入器（只存不压，UTF-8 文件名）。导出自己的记录时用，不引第三方依赖。
 *   zipBuffer([{ name: '日记/2026-11.md', data: Buffer|string }]) -> Buffer
 *   readZipNames(buf) -> string[]（测试用：读中央目录里的文件名）
 *   readZipEntry(buf, name) -> Buffer | null（测试用：只支持 store）
 */
let table = null
function crcTable () {
  if (table) return table
  table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}
export function crc32 (buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime (d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function zipBuffer (entries, now = new Date()) {
  const { time, date } = dosTime(now)
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)            // UTF-8 names
    local.writeUInt16LE(0, 8)                 // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(time, 12)
    cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += local.length + name.length + data.length
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cenBuf, end])
}

function centralEntries (buf) {
  const out = []
  let i = buf.length - 22
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--
  if (i < 0) return out
  const count = buf.readUInt16LE(i + 10)
  let p = buf.readUInt32LE(i + 16)
  for (let n = 0; n < count; n++) {
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    out.push({ name: buf.slice(p + 46, p + 46 + nameLen).toString('utf8'), offset: buf.readUInt32LE(p + 42), size: buf.readUInt32LE(p + 24), crc: buf.readUInt32LE(p + 16) })
    p += 46 + nameLen + extra + comment
  }
  return out
}
export const readZipNames = (buf) => centralEntries(buf).map((e) => e.name)
export function readZipEntry (buf, name) {
  const e = centralEntries(buf).find((x) => x.name === name)
  if (!e) return null
  const nameLen = buf.readUInt16LE(e.offset + 26)
  const extra = buf.readUInt16LE(e.offset + 28)
  const start = e.offset + 30 + nameLen + extra
  const data = buf.slice(start, start + e.size)
  return crc32(data) === e.crc ? data : null
}
