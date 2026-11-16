/**
 * Mail attachments on the local side: validate a path list, copy the files into
 * <data>/mailbox/files/<letter id>/, and answer the few questions the routes need.
 *
 * Rules (mirrored in the README):
 *   - png / jpg / jpeg / gif / webp / svg / html / htm / pdf only
 *   - one file <= 10 MB, at most 6 per letter
 *   - the bytes must match the extension (a .png that is really a JPEG is refused), SVG/HTML must be text
 *   - the source is only ever read: it is never moved, renamed or deleted
 *   - a symlink is refused, so a path cannot smuggle a file from somewhere else
 *   - copies land in a staging folder of THIS operation first and are renamed into place in one step,
 *     so a failure never leaves half a letter or touches an older one
 *   - nothing about the host path is stored on the letter: only {id, name, filename, size, mime, kind}
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, parse, resolve, sep } from 'node:path'
import { cardSource } from './mail-card-frame.js'

export const ATTACH_MAX = 6
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024

/** extension -> { mime, kind } */
export const ATTACH_TYPES = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.svg': { mime: 'image/svg+xml', kind: 'svg' },
  '.html': { mime: 'text/html; charset=utf-8', kind: 'html' },
  '.htm': { mime: 'text/html; charset=utf-8', kind: 'html' },
  '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'pptx' },
}

const MAGIC = {
  '.png': (b) => b.length > 8 && b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n',
  '.jpg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)),
  '.webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.pdf': (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-',
  '.pptx': (b) => b.length > 4 && b.toString('latin1', 0, 4) === 'PK\x03\x04',
}

/** a file name that is safe to store and to put in a header: no separators, no control chars, keeps the ext */
export function safeFileName (name, fallbackExt = '') {
  let n = basename(String(name || '').replace(/\\/g, '/')).normalize('NFC')
  n = n.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!n) n = 'file' + (fallbackExt || '')
  const ext = extname(n)
  if (n.length > 80) {
    const stem = n.slice(0, Math.max(1, 80 - ext.length))
    n = stem + ext
  }
  return n
}

const textOf = (buf) => {
  if (buf.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, '') } catch { return null }
}

/** does the content match the extension? (a picture renamed to .png is refused) */
export function contentMatches (buf, ext) {
  const check = MAGIC[ext]
  if (check) return check(buf)
  if (ext === '.svg' || ext === '.html' || ext === '.htm') {
    const head = buf.subarray(0, Math.min(buf.length, 4096))
    const text = textOf(head)
    if (text === null) return false
    if (ext === '.svg') {
      const body = text.replace(/^\s*(<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)/gi, '').trimStart()
      return /^<svg[\s>]/i.test(body)
    }
    return /<!doctype\s+html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(text)
  }
  return false
}

/** Resolve a local regular file without following a linked path component or a network path. */
export function plainLocalFile (input) {
  if (typeof input !== 'string' || !input) throw new TypeError('Invalid local file')
  const slash = (c) => c === '/' || c?.charCodeAt(0) === 92
  if ((slash(input[0]) && slash(input[1])) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new Error('附件只能是本机普通文件')
  const file = resolve(input)
  const root = parse(file).root
  const parts = file.slice(root.length).split(sep).filter(Boolean)
  let cursor = root; let st
  for (const [i, part] of parts.entries()) {
    cursor = join(cursor, part); st = lstatSync(cursor)
    if (st.isSymbolicLink()) throw new Error('附件路径不能包含符号链接')
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error('附件路径无效')
  }
  if (!st?.isFile()) throw new Error('附件不是普通文件')
  return { file, stat: st }
}

function mailDirectory (input, create = false) {
  const slash = (c) => c === '/' || c?.charCodeAt(0) === 92
  if (slash(input[0]) && slash(input[1])) throw new Error('信箱不能使用网络路径')
  const full = resolve(input); const root = parse(full).root
  let cursor = root
  for (const part of full.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let st
    try { st = lstatSync(cursor) } catch (e) {
      if (!create || e.code !== 'ENOENT') throw e
      mkdirSync(cursor); st = lstatSync(cursor)
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('信箱目录不能包含链接或非目录')
  }
  return full
}

function readBounded (file) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > ATTACH_MAX_BYTES) throw new Error('附件太大或不是普通文件')
    const parts = []; let total = 0
    while (total <= ATTACH_MAX_BYTES) {
      const b = Buffer.alloc(Math.min(65536, ATTACH_MAX_BYTES + 1 - total))
      const n = readSync(fd, b, 0, b.length, null)
      if (!n) break
      total += n; parts.push(b.subarray(0, n))
    }
    if (total > ATTACH_MAX_BYTES || total !== st.size) throw new Error('附件读取时发生变化或超过上限')
    return Buffer.concat(parts, total)
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function regularFileWithin (base, input) {
  try {
    const root = resolve(base); const full = resolve(input)
    if (!full.startsWith(root + sep)) return null
    const checked = plainLocalFile(full)
    const realRoot = realpathSync(root); const realFile = realpathSync(checked.file)
    return realFile.startsWith(realRoot + sep) ? checked.file : null
  } catch { return null }
}

/** Bounded read for a stored attachment; never follow a link or read outside the letter directory. */
export function readMailFile (base, file) {
  const safe = regularFileWithin(base, file)
  if (!safe) return null
  try { return readBounded(safe) } catch { return null }
}

/** one message for the model / the page, or null when the file is fine */
export function checkOne (p, seen = new Set()) {
  if (typeof p !== 'string' || !p.trim()) return { error: '附件要写本机文件路径' }
  let checked
  try { checked = plainLocalFile(p) } catch (e) { return { error: (e?.code === 'ENOENT' ? '附件不存在' : '附件路径不安全或不可读') + '：' + basename(p) } }
  const full = checked.file; const st = checked.stat
  if (st.size > ATTACH_MAX_BYTES) return { error: '附件太大（单个上限 10 MB）：' + basename(p) }
  const ext = extname(full).toLowerCase()
  const t = ATTACH_TYPES[ext]
  if (!t) return { error: '不支持的附件类型：' + (ext || basename(p)) }
  let buf
  try { buf = readBounded(full) } catch { return { error: '附件读取失败、发生变化或超出上限：' + basename(p) } }
  if (!buf.length) return { error: '附件是空文件：' + basename(p) }
  if (!contentMatches(buf, ext)) return { error: '文件内容和扩展名不一致：' + basename(p) }
  const key = process.platform === 'win32' ? full.toLowerCase() : full
  if (seen.has(key)) return null // the same path twice is one attachment, not an error
  seen.add(key)
  return { path: full, name: safeFileName(basename(full), ext), size: buf.length, mime: t.mime, kind: t.kind, ext, bytes: buf }
}

/**
 * Validate a whole list before anything is written.
 * -> { files: [{path,name,size,mime,kind,ext}], errors: [text] } (errors != [] means: do nothing)
 */
export function planAttachments (list) {
  if (list === undefined || list === null) return { files: [], errors: [] }
  if (!Array.isArray(list)) return { files: [], errors: ['attachments 要是一个路径数组'] }
  if (list.length > ATTACH_MAX) return { files: [], errors: ['一封最多带 ' + ATTACH_MAX + ' 个附件'] }
  const seen = new Set()
  const files = []
  const errors = []
  for (const p of list) {
    const r = checkOne(p, seen)
    if (r && r.error) errors.push(r.error)
    else if (r) files.push(r)
  }
  return { files, errors }
}

/** copy into a staging folder of this operation; -> { dir, names } */
export function stageAttachments (mailboxDir, files) {
  mailDirectory(mailboxDir, true)
  const dir = join(mailboxDir, '.staging-' + randomBytes(6).toString('hex'))
  mkdirSync(dir)
  try {
    const names = []
    const used = new Set()
    for (const [i, f] of files.entries()) {
      const id = 'a' + (i + 1)
      // keep the original name: a card's relative <img src="photo.png"> must still resolve inside the letter
      let stored = f.name
      let n = 2
      while (used.has(stored.toLowerCase())) { stored = n++ + '-' + f.name }
      used.add(stored.toLowerCase())
      // Use the validated bounded byte snapshot: never reopen a source that may have changed.
      const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : readBounded(plainLocalFile(f.path).file)
      if (bytes.length !== f.size || bytes.length > ATTACH_MAX_BYTES) throw new Error('附件大小发生变化：' + f.name)
      writeFileSync(join(dir, stored), bytes, { flag: 'wx', mode: 0o600 })
      const size = statSync(join(dir, stored)).size
      if (size !== f.size) throw new Error('复制后大小不一致：' + f.name)
      names.push({ id, name: stored, filename: f.name, size, mime: f.mime, kind: f.kind })
    }
    return { dir, files: names }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/** staging -> files/<letter id>/ (one rename, then the staging folder is gone) */
export function commitAttachments (mailboxDir, staging, mailId) {
  if (!/^[a-z]-[a-z0-9]+$/.test(String(mailId))) throw new Error('无效信件标识')
  const dest = join(mailboxDir, 'files', mailId)
  try {
    mailDirectory(join(mailboxDir, 'files'), true)
    if (existsSync(dest)) throw new Error('附件目录已存在，拒绝覆盖旧信')
    renameSync(staging.dir, dest)
    return staging.files
  } catch (e) {
    // this operation's staging folder never outlives a failed commit
    rmSync(staging.dir, { recursive: true, force: true })
    throw e
  }
}

export const dropStaging = (staging) => { if (staging && staging.dir) { try { rmSync(staging.dir, { recursive: true, force: true }) } catch {} } }

/** remove only the files of these letters (never shared: every letter owns its folder) */
export function purgeLetterFiles (mailboxDir, ids) {
  let n = 0
  let root
  try { root = mailDirectory(join(mailboxDir, 'files')) } catch { return 0 }
  for (const id of ids || []) {
    if (!/^[a-z]-[a-z0-9]+$/.test(String(id || ''))) continue
    const target = resolve(root, id)
    if (!target.startsWith(root + sep)) continue
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      rmSync(target, { recursive: true, force: true }); n++
    } catch {}
  }
  return n
}

/** the attachment of a letter, by id (never by a path from the request) -> { att, file } | null */
export function findAttachment (mailboxDir, item, attId) {
  if (!item || !/^[a-z]-[a-z0-9]+$/.test(String(item.id)) || !Array.isArray(item.attachments)) return null
  const att = item.attachments.find((a) => a && a.id === String(attId))
  if (!att || typeof att.name !== 'string' || !/^[^\x00-\x1f<>:"/\\|?*]{1,120}$/.test(att.name) || att.name.startsWith('.')) return null
  const dir = resolve(mailboxDir, 'files', String(item.id))
  const file = resolve(dir, att.name)
  if (!file.startsWith(dir + sep)) return null
  const safe = regularFileWithin(dir, file)
  return safe ? { att, file: safe } : null
}

/** Content-Disposition with an ASCII fallback and the real name in RFC 5987 form */
export function disposition (name, inline = false) {
  const safe = safeFileName(name)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return (inline ? 'inline' : 'attachment') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe)
}

/** CSP for an attachment document served into the sandboxed card frame: only this letter's own files */
export function attachmentCsp (origin, resourceBase) {
  let source = "'none'"
  try {
    const base = new URL(resourceBase)
    if (base.origin === new URL(origin).origin) source = cardSource(base.href)
  } catch {}
  return [
    "default-src 'none'",
    'img-src ' + (source === "'none'" ? '' : source + ' ') + 'data: blob:',
    'media-src ' + source,
    'style-src ' + (source === "'none'" ? '' : source + ' ') + "'unsafe-inline'",
    'script-src ' + (source === "'none'" ? '' : source + ' ') + "'unsafe-inline'",
    'font-src ' + (source === "'none'" ? '' : source + ' ') + 'data:',
    "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'",
    "form-action 'none'", "base-uri 'none'", "object-src 'none'", 'sandbox allow-scripts',
    // The trusted wrapper is itself an opaque sandbox, so no origin-based frame-ancestors rule here.
  ].join('; ')
}
