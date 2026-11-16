/**
 * Mail service: InboxStore (truth) + LocalFileBackend (always) + AgentlyBackend (optional) + session relay.
 *
 *   user writes (mailbox window / drop folder / own e-mail via Agently)
 *     -> store.addIn -> relay.ask(pointed session) -> reply lands as a letter (store.addOut)
 *   pet writes (pixelpet_mail_send) -> store.addOut -> optional copy out through Agently to the user's address
 *
 * The pet only reads <data>/mailbox/state.json (unread count) to raise its flag.
 */
import { join } from 'node:path'
import { InboxStore } from './inbox.js'
import { AgentlyBackend, LocalFileBackend, MAILBOX_OPS, MailError } from './mail-backend.js'
import { commitAttachments, dropStaging, findAttachment, planAttachments, purgeLetterFiles, stageAttachments } from './mail-files.js'

export const EMAIL_RE = /^[^\s@<>"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
export const DEFAULT_MAIL = { agently: { enabled: false, command: '', to: '', address: '', consentAt: '' } }

export function sanitizeMail (cur, patch) {
  const a = { ...DEFAULT_MAIL.agently, ...((cur && cur.agently) || {}) }
  const p = patch && typeof patch === 'object' && patch.agently && typeof patch.agently === 'object' ? patch.agently : {}
  if (typeof p.enabled === 'boolean') a.enabled = p.enabled
  if (typeof p.command === 'string' && p.command.length <= 400 && !/[\r\n"]/.test(p.command)) a.command = p.command.trim()
  for (const k of ['to', 'address']) if (typeof p[k] === 'string' && (p[k] === '' || EMAIL_RE.test(p[k].trim()))) a[k] = p[k].trim()
  if (p.consent === true) a.consentAt = new Date().toISOString()
  if (p.consent === false) a.consentAt = ''
  if (!a.consentAt) a.enabled = false          // no explicit consent, no automatic sending / receiving
  return { agently: a }
}

/** Prompt that goes into the pointed session for one message the user wrote. */
export function relayPrompt (item) {
  const head = item.via === 'agently' ? '[桌宠信箱] 用户用邮箱给你写了一封信' : '[桌宠信箱] 用户在信箱里给你写了一封信'
  const subj = item.subject ? '\n主题：' + item.subject : ''
  const att = item.attachments && item.attachments.length ? '\n附件：' + item.attachments.map((a) => a.filename).join('、') : ''
  return head + subj + att + '\n\n' + (item.body || '（只有附件）') +
    '\n\n——\n直接用文字回复就好：你的回复会作为一封回信放进桌宠信箱，不用再调用 pixelpet_mail_send。' +
    (item.id ? '\n这封信的 id：' + item.id + '。想表达感受就用 pixelpet_mail_like 给它留个反应（heart 红心 / happy 开心 / hug 抱抱 / sad 难过 / shock 震惊 / angry 生气 / dislike 差评），信上会出现对应的小图标。' : '')
}

export class MailService {
  /**
   * @param {{ dataDir: string, relay: { ask: Function }, settings: () => any, logger?: any,
   *           agentlyFactory?: (opts) => AgentlyBackend, localOpts?: object, onChange?: (stats) => void,
   *           onAuthLost?: () => void,                     once per drop: the pet should say something
   *           onAddress?: (email: string) => void,         first successful start fills an empty address
   *           openUrl?: (url: string) => boolean,          system browser for the re-auth link
   *           snapshot?: (o: { html: string, files: Array, item: object }) => Promise<{ path: string, cleanup?: Function } | null> }} o
   */
  constructor (o) {
    this.dir = join(o.dataDir, 'mailbox')
    this.relay = o.relay
    this.settings = o.settings
    this.logger = o.logger
    this.store = new InboxStore(this.dir, { onChange: o.onChange })
    this.local = new LocalFileBackend(this.dir, o.localOpts)
    this.snapshot = typeof o.snapshot === 'function' ? o.snapshot : null
    this.agentlyFactory = o.agentlyFactory || ((opts) => new AgentlyBackend(opts))
    this.onAuthLost = typeof o.onAuthLost === 'function' ? o.onAuthLost : null
    this.onAddress = typeof o.onAddress === 'function' ? o.onAddress : null
    this.openUrl = typeof o.openUrl === 'function' ? o.openUrl : null
    this.agently = null
    this._agentlySig = ''
    this._addrTried = false
    this._stops = []
    this._queue = Promise.resolve()
    this._started = false
  }

  mailCfg () { const s = this.settings(); return (s && s.mail && s.mail.agently) || DEFAULT_MAIL.agently }
  sessionId () { const s = this.settings(); return (s && s.voice && s.voice.llm && s.voice.llm.sessionId) || '' }

  async start () {
    if (this._started) return
    this._started = true
    this._stops.push(await this.local.watch((m) => this.receive(m, 'local')))
    await this.syncAgently()
    // anything still queued from a previous run (host restarted mid-way) goes out again
    for (const it of this.store.list({ dir: 'in', limit: 50 }).reverse()) if (it.status === 'queued') this.deliver(it.id)
  }

  stop () {
    for (const s of this._stops.splice(0)) { try { s() } catch {} }
    if (this.agently) { this.agently.stop(); this.agently = null }
    this._agentlySig = ''
    this._started = false
  }

  /** Bring the Agently watcher in line with settings (call after every settings save). */
  async syncAgently () {
    const a = this.mailCfg()
    // M6: the watcher is its own `agently-cli +watch` process tree (cmd + conhost + node, ~45 MB).
    // It only earns that when the mailbox furniture is actually placed AND Agently is configured.
    const want = !!(a.enabled && a.consentAt && this.mailboxOn())
    const sig = want ? JSON.stringify([a.command, a.consentAt]) : ''
    if (sig === this._agentlySig) return
    this._agentlySig = sig
    if (this.agently) { this.agently.stop(); this.agently = null }
    if (!sig) return
    this._addrTried = false
    this.agently = this.agentlyFactory({
      workDir: join(this.dir, 'agently-work'), command: a.command || undefined, logger: this.logger,
      openUrl: this.openUrl || undefined,
      onState: (s) => this._onAgentlyState(s),
      consent: () => !!this.mailCfg().consentAt && this.mailCfg().enabled && this.mailboxOn(),
    })
    await this.agently.watch((m) => this.receive(m, 'agently'))
  }

  /**
   * The backend reports every real state change once. Two things hang off it:
   *  - the pet says one short line when the authorization is lost (a whole night of silence otherwise);
   *  - an empty `address` is filled from +me the first time a watcher really runs.
   */
  _onAgentlyState (s) {
    if (s === 'auth-required') {
      if (this.onAuthLost) { try { this.onAuthLost() } catch {} }
      return
    }
    if (s === 'active' && !this._addrTried) {
      this._addrTried = true
      this._fillAddress().catch(() => {})
    }
  }

  /** Only ever when the user never filled it in; never overwrites a typed address. */
  async _fillAddress () {
    if (!this.onAddress || !this.agently) return undefined
    if (String(this.mailCfg().address || '').trim()) return undefined
    const me = await this.agently.me()
    if (!me.ok || !me.aliases.length) return undefined
    const pick = me.aliases.find((x) => x.primary) || me.aliases[0]
    if (!pick || !pick.email) return undefined
    if (String(this.mailCfg().address || '').trim()) return undefined   // still empty? (a save may have raced us)
    try { this.onAddress(pick.email) } catch {}
    return pick.email
  }

  /** Settings page 「重新授权」: hand the user's own `auth login` link to the browser. */
  async reauth (o) {
    if (!this.agently) return { ok: false, code: 'disabled' }
    return this.agently.reauth(o)
  }

  /** Is the mailbox furniture on? The pack ships enabled, so only an explicit false turns it off. */
  mailboxOn () {
    const s = this.settings() || {}
    const f = (s.furniture || {}).mailbox
    return !(f && f.enabled === false)
  }

  agentlyStatus () {
    const a = this.mailCfg()
    if (!a.enabled || !this.agently) return { enabled: false, state: 'disabled' }
    return { enabled: true, state: this.agently.state, quota: this.agently.quota(), backfill: this.agently.backfillState || null }
  }

  /** backend Message -> store (idempotent) -> relay */
  async receive (m, via) {
    const { item, created } = this.store.addIn({
      body: m.body, subject: m.subject, from: m.from && m.from.email ? m.from : undefined, via,
      key: via + ':' + m.id, createdAt: m.createdAt, html: m.html, footer: m.footer, quoted: m.quoted,
      attachments: (m.attachments || []).map((x) => ({ id: x.id, filename: x.filename, size: x.size })),
    })
    if (created) this.deliver(item.id)
    return item
  }

  /** user wrote in the mailbox window */
  write (body, key) {
    const { item, created } = this.store.addIn({ body, via: 'window', key: key ? 'window:' + key : undefined })
    if (created) this.deliver(item.id)
    return item
  }

  retry (id) {
    const it = this.store.get(id)
    if (!it || it.dir !== 'in' || it.status !== 'failed') return null
    this.store.update(id, { status: 'queued', error: undefined })
    this.deliver(id)
    return this.store.get(id)
  }

  /**
   * Mailbox housekeeping. Always applied to the InboxStore; mirrored upstream only where the active backend
   * says so in capabilities().remoteOps (none do today). -> { ok, changed, scope: 'local', item?, stats }
   *   star  { id, on? }   delete { ids }   clear { keepStarred? = true }   read { ids | all }
   */
  manage (op, a = {}) {
    if (!MAILBOX_OPS.includes(op)) return { ok: false, code: 'bad-op' }
    const s = this.store
    let changed = 0; let item
    if (op === 'star') {
      item = typeof a.id === 'string' ? s.star(a.id, typeof a.on === 'boolean' ? a.on : undefined) : null
      if (!item) return { ok: false, code: 'not-found' }
      changed = 1
    } else if (op === 'delete') {
      const removed = s.removeItems(Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string').slice(0, 400) : [])
      purgeLetterFiles(this.dir, removed.map((x) => x.id))   // each letter owns files/<its id>/, nothing is shared
      changed = removed.length
    } else if (op === 'clear') {
      const removed = s.clearItems({ keepStarred: a.keepStarred !== false })
      purgeLetterFiles(this.dir, removed.map((x) => x.id))
      changed = removed.length
    } else {
      changed = s.markRead(a.all === true ? 'all' : Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string').slice(0, 400) : [])
    }
    return { ok: true, changed, scope: 'local', ...(item ? { item } : {}), stats: s.stats() }
  }

  /** Serialised: the relay takes one question per session at a time. */
  deliver (id) {
    const run = async () => {
      const it = this.store.get(id)
      if (!it || it.status !== 'queued') return
      const sid = this.sessionId()
      if (!sid) { this.store.update(id, { status: 'failed', error: 'no-session' }); return }
      this.store.update(id, { status: 'delivered', aiSeen: true, sessionId: sid })
      let r
      try { r = await this.relay.ask(sid, relayPrompt(it), undefined, { source: 'mail' }) } catch (e) { r = { code: 500, body: { ok: false, message: String(e && e.message || e) } } }
      if (r && r.code === 200 && r.body && r.body.ok && String(r.body.reply || '').trim()) {
        const { item: letter } = this.store.addOut({ subject: it.subject ? '回复：' + it.subject : '', body: r.body.reply, source: 'reply', replyTo: it.id, key: 'reply:' + it.id })
        this.store.update(id, { status: 'replied', replyId: letter.id })
        if (it.via === 'agently') this.mirrorOut(letter).catch(() => {})
      } else {
        const code = r && r.code
        this.store.update(id, { status: 'failed', error: code === 404 ? 'offline' : code === 504 ? 'timeout' : code === 409 ? 'busy' : r && r.code === 200 ? 'empty' : 'failed' })
      }
    }
    this._queue = this._queue.then(run, run)
    return this._queue
  }

  /**
   * pet -> user. attachments: host file paths (validated here, copied into mailbox/files/<letter id>/).
   * -> { item, ext?, errors?, duplicate? }  · errors != [] means nothing was written.
   */
  async sendOut ({ subject, body, key, attachments }) {
    const k = key ? String(key).slice(0, 200) : ''
    // a retry with the same key answers with the letter already there — before touching any path
    if (k) {
      const hit = this.store.byKey('tool:' + k)
      if (hit) return { item: hit, ext: hit.ext, duplicate: true, archived: !!hit.archived }
    }
    const plan = planAttachments(attachments)
    if (plan.errors.length) {
      const e = new MailError('attachment', plan.errors[0])
      e.errors = plan.errors
      throw e
    }
    if (k) {
      const hit = this.store.byKey('tool:' + k)
      if (hit) return { item: hit, ext: hit.ext, duplicate: true, archived: !!hit.archived }
    }
    let staging = null
    if (plan.files.length) {
      try { staging = stageAttachments(this.dir, plan.files) } catch (e) {
        throw new MailError('attachment', '附件复制失败：' + String(e && e.message || e).slice(0, 120))
      }
    }
    let made; let publishedId = null
    try {
      made = this.store.addOut({ subject, body, source: 'tool', key: k ? 'tool:' + k : undefined,
        prepare: staging ? (item) => {
          try { item.attachments = commitAttachments(this.dir, staging, item.id) } catch {
            throw new MailError('attachment', '附件没能放进信箱，请检查本地目录')
          }
          publishedId = item.id
        } : undefined,
      })
    } catch (e) {
      dropStaging(staging)
      if (publishedId) purgeLetterFiles(this.dir, [publishedId])
      throw e
    }
    if (!made.created) { dropStaging(staging); return { item: made.item, ext: made.item.ext, duplicate: true, archived: !!made.item.archived } }
    const ext = await this.mirrorOut(this.store.get(made.item.id) || made.item)
    return { item: this.store.get(made.item.id) || made.item, ext }
  }

  /** [absolute path] of the letter's own attachments (never a request-supplied path) */
  attachmentPaths (item) {
    const out = []
    for (const a of (item && item.attachments) || []) {
      const hit = findAttachment(this.dir, item, a && a.id)
      if (hit) out.push({ path: hit.file, kind: hit.att.kind, filename: hit.att.filename })
    }
    return out
  }

  /** copy one letter out through Agently, if on. Result is recorded on the item. */
  async mirrorOut (item) {
    const a = this.mailCfg()
    if (!a.enabled || !a.consentAt || !this.agently || !this.mailboxOn()) return undefined
    if (!a.to) { const ext = { ok: false, code: 'no-address' }; this.store.update(item.id, { ext }); return ext }
    const files = this.attachmentPaths(item)
    const shots = []
    let ext
    try {
      if (files.length !== (item.attachments || []).length) throw new MailError('attachment', '信件附件缺失，已停止外发')
      for (const html of files.filter((f) => f.kind === 'html')) {
        if (!this.snapshot) throw new MailError('screenshot', '没有可用的本机渲染器，贺卡截图生成不了')
        const shot = await this.snapshot({ html: html.path, files, item })
        if (!shot || !shot.path) throw new MailError('screenshot', '贺卡截图生成不了')
        shots.push(shot)
      }
      const r = await this.agently.send(a.to, item.subject || '来自桌宠的信', item.body,
        [...files.map((f) => f.path), ...shots.map((f) => f.path)])
      ext = { ok: true, ref: r.ref, at: new Date().toISOString(), ...(shots.length ? { screenshot: true, screenshotCount: shots.length } : {}) }
    } catch (e) {
      ext = { ok: false, code: e instanceof MailError ? e.code : 'failed', message: String(e && e.message || e).slice(0, 160) }
    } finally {
      for (const shot of shots) if (typeof shot.cleanup === 'function') { try { shot.cleanup() } catch {} }
    }
    this.store.update(item.id, { ext })
    return ext
  }
}
