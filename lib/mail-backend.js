/**
 * MailBackend adapters. Contract (backend-agnostic; the pet only ever reads the local InboxStore):
 *
 *   interface Message { id, from: { email, name? }, subject, body, createdAt, attachments: [{ id?, filename, size, url? }],
 *                       html?, footer?, quoted?, inReplyTo?, references? }
 *   interface MailBackend {
 *     readonly name                                   'local' | 'agently'
 *     capabilities()   -> { canSend, canReceive, maxAttachments?, maxTotalBytes?, dailySendLimit?, remoteOps }
 *     send(to, subject, body, attachments?) -> { ref }          pet -> user
 *     watch(onMessage) -> stop()                                  user -> pet
 *     fetchAttachment(msgId, attId) -> local path
 *     health()         -> 'ok' | 'auth-required' | 'rate-limited' | 'offline'
 *   }
 *
 * Mailbox housekeeping (star, delete, clear, mark read) always runs on the InboxStore. `remoteOps` lists the ones a
 * backend could also mirror upstream; neither adapter mirrors any today, so they stay local (the user's real
 * mailbox is never touched from here).
 *
 * LocalFileBackend — default, zero dependencies, always available.
 * AgentlyBackend   — optional. Spawns the user's own, self-installed official `agently-cli`; this plugin ships no CLI,
 *                    no copy of the official skill text, never calls the service API directly, never signs anyone up.
 *                    Mail content passes through a third-party server: confidential material must never go this way.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

export class MailError extends Error {
  constructor (code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra) }
}

const MAX_FILE = 20 * 1024 * 1024
const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]{1,120}$/
const TEXT_EXT = new Set(['.md', '.txt', '.markdown'])
/** housekeeping ops the mailbox window offers; a backend lists in remoteOps the ones it can mirror upstream */
export const MAILBOX_OPS = Object.freeze(['star', 'delete', 'clear', 'read'])
const NO_REMOTE_OPS = Object.freeze({ star: false, delete: false, clear: false, read: false })

// =========================================================================== local
export class LocalFileBackend {
  /**
   * @param {string} dir  <data>/mailbox
   * @param {{ pollMs?: number, settleMs?: number, now?: () => number }} o
   *
   * Receive: drop a .md / .txt / .json (or any file up to 20 MB, e.g. an image) into <dir>/drop/.
   * Send:    writes <dir>/outbox/<stamp>-<id>.md (the letter itself lives in the InboxStore).
   */
  constructor (dir, o = {}) {
    this.name = 'local'
    this.dir = dir
    this.dropDir = join(dir, 'drop')
    this.outDir = join(dir, 'outbox')
    this.filesDir = join(dir, 'files')
    this.pollMs = o.pollMs ?? 2000
    this.settleMs = o.settleMs ?? 400
    this.now = o.now || Date.now
    this._busy = false
  }

  async capabilities () { return { canSend: true, canReceive: true, maxAttachments: 10, maxTotalBytes: MAX_FILE, remoteOps: { ...NO_REMOTE_OPS } } }
  async health () { return 'ok' }

  async send (to, subject, body) {
    mkdirSync(this.outDir, { recursive: true })
    const id = new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex')
    const file = join(this.outDir, id + '.md')
    writeFileSync(file, (subject ? '# ' + String(subject).replace(/\r?\n/g, ' ') + '\n\n' : '') + String(body || '') + '\n', 'utf8')
    return { ref: 'local:' + id }
  }

  async watch (onMessage) {
    mkdirSync(this.dropDir, { recursive: true })
    let stopped = false
    let w = null
    const kick = () => { if (!stopped) this.scan(onMessage).catch(() => {}) }
    try { w = fsWatch(this.dropDir, { persistent: false }, () => setTimeout(kick, this.settleMs + 20)) } catch {}
    const timer = setInterval(kick, this.pollMs)
    if (timer.unref) timer.unref()
    kick()
    return () => { stopped = true; clearInterval(timer); try { w && w.close() } catch {} }
  }

  /** One pass over the drop folder. Exposed for tests. -> number of messages handed over */
  async scan (onMessage) {
    if (this._busy) return 0
    this._busy = true
    let n = 0
    try {
      let names = []
      try { names = readdirSync(this.dropDir) } catch { return 0 }
      // files a .json note lists as its attachments belong to that note, not standalone messages
      const claimed = new Set()
      for (const fn of names) {
        if (extname(fn).toLowerCase() !== '.json') continue
        try { const j = JSON.parse(readFileSync(join(this.dropDir, fn), 'utf8').replace(/^﻿/, '')); for (const a of (j && Array.isArray(j.attachments) ? j.attachments : [])) claimed.add(basename(String(a))) } catch {}
      }
      for (const fn of names.sort()) {
        if (fn.startsWith('.') || claimed.has(fn) || /\.(tmp|part|partial|crdownload)$/i.test(fn)) continue
        const full = join(this.dropDir, fn)
        let st
        try { st = statSync(full) } catch { continue }
        if (!st.isFile() || this.now() - st.mtimeMs < this.settleMs) continue
        const msg = this._toMessage(fn, full, st)
        if (!msg) { this._park(full, fn, '.rejected'); continue }
        await onMessage(msg)                      // throws -> file stays, picked up again next pass
        if (msg.attachments.length) {
          const d = join(this.filesDir, msg.id); mkdirSync(d, { recursive: true })
          for (const a of msg._files) { try { renameSync(a.from, join(d, a.name)) } catch {} }
        }
        if (msg._textFile) this._park(full, fn, '.done')
        n++
      }
    } finally { this._busy = false }
    return n
  }

  _park (full, fn, sub) {
    const d = join(this.dropDir, sub); mkdirSync(d, { recursive: true })
    try { renameSync(full, join(d, Date.now().toString(36) + '-' + fn)) } catch {}
  }

  _toMessage (fn, full, st) {
    const ext = extname(fn).toLowerCase()
    const id = 'drop-' + createHash('sha1').update(fn + '|' + st.size + '|' + Math.round(st.mtimeMs)).digest('hex').slice(0, 16)
    const base = { id, from: { email: '', name: 'local' }, createdAt: new Date(st.mtimeMs).toISOString(), attachments: [], _files: [] }
    if (st.size > MAX_FILE) return null
    if (TEXT_EXT.has(ext)) {
      const raw = readFileSync(full, 'utf8').replace(/^﻿/, '')
      const m = raw.match(/^#\s+(.+)\r?\n+/)
      return { ...base, subject: m ? m[1].trim() : '', body: (m ? raw.slice(m[0].length) : raw).trim(), _textFile: true }
    }
    if (ext === '.json') {
      let j
      try { j = JSON.parse(readFileSync(full, 'utf8').replace(/^﻿/, '')) } catch { return null }
      if (!j || typeof j !== 'object') return null
      const msg = { ...base, subject: String(j.subject || ''), body: String(j.body || '').trim(), _textFile: true }
      for (const a of Array.isArray(j.attachments) ? j.attachments.slice(0, 10) : []) {
        const name = basename(String(a))
        const p = join(this.dropDir, name)
        if (!SAFE_NAME.test(name) || !existsSync(p)) continue
        msg.attachments.push({ id: name, filename: name, size: statSync(p).size })
        msg._files.push({ from: p, name })
      }
      return msg.body || msg.attachments.length ? msg : null
    }
    if (!SAFE_NAME.test(fn)) return null
    return { ...base, subject: '', body: '', attachments: [{ id: fn, filename: fn, size: st.size }], _files: [{ from: full, name: fn }] }
  }

  async fetchAttachment (msgId, attId) {
    const base = resolve(this.filesDir)
    const p = resolve(base, String(msgId), String(attId))
    if (!p.startsWith(base + sep) || !existsSync(p)) throw new MailError('not-found', '没有这个附件')
    return p
  }
}

// =========================================================================== mail body helpers
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
export function htmlToText (html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m }
      return ENT[e.toLowerCase()] ?? m
    })
    .replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Find the element that starts at the tag containing `at`; -> [start, end) of the whole element. */
function elementSpan (html, at) {
  const start = html.lastIndexOf('<', at)
  const tag = (html.slice(start + 1).match(/^([a-zA-Z0-9]+)/) || [])[1]
  if (!tag) return null
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi')
  re.lastIndex = start
  let depth = 0; let m
  while ((m = re.exec(html))) {
    if (m[0].endsWith('/>')) continue
    depth += m[1] ? -1 : 1
    if (depth === 0) return [start, m.index + m[0].length]
  }
  return [start, html.length]
}

const QUOTE_MARKS = [/<div[^>]+id=["']?divRplyFwdMsg/i, /<div[^>]+class=["'][^"']*gmail_quote/i, /<blockquote\b/i, /<hr\b/i,
  /-{3,}\s*Original Message\s*-{3,}/i, /<div[^>]+class=["'][^"']*(?:xm_compose_origin|qmbox)/i]
const FOOTER_ATTR = /data-xmail_bot_mail_report/i
// capability-style query values (unbind / report links may carry tokens): never stored, never logged
const CAPABILITY_Q = /([?&](?:refresh_token|access_token|token|ticket|sid|key|code|sig|signature)=)[^&"'\s<>]+/gi

export const redactCapabilityUrls = (s) => String(s || '').replace(CAPABILITY_Q, '$1[redacted]')

/**
 * Incoming mail body -> { text, footer, quoted, html }.
 *  text   = the new part only (quoted chain cut off at the first reply separator), footer block removed from it
 *  footer = text of the service's compliance footer in the new part — kept, shown once
 *  quoted = text of the reply chain (repeated footers inside stay there, folded in the UI)
 *  html   = the original HTML, untouched except token-bearing query values (never stored)
 */
export function splitMailBody (body, format) {
  const raw = String(body || '')
  const isHtml = /html/i.test(String(format || '')) || /<(div|p|br|html|body|span|table)\b/i.test(raw)
  if (!isHtml) return { text: raw.trim(), footer: '', quoted: '', html: '' }
  let cut = raw.length
  for (const re of QUOTE_MARKS) { const m = raw.match(re); if (m && m.index < cut) cut = m.index }
  let head = raw.slice(0, cut)
  const quoted = cut < raw.length ? htmlToText(raw.slice(cut)) : ''
  let footer = ''
  const fm = head.match(FOOTER_ATTR)
  if (fm) {
    const span = elementSpan(head, fm.index)
    if (span) { footer = htmlToText(head.slice(span[0], span[1])); head = head.slice(0, span[0]) + head.slice(span[1]) }
  }
  return { text: htmlToText(head), footer, quoted, html: redactCapabilityUrls(raw) }
}

/** Agently NDJSON / JSON message -> Message */
export function mapAgentlyMessage (m, now = () => new Date().toISOString()) {
  const raw = m && typeof m === 'object' ? (m.message && typeof m.message === 'object' ? m.message : m) : {}
  const parts = splitMailBody(raw.body ?? raw.content ?? '', raw.body_format)
  return {
    id: String(raw.message_id || raw.id || ''),
    rfcId: raw.rfc_message_id ? String(raw.rfc_message_id) : undefined,
    inReplyTo: raw.in_reply_to ? String(raw.in_reply_to) : undefined,
    references: Array.isArray(raw.references) ? raw.references.map(String) : [],
    from: { email: String(raw.from && raw.from.email || ''), ...(raw.from && raw.from.name ? { name: String(raw.from.name) } : {}) },
    subject: String(raw.subject || ''),
    createdAt: String(raw.created_at || raw.createdAt || now()),
    body: parts.text, html: parts.html || undefined, footer: parts.footer || undefined, quoted: parts.quoted || undefined,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map((a) => ({
      id: a.attachment_id || a.att_id || a.id, filename: String(a.filename || a.name || 'file'), size: Number(a.size) || 0,
    })),
  }
}

const dataOf = (j) => (j && typeof j === 'object' && j.data !== undefined ? j.data : j)
function parseJson (s) {
  const t = String(s || '').trim()
  if (!t) return null
  try { return JSON.parse(t) } catch {}
  const last = t.split(/\r?\n/).filter(Boolean).pop()
  try { return JSON.parse(last) } catch { return null }
}
function listOf (j) {
  const d = dataOf(j)
  for (const c of [d && d.messages, d && d.items, d && d.list, j && j.messages, j && j.items, d]) if (Array.isArray(c)) return c
  return []
}
export function parseRetryAfter (text) {
  const m = String(text || '').match(/retry[-_ ]?after["':=\s]+(\d+)/i)
  return m ? Math.min(3600, Number(m[1])) * 1000 : null
}

// =========================================================================== agently
export const EXIT = { OK: 0, GENERAL: 1, AUTH: 3, NETWORK: 4, INVALID: 6, RATE: 7 }
export const AGENTLY_STATES = ['unconfigured', 'authorizing', 'active', 'degraded', 'disabled', 'auth-required']

/**
 * Only a real authorization failure may pause receiving, ask for a re-auth and slow-probe.
 * The CLI reports it as exit code 3, or as {"error":{"type":"auth",...}} on stdout/stderr.
 * A dropped network, a proxy hiccup, a missing CLI or a timeout must never be mistaken for it — otherwise
 * one offline moment sends the user off to re-scan a barcode for nothing (lead 2026-11-16).
 */
const AUTH_ERROR_JSON = /"type"\s*:\s*"auth"/
export const isAuthFailure = (code, text) => {
  if (code === -1) return false                       // ENOENT / spawn failure: the CLI is not even there
  if (code === EXIT.AUTH) return true
  return AUTH_ERROR_JSON.test(String(text || ''))
}

const winQuote = (a) => '"' + String(a).replace(/["%!^\r\n]/g, ' ') + '"'
const localDay = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

export class AgentlyBackend {
  /**
   * @param {{
   *   workDir: string,                         where body files / downloads go (the CLI only takes relative paths)
   *   command?: string, prefixArgs?: string[], the user's agently-cli (default: agently-cli on PATH)
   *   consent?: () => boolean,                 user explicitly allowed automatic sending
   *   dailyLimit?: number, backoffMs?: number[], retryDelayMs?: number, runTimeoutMs?: number,
   *   now?: () => number, spawnImpl?: typeof spawn, logger?: any, onState?: (s) => void,
   *   probeBackoffMs?: number[],               auth-required re-auth probing: 5 → 15 → 60 min, capped
   *   backfillMax?: number, backfillPage?: number, backfillPages?: number,   gap-fill budget (default 200 / 50 / 5)
   *   openUrl?: (url: string) => boolean,      system browser, for the re-auth link (never logged, never stored)
   * }} o
   */
  constructor (o) {
    this.name = 'agently'
    this.workDir = o.workDir
    this.command = o.command || 'agently-cli'
    this.prefixArgs = Array.isArray(o.prefixArgs) ? o.prefixArgs : []
    this.consent = o.consent || (() => false)
    this.dailyLimit = o.dailyLimit ?? 45
    this.backoffMs = o.backoffMs || [5000, 15000, 60000]
    this.retryDelayMs = o.retryDelayMs ?? 1500
    this.runTimeoutMs = o.runTimeoutMs ?? 60000
    this.now = o.now || Date.now
    this.spawnImpl = o.spawnImpl || spawn
    this.logger = o.logger
    this.onState = o.onState || null
    // re-auth probing after a drop: 5 → 15 → 60 minutes, capped; state is memory only (reload starts at 5 again)
    this.probeBackoffMs = o.probeBackoffMs || [5 * 60e3, 15 * 60e3, 60 * 60e3]
    // gap-fill: the CLI pages with --cursor and caps a page at 50, so 200 letters take at most 4 round trips
    this.backfillMax = o.backfillMax ?? 200
    this.backfillPage = o.backfillPage ?? 50
    this.backfillPages = o.backfillPages ?? 5
    this.openUrl = o.openUrl || null
    this.stateFile = join(this.workDir, 'state.json')
    this.state = 'unconfigured'
    this.child = null
    this.attempt = 0
    this.restarts = 0
    this.seen = new Set()
    this.stopped = true
    this.timer = null
    this.rateUntil = 0
    this.droppedAt = ''                 // when the watcher lost its authorization (memory only)
    this.probeAttempt = 0
    this.probeTimer = null
    this.login = null                   // the `auth login` process the user started, if any
    this.backfillInfo = null            // { at, fetched, added, truncated } — last gap-fill, for the settings page
  }

  _setState (s) {
    if (s === this.state) return
    this.state = s
    if (s === 'auth-required') this._scheduleProbe()
    else this._resetProbe()
    if (this.onState) { try { this.onState(s) } catch {} }
  }

  /** Leave auth-required: forget the drop and go back to the first (5 min) probe delay. */
  _resetProbe () {
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null }
    this.probeAttempt = 0
    this.droppedAt = ''
  }

  /**
   * Enter auth-required and start the slow probe. Called only for a genuine EXIT.AUTH — network errors,
   * a missing CLI and timeouts keep the ordinary degraded/unconfigured path and never ask for a re-auth.
   */
  _enterAuth () {
    if (!this.droppedAt) this.droppedAt = new Date(this.now()).toISOString()
    this._setState('auth-required')            // no-op (and no second probe) while already there
  }

  /** One probe timer at a time; the delay walks 5 → 15 → 60 min and stays at the cap. */
  _scheduleProbe () {
    if (this.stopped || this.state !== 'auth-required' || this.probeTimer) return
    const ms = this.probeBackoffMs[Math.min(this.probeAttempt, this.probeBackoffMs.length - 1)]
    const timer = setTimeout(() => { this.probeTimer = null; this._probe().catch(() => {}) }, ms)
    if (timer.unref) timer.unref()
    this.probeTimer = timer
  }

  /** Try the cheap auth check; a success is what re-arms the real watcher (see health()). */
  async _probe () {
    if (this.stopped || this.state !== 'auth-required') return
    try { await this.health() } catch {}
    if (this.state !== 'auth-required') return  // health() re-armed the watcher and _setState reset the probe
    this.probeAttempt++
    this._scheduleProbe()
  }

  _persist () {
    try { const t = this.stateFile + '.tmp'; mkdirSync(this.workDir, { recursive: true }); writeFileSync(t, JSON.stringify(this.disk)); renameSync(t, this.stateFile) } catch {}
  }

  get disk () {
    if (!this._disk) {
      let d = {}
      try { d = JSON.parse(readFileSync(this.stateFile, 'utf8')) || {} } catch {}
      this._disk = { day: d.day || '', sent: Number(d.sent) || 0, lastSeenAt: d.lastSeenAt || '', backfillTruncated: d.backfillTruncated === true }
    }
    return this._disk
  }

  quota () {
    const d = this.disk; const today = localDay(this.now())
    if (d.day !== today) { d.day = today; d.sent = 0 }
    return { used: d.sent, limit: this.dailyLimit, left: Math.max(0, this.dailyLimit - d.sent) }
  }

  _needsShell () {
    if (/\.(cmd|bat)$/i.test(this.command)) return true
    return process.platform === 'win32' && !isAbsolute(this.command) && !extname(this.command)
  }

  _spawn (args, cwd) {
    mkdirSync(cwd || this.workDir, { recursive: true })
    const all = [...this.prefixArgs, ...args]
    const shell = this._needsShell()
    const cmd = shell ? (/\s/.test(this.command) ? winQuote(this.command) : this.command) : this.command
    return this.spawnImpl(cmd, shell ? all.map(winQuote) : all, {
      cwd: cwd || this.workDir, windowsHide: true, shell, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
  }

  /** One CLI call -> { code, stdout, stderr }. code -1 = CLI not found. Never throws. */
  run (args, { cwd, timeoutMs } = {}) {
    return new Promise((done) => {
      let out = ''; let err = ''; let child; let settled = false
      const finish = (r) => { if (!settled) { settled = true; clearTimeout(t); done(r) } }
      try { child = this._spawn(args, cwd) } catch (e) { return finish({ code: -1, stdout: '', stderr: String(e && e.message || e) }) }
      const t = setTimeout(() => { try { child.kill() } catch {} finish({ code: EXIT.NETWORK, stdout: out, stderr: 'timeout' }) }, timeoutMs || this.runTimeoutMs)
      child.stdout.on('data', (b) => { out += b; if (out.length > 4e6) out = out.slice(-4e6) })
      child.stderr.on('data', (b) => { err = (err + b).slice(-4000) })
      child.on('error', (e) => finish({ code: e && e.code === 'ENOENT' ? -1 : EXIT.GENERAL, stdout: out, stderr: String(e && e.message || e) }))
      child.on('close', (code) => finish({ code: code ?? EXIT.GENERAL, stdout: out, stderr: err }))
    })
  }

  async capabilities () {
    // agently-cli has no star / delete / mark-read we may rely on: those stay in the local InboxStore
    return { canSend: true, canReceive: true, maxAttachments: 50, maxTotalBytes: MAX_FILE, dailySendLimit: this.dailyLimit, remoteOps: { ...NO_REMOTE_OPS } }
  }

  async health () {
    if (this.rateUntil > this.now()) return 'rate-limited'
    const r = await this.run(['auth', 'status'], { timeoutMs: 15000 })
    if (r.code === 0) {
      // the token is fine, but "已连接" must mean something is actually listening: a good probe re-arms the watcher
      if (!this.stopped && !this.child) this._start(false, true)
      return 'ok'
    }
    if (isAuthFailure(r.code, r.stderr)) { this._enterAuth(); return 'auth-required' }
    if (r.code === EXIT.RATE) return 'rate-limited'
    return 'offline'
  }

  /**
   * Re-authorization from the settings page: run the user's own `auth login` in the background, lift the
   * authorization link out of its output and hand it to the system browser. The link is never logged and
   * never stored; the login process is left running (the user is the one who scans).
   * -> { ok, started?, running?, opened?, code? }
   */
  async reauth (o = {}) {
    if (this.login) {
      // a click during a live login re-uses it — but the printed link dies after ~15–20 min, so an older process
      // is stale: restart it instead of leaving the user with a dead link and a button that does nothing
      const age = this.now() - this.login.at
      if (age < (o.reloginAfterMs ?? 15 * 60e3)) return { ok: true, running: true, opened: !!this.login.opened }
      try { this.login.child.kill() } catch {}
      this.login = null
    }
    let child
    try { child = this._spawn(['auth', 'login']) } catch (e) {
      return { ok: false, code: 'not-installed', message: String(e && e.message || e).slice(0, 120) }
    }
    const state = { child, url: '', opened: false, done: false, at: this.now() }
    this.login = state
    let out = ''
    let wake = null
    const wakeUp = () => { if (wake) { const f = wake; wake = null; f() } }
    const scan = (buf) => {
      if (state.url) return
      out = (out + buf).slice(-8000)
      const m = out.match(/https?:\/\/[^\s"'`<>)\]]+/)
      if (!m) return
      state.url = m[0].replace(/[.,;:)]+$/, '')
      try { state.opened = !!(this.openUrl && this.openUrl(state.url)) } catch { state.opened = false }
      wakeUp()
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    const guard = setTimeout(() => { try { child.kill() } catch {} }, o.loginTimeoutMs ?? 20 * 60e3)
    if (guard.unref) guard.unref()
    const finish = (code) => {
      if (state.done) return
      state.done = true
      clearTimeout(guard)
      if (this.login === state) this.login = null
      if (isAuthFailure(code, out)) this._enterAuth()
      else if (code === 0) this.health().catch(() => {})   // authorized: health() re-arms the watcher, which gap-fills
      wakeUp()
    }
    child.on('error', (e) => finish(e && e.code === 'ENOENT' ? -1 : EXIT.GENERAL))
    child.on('close', (code) => finish(code ?? EXIT.GENERAL))
    // answer the click quickly: once the link is in hand (or after a short wait) the page stops waiting
    await new Promise((done) => {
      const t = setTimeout(done, o.urlWaitMs ?? 6000)
      wake = () => { clearTimeout(t); done() }
    })
    return { ok: true, started: true, opened: !!state.opened }
  }

  /** +me -> { ok, aliases: [{ email, primary }] } (for the settings page to pick the pet's address) */
  async me () {
    const r = await this.run(['+me'], { timeoutMs: 20000 })
    if (r.code === -1) return { ok: false, code: 'not-installed' }
    if (isAuthFailure(r.code, r.stderr)) { this._enterAuth(); return { ok: false, code: 'auth-required' } }
    if (r.code !== 0) return { ok: false, code: 'failed' }
    const d = dataOf(parseJson(r.stdout)) || {}
    const aliases = (Array.isArray(d.aliases) ? d.aliases : []).map((a) => ({ email: String(a.email || ''), primary: !!a.is_primary })).filter((a) => a.email)
    return { ok: true, aliases }
  }

  // ------------------------------------------------------------------ send
  async send (to, subject, body, attachments = []) {
    if (!this.consent()) throw new MailError('consent', '还没允许桌宠通过这个邮箱自动发信')
    if (this.state === 'auth-required') throw new MailError('auth-required', '邮箱授权掉了，需要重新扫码授权')
    if (this.rateUntil > this.now()) throw new MailError('rate-limited', '被限频了，稍后再发', { retryAfterMs: this.rateUntil - this.now() })
    const q = this.quota()
    if (q.left <= 0) throw new MailError('daily-limit', '今天的外发额度用完了（' + this.dailyLimit + ' 封）')
    const tag = Date.now().toString(36) + randomBytes(3).toString('hex')
    const bodyName = 'body-' + tag + '.txt'
    mkdirSync(this.workDir, { recursive: true })
    writeFileSync(join(this.workDir, bodyName), String(body || ''), 'utf8')
    const made = [join(this.workDir, bodyName)]
    const args = ['message', '+send', '--to', String(to), '--subject', String(subject || '').replace(/\r?\n/g, ' ').slice(0, 200),
      '--body-file', bodyName, '--body-format', 'plain']
    for (const a of attachments.slice(0, 50)) {
      const rel = 'att-' + tag + '-' + basename(a)
      copyFileSync(a, join(this.workDir, rel)); made.push(join(this.workDir, rel))
      args.push('--attachment', rel)
    }
    args.push('--confirmed')
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await this.run(args)
        if (r.code === 0) {
          this.disk.sent = this.quota().used + 1; this._persist()
          const d = dataOf(parseJson(r.stdout)) || {}
          return { ref: String(d.message_id || d.id || (d.queued ? 'queued' : 'sent')) }
        }
        if (r.code === -1) throw new MailError('not-installed', '没找到 agently-cli')
        if (isAuthFailure(r.code, r.stderr + r.stdout)) { this._enterAuth(); throw new MailError('auth-required', '邮箱授权掉了，需要重新扫码授权') }
        if (r.code === EXIT.RATE) {
          const ms = parseRetryAfter(r.stderr + r.stdout) ?? 60000
          this.rateUntil = this.now() + ms
          throw new MailError('rate-limited', '被限频了，稍后再发', { retryAfterMs: ms })
        }
        if (r.code === EXIT.INVALID) throw new MailError('invalid', '这封信被拒了（参数或内容不合规）')
        if ((r.code === EXIT.GENERAL || r.code === EXIT.NETWORK) && attempt < 2) { await new Promise((ok) => setTimeout(ok, this.retryDelayMs)); continue }
        throw new MailError('failed', '发送失败（退出码 ' + r.code + '）')
      }
    } finally { for (const f of made) { try { unlinkSync(f) } catch {} } }
  }

  // ------------------------------------------------------------------ receive
  async watch (onMessage) {
    this.onMessage = onMessage
    this.stopped = false
    this._start(true)
    return () => this.stop()
  }

  stop () {
    this.stopped = true
    clearTimeout(this.timer); this.timer = null
    if (this.child) { try { this.child.kill() } catch {} this.child = null }
    if (this.login) { try { this.login.child.kill() } catch {} this.login = null }
    this._setState('disabled')
  }

  _start (initial, verified = false) {
    if (this.stopped) return
    // with the authorization gone there is nothing to watch: a stale restart timer must not spawn one
    if (this.state === 'auth-required' && !verified) return
    let child
    try { child = this._spawn(['message', '+watch', '--msg-format', 'full']) } catch (e) { return this._exited(-1, String(e && e.message || e)) }
    this.child = child
    // `verified` = a health() probe just proved the token works; the watcher is up, so this is really "connected"
    if (this.state !== 'auth-required' || verified) this._setState(initial || verified ? 'active' : 'degraded')
    const startedAt = this.now()
    // Anchor for every later gap-fill. A mailbox that never received a letter has no lastSeenAt, and without a
    // floor the letters that arrive while the watcher is down could never be looked up afterwards (2026-11-16).
    const hadAnchor = !!this.disk.lastSeenAt
    if (!hadAnchor) { this.disk.lastSeenAt = new Date(startedAt).toISOString(); this._persist() }
    let err = ''
    let gone = false
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const j = parseJson(line)
      if (!j) return
      this.attempt = 0
      this._setState('active')
      this._emit(mapAgentlyMessage(j))
    })
    child.stderr.on('data', (b) => { err = (err + b).slice(-4000) })
    const end = (code) => {
      if (gone) return
      gone = true
      if (this.child === child) this.child = null
      if (this.now() - startedAt > 60000) this.attempt = 0
      this._exited(code, err)
    }
    child.on('error', (e) => end(e && e.code === 'ENOENT' ? -1 : EXIT.GENERAL))
    child.on('close', (code) => end(code ?? EXIT.GENERAL))
    // the process is up: anything that arrived while no watcher was running is picked up once
    if (hadAnchor) this._backfill().catch(() => {})
  }

  _exited (code, err) {
    if (this.stopped) return
    if (isAuthFailure(code, err)) {
      clearTimeout(this.timer); this.timer = null               // drop any pending restart: no watch without a token
      this._enterAuth()                                         // then slow-probe until a re-auth
      return
    }
    let delay
    if (code === EXIT.RATE) { delay = parseRetryAfter(err) ?? 60000; this.rateUntil = this.now() + delay } else {
      delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)]
      this.attempt++
    }
    if (code === -1) this._setState('unconfigured'); else this._setState('degraded')
    this.restarts++
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this._start(false) }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /** Where a gap-fill starts: never later than the moment the watcher lost its authorization. */
  _anchor () {
    const seen = this.disk.lastSeenAt
    const dropped = this.droppedAt
    if (seen && dropped) return seen < dropped ? seen : dropped
    return seen || dropped || ''
  }

  /**
   * Pull everything that arrived while no watcher was running.
   * `message +list` pages with --cursor (a page holds at most 50), so this walks the pages until one comes back
   * short or the 200-letter budget is spent; whatever is left over is reported in backfillInfo.truncated so the
   * settings page can say so out loud instead of pretending the gap is closed.
   * Letters deleted in the mailbox window stay gone: the InboxStore keeps their keys and drops the duplicates.
   */
  async _backfill () {
    const after = this._anchor()
    if (!after) return 0
    const rows = []
    let cursor = ''
    let more = false
    for (let page = 0; page < this.backfillPages; page++) {
      const args = ['message', '+list', '--dir', 'inbox', '--after', after, '--limit', String(this.backfillPage)]
      if (cursor) args.push('--cursor', cursor)
      const r = await this.run(args)
      if (r.code === -1) break
      if (isAuthFailure(r.code, r.stderr + r.stdout)) { this._enterAuth(); return 0 }
      if (r.code !== 0) break
      const j = parseJson(r.stdout)
      const got = listOf(j)
      for (const row of got) rows.push(row)
      const pag = (dataOf(j) || {}).pagination || {}
      const next = String(pag.next_cursor || '')
      more = !!pag.has_more && !!next && next !== cursor
      cursor = next
      if (!more || rows.length >= this.backfillMax) break
    }
    // newest first, so a budget cut always drops the oldest letters — those are the ones we then report as missed
    const newestFirst = rows.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    const picked = newestFirst.slice(0, this.backfillMax)
    const truncated = more || newestFirst.length > picked.length
    let n = 0
    for (const row of picked.reverse()) {
      const id = String(row.message_id || row.id || '')
      if (!id || this.seen.has(id)) continue
      let full = row
      if (row.body === undefined) {
        const rr = await this.run(['message', '+read', '--id', id])
        if (rr.code !== 0) continue
        const d = dataOf(parseJson(rr.stdout))
        full = (d && d.message) || d || row
      }
      this._emit(mapAgentlyMessage(full)); n++
    }
    // 「还有更早的信没补收」要跨重启留着，否则重载一次就又不吭声了
    if (truncated !== !!this.disk.backfillTruncated) { this.disk.backfillTruncated = truncated; this._persist() }
    this.backfillInfo = { at: new Date(this.now()).toISOString(), fetched: rows.length, added: n, truncated }
    return n
  }

  _emit (m) {
    if (!m.id || this.seen.has(m.id)) return
    this.seen.add(m.id)
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000))
    if (m.createdAt > (this.disk.lastSeenAt || '')) { this.disk.lastSeenAt = m.createdAt; this._persist() }
    try { const p = this.onMessage && this.onMessage(m); if (p && p.catch) p.catch(() => {}) } catch {}
  }

  /** Last gap-fill result for the settings page; the truncation flag survives a reload (state.json). */
  get backfillState () {
    if (this.backfillInfo) return this.backfillInfo
    return this.disk.backfillTruncated ? { at: '', fetched: 0, added: 0, truncated: true } : null
  }

  async fetchAttachment (msgId, attId) {
    const out = 'att-' + String(msgId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    const r = await this.run(['attachment', '+download', '--msg', String(msgId), '--att', String(attId), '--output', out])
    if (isAuthFailure(r.code, r.stderr)) { this._enterAuth(); throw new MailError('auth-required', '邮箱授权掉了') }
    if (r.code !== 0) throw new MailError('failed', '下载附件失败（退出码 ' + r.code + '）')
    const d = dataOf(parseJson(r.stdout)) || {}
    const saved = String(d.saved_to || d.path || '')
    if (!saved) throw new MailError('failed', '下载附件没有返回路径')
    const p = resolve(this.workDir, saved)
    if (!p.startsWith(resolve(this.workDir) + sep)) throw new MailError('failed', '附件路径越界')
    return p
  }
}
