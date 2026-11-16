/**
 * Python for the pet: which interpreter to run, and where a portable one comes from.
 *
 * Order — settings.python (what the user typed) -> <data>/runtime/python/python.exe (downloaded once)
 * -> a `python` on PATH that can import tkinter and PIL. A machine with none of them gets the pinned
 * CPython build from the catalog (url + size + sha256), unpacked into the data dir, with Pillow pip-
 * installed into it. Nothing is bundled with the plugin and nothing is written into the plugin dir.
 *
 * The download and the tar.gz unpacking are done here in Node (node:https + node:zlib) rather than
 * through runtime/voice_cli.py: on a machine without Python that script cannot run, and that is
 * exactly the case this exists for. deps.py can install the same component (same catalog entry, same
 * `.installed` marker) when a Python is already around.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import { basename, delimiter, join, resolve } from 'node:path'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream'

export const COMPONENT = 'python-runtime'
/** what a usable interpreter must be able to import to run the pet */
export const PY_PROBE = 'import tkinter, PIL'
export const TK_PROBE = 'import tkinter'
export const PIP_MIRROR = 'https://mirrors.cloud.tencent.com/pypi/simple'
const TAR_BLOCK = 512

export const runtimeDir = (dataDir) => join(dataDir, 'runtime', 'python')
export const runtimePython = (dataDir, platform = process.platform) =>
  platform === 'win32' ? join(runtimeDir(dataDir), 'python.exe') : join(runtimeDir(dataDir), 'bin', 'python3')

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
export const looksLikePath = (v) => /[\\/]/.test(v) || /^[a-zA-Z]:/.test(v)

/** Every `python(.exe)` on PATH, in PATH order (no spawn: plain directory listing). */
export function pathCandidates (env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  const out = []
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir, n)
      if (isFile(p) && !out.includes(p)) out.push(p)
    }
  }
  return out
}

/** Run `<python> -X utf8 -c <code>`; ok only on exit code 0. */
export function probe (python, code = PY_PROBE, { spawn = nodeSpawn, env = process.env, timeoutMs = 20_000 } = {}) {
  return new Promise((done) => {
    let out = ''
    let child
    const finish = (ok, note) => { clearTimeout(timer); done({ ok, path: python, note: note || '' }) }
    const timer = setTimeout(() => { try { child && child.kill() } catch {} ; finish(false, '超时') }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(python, ['-X', 'utf8', '-c', code], { windowsHide: true, env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (e) { return finish(false, '启动失败') }
    child.stdout?.on('data', (b) => { out = (out + b).slice(-2000) })
    child.stderr?.on('data', (b) => { out = (out + b).slice(-2000) })
    child.on('error', () => finish(false, '找不到这个解释器'))
    child.on('close', (code2) => finish(code2 === 0, String(out).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''))
  })
}

/**
 * Pick an interpreter:
 *   1. settings.python — an explicit choice, taken as given (a typo'd path is reported, not skipped)
 *   2. <data>/runtime/python — the downloaded runtime, which must import tkinter
 *   3. a `python` on PATH — must import tkinter and PIL
 */
export async function resolvePython ({ settings, dataDir, env = process.env, platform = process.platform, spawn = nodeSpawn } = {}) {
  const want = String((settings && settings.python) || '').trim()
  if (want) {
    if (looksLikePath(want)) {
      if (isFile(want)) return { ok: true, path: want, source: 'settings' }
      return { ok: false, tried: [], message: '设置里的 Python 不存在：' + want }
    }
    const hit = pathCandidates(env, platform).find((p) => basename(p).toLowerCase().replace(/\.exe$/, '') === want.toLowerCase())
    return hit ? { ok: true, path: hit, source: 'settings' } : { ok: true, path: want, source: 'settings', unchecked: true }
  }
  const tried = []
  const bundled = runtimePython(dataDir, platform)
  if (isFile(bundled)) {
    const r = await probe(bundled, TK_PROBE, { spawn, env })
    if (r.ok) return { ok: true, path: bundled, source: 'bundled' }
    tried.push(bundled + '（' + (r.note || '不可用') + '）')
  }
  for (const p of pathCandidates(env, platform)) {
    const r = await probe(p, PY_PROBE, { spawn, env })
    if (r.ok) return { ok: true, path: p, source: 'system' }
    tried.push(p + '（' + (r.note || '不可用') + '）')
  }
  return { ok: false, tried, message: '需要准备 Python 运行时' }
}

/** Same decision without spawning anything: only an explicit setting can be settled this way. */
export function quickPython ({ settings, env = process.env, platform = process.platform } = {}) {
  const want = String((settings && settings.python) || '').trim()
  if (!want) return null
  if (looksLikePath(want)) return isFile(want) ? { path: want, source: 'settings' } : null
  const hit = pathCandidates(env, platform).find((p) => basename(p).toLowerCase().replace(/\.exe$/, '') === want.toLowerCase())
  return { path: hit || want, source: 'settings' }
}

// --------------------------------------------------------------------------- catalog
export function readCatalog (root) {
  try { const c = JSON.parse(readFileSync(join(root, 'runtime', 'pixelpet', 'voice', 'catalog.json'), 'utf8')); return Array.isArray(c) ? c : (c.components || []) } catch { return [] }
}

/** Same recipe as deps.py component_rev(): changes whenever the pinned file set changes. */
export function componentRev (comp) {
  const h = createHash('sha256')
  for (const f of comp.files || []) h.update(`${f.path}|${f.sha256}|${f.size}\n`)
  for (const p of comp.packages || []) h.update(p + '\n')
  return h.digest('hex').slice(0, 16)
}

function runtimeEntry (root, platform) {
  const comp = readCatalog(root).find((c) => c.id === COMPONENT)
  if (!comp) return null
  const files = (comp.files || []).filter((f) => !f.platform || f.platform === platform)
  return files.length ? { comp, file: files[0] } : null
}

export function runtimeInstalled (root, dataDir, platform = process.platform) {
  const entry = runtimeEntry(root, platform)
  if (!entry) return false
  try {
    const marker = JSON.parse(readFileSync(join(runtimeDir(dataDir), '.installed'), 'utf8'))
    return marker.rev === componentRev(entry.comp) && isFile(runtimePython(dataDir, platform))
  } catch { return false }
}

// --------------------------------------------------------------------------- download
/** maxBytes: hard ceiling (the catalog size); a larger Content-Length or body is aborted, not written out. */
export function downloadFile (url, dest, { onProgress, redirects = 6, timeoutMs = 120_000, get = null, maxBytes = 0 } = {}) {
  return new Promise((done, fail) => {
    const go = (u, left) => {
      const http = /^https:/.test(u) ? httpsGet : httpGet
      if (!/^https:/.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) return fail(new Error('下载源只接受 https：' + u))
      const req = (get || http)(u, { headers: { 'user-agent': 'dsh-pixel-pet/1' }, timeout: timeoutMs }, (res) => {
        const code = res.statusCode || 0
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume()
          if (left <= 0) return fail(new Error('跳转次数太多：' + url))
          return go(new URL(res.headers.location, u).toString(), left - 1)
        }
        if (code !== 200) { res.resume(); return fail(new Error('HTTP ' + code + '：' + basename(dest))) }
        const total = Number(res.headers['content-length']) || 0
        const tooBig = (n) => new Error('下载超过目录里写的大小（' + n + ' > ' + maxBytes + ' 字节），已中止：' + basename(dest))
        if (maxBytes > 0 && total > maxBytes) { res.destroy(); return fail(tooBig(total)) }
        let done2 = 0
        let over = false
        const out = createWriteStream(dest)
        res.on('data', (b) => {
          if (over) return
          done2 += b.length
          if (maxBytes > 0 && done2 > maxBytes) {
            over = true
            fail(tooBig(done2))
            res.unpipe(out); out.destroy(); res.destroy(); req.destroy()
            return
          }
          onProgress && onProgress(done2, total)
        })
        res.on('aborted', () => { if (over) return; out.destroy(); fail(new Error('下载中断：' + basename(dest))) })
        res.on('error', (e) => { if (over) return; out.destroy(); fail(new Error('下载中断：' + (e.message || e))) })
        out.on('error', (e) => fail(new Error('写文件失败：' + (e.message || e))))
        out.on('finish', () => { if (!over) done(done2) })
        res.pipe(out)
      })
      req.on('timeout', () => req.destroy(new Error('下载超时（' + Math.round(timeoutMs / 1000) + ' 秒没有数据）')))
      req.on('error', (e) => fail(new Error('连不上下载源：' + (e.message || e))))
    }
    go(url, redirects)
  })
}

export function sha256File (file) {
  return new Promise((done, fail) => {
    const h = createHash('sha256')
    pipeline(createReadStream(file), h, (err) => err ? fail(err) : done(h.digest('hex')))
  })
}

// --------------------------------------------------------------------------- tar.gz
function tarString (buf, off, len) {
  const s = buf.toString('latin1', off, off + len)
  const z = s.indexOf('\0')
  return (z >= 0 ? s.slice(0, z) : s).replace(/[\s\0]+$/, '')
}

function tarSize (buf, off, len) {
  if (buf[off] & 0x80) {                       // base-256, used for very large members
    let n = 0
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i]
    return n
  }
  const s = tarString(buf, off, len).replace(/^0+/, '')
  const n = s ? parseInt(s, 8) : 0
  return Number.isFinite(n) ? n : 0
}

function paxRecords (text) {
  const out = {}
  let i = 0
  while (i < text.length) {
    const sp = text.indexOf(' ', i)
    if (sp < 0) break
    const len = parseInt(text.slice(i, sp), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const rec = text.slice(sp + 1, i + len - 1)
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

/** Archive member -> path parts below the destination; null when it would escape or is empty. */
export function safeParts (name, strip = 0) {
  const rel = String(name).replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length || parts.includes('..')) return null
  const kept = parts.slice(Number(strip) || 0)
  return kept.length ? kept : null
}

/**
 * Streaming .tar.gz extraction, keeping the directory tree and dropping `strip` leading components.
 * Every member is mapped under `destDir` and anything that would escape it (absolute, drive letters,
 * "..") is refused instead of written. Symlinks and devices are skipped — the pinned build is a plain
 * Windows tree, and a symlink is the other classic way out of the destination.
 */
export function extractTarGz (archive, destDir, { strip = 0 } = {}) {
  const base = resolve(destDir)
  mkdirSync(base, { recursive: true })
  return new Promise((done, fail) => {
    let hold = Buffer.alloc(0)
    let cur = null             // record in progress: { fd, remaining, pad, meta }
    let longName = null        // GNU 'L' entry
    let pax = null             // pax extended header
    let files = 0
    let skipped = 0
    let finished = false

    let gunzip = null
    let src = null
    const bail = (err) => {
      if (finished) return
      finished = true
      if (cur && cur.fd !== null) { try { closeSync(cur.fd) } catch {} }
      cur = null
      // stop reading and inflating: an abandoned pipe would keep the archive handle open and keep
      // feeding consume() after we have already failed
      try { src && gunzip && src.unpipe(gunzip) } catch {}
      try { gunzip && gunzip.destroy() } catch {}
      try { src && src.destroy() } catch {}
      fail(err)
    }

    const endRecord = () => {
      if (!cur) return
      if (cur.fd !== null) { try { closeSync(cur.fd) } catch {} ; if (!cur.meta) files++ }
      if (cur.meta) {
        const text = Buffer.concat(cur.meta.parts).toString('utf8')
        if (cur.meta.type === 'L') longName = text.replace(/\0+$/, '').trim()
        else if (cur.meta.type === 'x') pax = { ...(pax || {}), ...paxRecords(text) }
      }
      cur = null
    }

    const consume = (chunk) => {
      let pos = 0
      for (;;) {
        if (cur) {
          if (cur.pad > 0) {
            const skip = Math.min(cur.pad, chunk.length - pos)
            cur.pad -= skip; pos += skip
            if (cur.pad > 0) return
            endRecord()
            continue
          }
          const take = Math.min(cur.remaining, chunk.length - pos)
          if (take > 0) {
            if (cur.fd !== null) writeSync(cur.fd, chunk.subarray(pos, pos + take))
            else if (cur.meta) cur.meta.parts.push(Buffer.from(chunk.subarray(pos, pos + take)))
            cur.remaining -= take; pos += take
          }
          if (cur.remaining > 0) return
          cur.pad = cur.padLen
          if (cur.pad === 0) { endRecord(); continue }
          continue
        }
        if (chunk.length - pos < TAR_BLOCK) { hold = Buffer.from(chunk.subarray(pos)); return }
        const header = chunk.subarray(pos, pos + TAR_BLOCK)
        pos += TAR_BLOCK
        if (header.every((b) => b === 0)) return           // end of archive
        const type = String.fromCharCode(header[156] || 0x30)
        const size = tarSize(header, 124, 12)
        const ustar = tarString(header, 257, 6).startsWith('ustar')
        const prefix = ustar ? tarString(header, 345, 155) : ''
        let name = tarString(header, 0, 100)
        if (prefix) name = prefix + '/' + name
        if (longName) { name = longName; longName = null }
        if (pax && pax.path) { name = pax.path; pax = { ...pax, path: undefined } }
        const pad = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK

        if (type === 'L' || type === 'x' || type === 'g' || type === 'K') {
          cur = { fd: null, remaining: size, size, pad: 0, padLen: pad, meta: { type, parts: [] } }
          continue
        }
        if (type === '5' || name.endsWith('/')) {
          const parts = safeParts(name, strip)
          if (parts) mkdirSync(join(base, ...parts), { recursive: true })
          else skipped++
          cur = { fd: null, remaining: size, size, pad: 0, padLen: pad, meta: null }
          if (size === 0) { cur.remaining = 0; cur.pad = 0; endRecord() }
          continue
        }
        if (type !== '0' && type !== '\0' && type !== '7') {   // symlink / device / fifo: never write those
          skipped++
          cur = { fd: null, remaining: size, size, pad: 0, padLen: pad, meta: null }
          if (size === 0) { cur.remaining = 0; cur.pad = 0; endRecord() }
          continue
        }
        const parts = safeParts(name, strip)
        if (!parts) { skipped++; cur = { fd: null, remaining: size, size, pad: 0, padLen: pad, meta: null }; continue }
        const target = join(base, ...parts)
        if (!resolve(target).startsWith(base + sepOf(base))) { skipped++; cur = { fd: null, remaining: size, size, pad: 0, padLen: pad, meta: null }; continue }
        mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
        const fd = openSync(target, 'w')
        cur = { fd, remaining: size, size, pad: 0, padLen: pad, meta: null }
        if (size === 0) { cur.remaining = 0; cur.pad = 0; endRecord() }
      }
    }

    gunzip = createGunzip()
    src = createReadStream(archive)
    src.on('error', bail)
    gunzip.on('error', bail)
    gunzip.on('data', (chunk) => {
      if (finished) return
      try {
        const buf = hold.length ? Buffer.concat([hold, chunk]) : chunk
        hold = Buffer.alloc(0)
        consume(buf)
      } catch (e) { bail(e) }
    })
    gunzip.on('end', () => {
      if (finished) return
      finished = true
      if (cur && cur.fd !== null) { try { closeSync(cur.fd) } catch {} }
      done({ files, skipped })
    })
    src.pipe(gunzip)
  })
}

function sepOf (p) { return p.endsWith('\\') || p.endsWith('/') ? '' : (process.platform === 'win32' ? '\\' : '/') }

// --------------------------------------------------------------------------- pip
export function pipInstall (python, packages, { spawn = nodeSpawn, env = process.env, indexUrl = '', timeoutMs = 600_000 } = {}) {
  return new Promise((done) => {
    const args = ['-X', 'utf8', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
      '--no-warn-script-location', '--upgrade', ...packages]
    if (indexUrl) args.push('--index-url', indexUrl)
    let out = ''
    let child
    const timer = setTimeout(() => { try { child && child.kill() } catch {} }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(python, args, { windowsHide: true, env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (e) { clearTimeout(timer); return done({ ok: false, message: '启动 pip 失败' }) }
    child.stdout?.on('data', (b) => { out = (out + b).slice(-4000) })
    child.stderr?.on('data', (b) => { out = (out + b).slice(-4000) })
    child.on('error', () => { clearTimeout(timer); done({ ok: false, message: '找不到解释器' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = String(out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')
      done({ ok: code === 0, message: code === 0 ? '' : (tail || 'pip 退出码 ' + code).slice(0, 300) })
    })
  })
}

// --------------------------------------------------------------------------- install
/**
 * Download + verify + unpack the pinned runtime, then Pillow into it. `progress` gets
 * ({ phase, done, total, message }) so the settings page can show a bar.
 */
export async function installRuntime ({ root, dataDir, platform = process.platform, env = process.env, spawn = nodeSpawn,
  logger, progress, downloadFile: dl = downloadFile } = {}) {
  const entry = runtimeEntry(root, platform)
  if (!entry) throw new Error('catalog 里没有 ' + COMPONENT)
  const { comp, file } = entry
  const report = progress || (() => {})
  const scratch = join(dataDir, 'runtime', '.downloads')
  mkdirSync(scratch, { recursive: true })
  const archive = join(scratch, basename(file.path))

  report({ phase: 'downloading', done: 0, total: file.size })
  try {
    await dl(file.url, archive, { maxBytes: Number(file.size) || 0, onProgress: (done, total) => report({ phase: 'downloading', done, total: total || file.size }) })
  } catch (e) {
    try { unlinkSync(archive) } catch {}         // never leave a half file behind to confuse the next attempt
    throw new Error('下载 Python 运行时失败：' + String((e && e.message) || e))
  }
  const size = (() => { try { return statSync(archive).size } catch { return -1 } })()
  if (size !== Number(file.size)) {
    try { unlinkSync(archive) } catch {}
    throw new Error(`下载大小不符（拿到 ${size}，应为 ${file.size}），已丢弃`)
  }
  report({ phase: 'verifying', done: file.size, total: file.size })
  const sha = await sha256File(archive).catch((e) => { throw new Error('计算 sha256 失败：' + e.message) })
  if (sha.toLowerCase() !== String(file.sha256).toLowerCase()) {
    try { unlinkSync(archive) } catch {}
    throw new Error('校验不符，已丢弃：sha256 ' + sha.slice(0, 16) + '… 应为 ' + String(file.sha256).slice(0, 16) + '…')
  }

  const target = runtimeDir(dataDir)
  report({ phase: 'extracting', done: file.size, total: file.size })
  rmSync(target, { recursive: true, force: true })
  const ex = file.extract || {}
  const res = await extractTarGz(archive, target, { strip: Number(ex.strip || 0) })
  try { unlinkSync(archive) } catch {}
  const exe = runtimePython(dataDir, platform)
  if (!isFile(exe)) throw new Error('解包完没找到 ' + basename(exe))
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, '.installed'), JSON.stringify({ id: COMPONENT, rev: componentRev(comp), at: Math.floor(Date.now() / 1000), files: res.files }))
  logger?.info?.('[dsh-pixel-pet] Python 运行时已就位：' + exe)
  return { path: exe, files: res.files, skipped: res.skipped }
}

/** make the interpreter able to run the pet: tkinter must be there, Pillow gets installed if missing */
export async function ensureImports (python, { env = process.env, spawn = nodeSpawn, progress, logger } = {}) {
  const report = progress || (() => {})
  const tk = await probe(python, TK_PROBE, { spawn, env })
  if (!tk.ok) throw new Error('这个解释器没有 tkinter：' + python)
  const pil = await probe(python, 'import PIL', { spawn, env })
  if (pil.ok) return { ok: true, added: [] }
  report({ phase: 'pip', message: 'Pillow' })
  let r = await pipInstall(python, ['Pillow'], { spawn, env, indexUrl: PIP_MIRROR })
  if (!r.ok) {
    logger?.warn?.('[dsh-pixel-pet] 镜像装 Pillow 失败，改用官方源：' + r.message)
    r = await pipInstall(python, ['Pillow'], { spawn, env })
  }
  if (!r.ok) throw new Error('装 Pillow 失败：' + r.message)
  const again = await probe(python, PY_PROBE, { spawn, env })
  if (!again.ok) throw new Error('装完 Pillow 仍然导入不了：' + (again.note || ''))
  return { ok: true, added: ['Pillow'] }
}

/**
 * Who to run, cached. `detect()` resolves only (used for the settings page); `ensure()` resolves and,
 * when nothing usable is around, downloads the runtime and installs Pillow — what a pet start needs.
 */
export function createPythonManager ({ root, dataDir, settings = () => ({}), logger, spawn = nodeSpawn,
  env = process.env, platform = process.platform, install = installRuntime } = {}) {
  let cached = null            // { path, source }
  let state = { phase: 'idle', message: '' }
  let note = ''                // why the last resolution failed
  let work = null
  const snapshot = () => ({
    path: cached ? cached.path : '',
    source: cached ? cached.source : '',
    phase: cached ? 'ready' : state.phase,           // ready | preparing | missing | error
    message: state.message || (cached ? '' : note),
    progress: state.progress || null,
  })
  const pick = async () => {
    const r = await resolvePython({ settings: settings(), dataDir, env, platform, spawn })
    if (!r.ok) { note = r.message || ''; return null }
    note = ''
    cached = { path: r.path, source: r.source }
    state = { phase: 'ready', message: '' }
    return cached
  }
  /** no spawn, no download: only an explicitly configured python can be settled this way */
  const quick = () => {
    if (cached) return cached.path
    const hit = quickPython({ settings: settings(), env, platform })
    if (!hit) return ''
    cached = hit
    state = { phase: 'ready', message: '' }
    return hit.path
  }
  const detect = () => (cached ? Promise.resolve(cached) : pick().then((c) => {
    if (!c) state = { phase: 'missing', message: note || '需要准备运行时' }
    return c
  }))
  const ensure = ({ force = false } = {}) => {
    if (work) return work
    if (force) cached = null
    if (cached) return Promise.resolve(cached)
    work = (async () => {
      state = { phase: 'preparing', message: '' }
      const hit = await pick()
      if (hit) return hit
      try {
        const res = await install({ root, dataDir, platform, env, spawn, logger,
          progress: (p) => { state = { ...state, phase: 'preparing', progress: p, message: p.message || '' } } })
        state = { phase: 'preparing', message: '', progress: { phase: 'pip', done: 0, total: 0 } }
        await ensureImports(res.path, { env, spawn, logger,
          progress: (p) => { state = { ...state, phase: 'preparing', progress: p, message: p.message || '' } } })
        cached = { path: res.path, source: 'bundled' }
        state = { phase: 'ready', message: '' }
        return cached
      } catch (e) {
        const message = String((e && e.message) || e).slice(0, 300)
        state = { phase: 'error', message }
        logger?.warn?.('[dsh-pixel-pet] 准备 Python 运行时失败：' + message)
        throw e
      }
    })().finally(() => { work = null })
    return work
  }
  /** "重新准备运行时": drop what was resolved and redo it, reinstalling if needed */
  const prepare = () => {
    cached = null
    state = { phase: 'preparing', message: '' }
    return ensure({ force: true })
  }
  const reset = () => { cached = null; note = ''; state = { phase: 'idle', message: '' } }
  return { snapshot, detect, ensure, prepare, quick, reset, get path () { return cached ? cached.path : '' }, get busy () { return !!work } }
}
