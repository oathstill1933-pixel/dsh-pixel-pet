/**
 * InboxStore — the local source of truth for the mailbox. Every backend (local drop folder, Agently Mail)
 * lands here first; cloud channels are only transport.
 *
 * <data>/mailbox/inbox.json      { v: 1, items: [...], keys: [...] }   (atomic tmp + rename)
 * <data>/mailbox/state.json      { unread, total, latestUnreadAt, pendingIn }  small summary the pet polls
 * <data>/mailbox/archive-YYYYMM.jsonl   settled items pushed out when the live list is over its cap
 *
 * Item, direction "out" (pet -> user):
 *   { id, dir: 'out', subject, body (markdown), createdAt, read, source, replyTo?, ext? }
 * Item, direction "in" (user -> pet):
 *   { id, dir: 'in', body, createdAt, status: queued|delivered|replied|failed, via, subject?, from?, error?,
 *     replyId?, aiSeen, html?, footer?, quoted?, attachments? }
 *
 * Either direction may carry `starred: true` (the user's heart, local only, never sent anywhere)
 * and `liked: true` (the AI's own like, set through pixelpet_mail_like).
 *
 * `key` makes an add idempotent (same key -> the existing item comes back, nothing is written). Deleting an item
 * keeps its key, so a backend that re-delivers the same message (Agently backfill) cannot bring it back.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const IN_STATUS = ['queued', 'delivered', 'replied', 'failed']
/** AI 对信件的表情反应：heart 为默认，其余依次对应前端图标。 */
export const REACTIONS = ['heart', 'happy', 'hug', 'sad', 'shock', 'angry', 'dislike']
export const LIMITS = { subject: 200, body: 20000, items: 400, keys: 4000, key: 200 }

const nowIso = () => new Date().toISOString()
const newId = (dir) => (dir === 'out' ? 'o-' : 'i-') + Date.now().toString(36) + randomBytes(4).toString('hex')
const clip = (v, n) => String(v ?? '').slice(0, n)

export class InboxStore {
  /** @param {string} dir  <data>/mailbox  @param {{ maxItems?: number, now?: () => string, onChange?: (stats) => void }} o */
  constructor (dir, o = {}) {
    this.dir = dir
    this.file = join(dir, 'inbox.json')
    this.stateFile = join(dir, 'state.json')
    this.maxItems = o.maxItems || LIMITS.items
    this.now = o.now || nowIso
    this.onChange = o.onChange || null
    this.data = null
  }

  load () {
    if (this.data) return this.data
    let d = null
    if (existsSync(this.file)) {
      try {
        d = JSON.parse(readFileSync(this.file, 'utf8'))
        if (!d || !Array.isArray(d.items)) throw new Error('shape')
      } catch {
        // never overwrite a file we cannot read: set it aside and start clean
        try { renameSync(this.file, this.file + '.corrupt-' + Date.now()) } catch {}
        d = null
      }
    }
    this.data = { v: 1, items: d ? d.items : [], keys: d && Array.isArray(d.keys) ? d.keys : [] }
    return this.data
  }

  save () {
    mkdirSync(this.dir, { recursive: true })
    const d = this.load()
    const tmp = this.file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(d), 'utf8')
    renameSync(tmp, this.file)          // the inbox file is the truth: a failure here is a real failure
    const st = this.stats()
    try {
      const t2 = this.stateFile + '.' + process.pid + '.tmp'
      writeFileSync(t2, JSON.stringify(st), 'utf8')
      renameSync(t2, this.stateFile)
    } catch {
      // state.json is only the summary the pet polls; the letter above is already committed and kept
    }
    if (this.onChange) { try { this.onChange(st) } catch {} }
    return st
  }

  byKey (key) {
    if (!key) return null
    const d = this.load()
    return d.items.find((x) => x.key === key) || (d.keys.includes(key) ? { archived: true, key } : null)
  }

  _add (item, key, prepare) {
    const d = this.load()
    const itemsBefore = d.items.slice()
    const keysBefore = d.keys.slice()
    try {
      if (key) {
        const hit = this.byKey(key)
        if (hit) return { item: hit, created: false }
      }
      // Publish this fresh item's owned resources before the one authoritative inbox commit.
      if (typeof prepare === 'function') prepare(item)
      if (key) {
        item.key = key
        d.keys.push(key)
        if (d.keys.length > LIMITS.keys) d.keys.splice(0, d.keys.length - LIMITS.keys)
      }
      d.items.push(item)
      this._archive()
      this.save()
    } catch (e) {
      // a commit that did not reach disk must not leave a phantom letter or eat the idempotency key
      d.items = itemsBefore
      d.keys = keysBefore
      throw e
    }
    return { item, created: true }
  }

  /** pet -> user letter */
  addOut ({ subject, body, source = 'tool', replyTo, key, createdAt, prepare } = {}) {
    const text = clip(body, LIMITS.body).trim()
    if (!text) throw new TypeError('body 不能为空')
    const item = {
      id: newId('out'), dir: 'out', subject: clip(subject, LIMITS.subject).trim(), body: text,
      createdAt: createdAt || this.now(), read: false, source: clip(source, 20),
    }
    if (replyTo) item.replyTo = String(replyTo)
    return this._add(item, key ? clip(key, LIMITS.key) : undefined, prepare)
  }

  /** user -> pet message */
  addIn ({ body, via = 'window', subject, from, key, createdAt, html, footer, quoted, attachments } = {}) {
    const text = clip(body, LIMITS.body).trim()
    if (!text && !(Array.isArray(attachments) && attachments.length)) throw new TypeError('body 不能为空')
    const item = {
      id: newId('in'), dir: 'in', body: text, createdAt: createdAt || this.now(), status: 'queued',
      via: clip(via, 20), aiSeen: false,
    }
    if (subject) item.subject = clip(subject, LIMITS.subject)
    if (from && typeof from === 'object' && from.email) item.from = { email: clip(from.email, 200), ...(from.name ? { name: clip(from.name, 100) } : {}) }
    if (html) item.html = String(html)            // original HTML kept verbatim (compliance footer included)
    if (footer) item.footer = clip(footer, 2000)
    if (quoted) item.quoted = clip(quoted, LIMITS.body)
    if (Array.isArray(attachments) && attachments.length) item.attachments = attachments.slice(0, 50)
    return this._add(item, key ? clip(key, LIMITS.key) : undefined)
  }

  get (id) { return this.load().items.find((x) => x.id === id) || null }

  update (id, patch) {
    const it = this.get(id)
    if (!it) return null
    if (patch.status !== undefined && !IN_STATUS.includes(patch.status)) throw new TypeError('bad status')
    for (const [k, v] of Object.entries(patch)) {
      if (['id', 'dir', 'key', 'createdAt'].includes(k)) continue
      if (v === undefined) delete it[k]; else it[k] = v
    }
    this.save()
    return it
  }

  /** ids: string[] | 'all'. Only "out" items carry read. -> changed count */
  markRead (ids) {
    const want = ids === 'all' ? null : new Set(Array.isArray(ids) ? ids : [])
    let n = 0
    for (const it of this.load().items) {
      if (it.dir === 'out' && !it.read && (!want || want.has(it.id))) { it.read = true; n++ }
    }
    if (n) this.save()
    return n
  }

  /** -> the item, or null. on: true | false | undefined (toggle) */
  star (id, on) {
    const it = this.get(id)
    if (!it) return null
    const want = on === undefined ? !it.starred : !!on
    if (!!it.starred !== want) { if (want) it.starred = true; else delete it.starred; this.save() }
    return it
  }

  /** The AI's own reaction on a message / letter it is fond of. -> the item, or null.
   *  on: true | false | undefined (toggle); reaction: one of REACTIONS (default heart).
   *  从单一「点赞」扩成一组表情，保留 liked 布尔以兼容旧数据。 */
  like (id, on, reaction) {
    const it = this.get(id)
    if (!it) return null
    const want = on === undefined ? !it.liked : !!on
    const r = REACTIONS.includes(reaction) ? reaction : 'heart'
    if (want) {
      it.liked = true
      if (r === 'heart') delete it.reaction; else it.reaction = r
      this.save()
    } else if (it.liked) {
      delete it.liked; delete it.reaction; this.save()
    }
    return it
  }

  /** ids: string[] -> removed count. Keys stay in `keys` so re-deliveries stay out. */
  remove (ids) { return this.removeItems(ids).length }

  /** same as remove(), but the removed items come back (the caller has to drop their attachment files) */
  removeItems (ids) {
    const want = new Set(Array.isArray(ids) ? ids : [])
    const d = this.load()
    const removed = d.items.filter((x) => want.has(x.id))
    if (removed.length) { d.items = d.items.filter((x) => !want.has(x.id)); this.save() }
    return removed
  }

  /** Empty the live list. Starred items stay unless keepStarred === false. -> removed count */
  clear ({ keepStarred = true } = {}) { return this.clearItems({ keepStarred }).length }

  /** same as clear(), but the removed items come back */
  clearItems ({ keepStarred = true } = {}) {
    const d = this.load()
    const removed = keepStarred === false ? d.items.slice() : d.items.filter((x) => !x.starred)
    if (removed.length) { d.items = d.items.filter((x) => !removed.includes(x)); this.save() }
    return removed
  }

  markSeen (ids) {
    const want = new Set(ids)
    let n = 0
    for (const it of this.load().items) if (it.dir === 'in' && !it.aiSeen && want.has(it.id)) { it.aiSeen = true; n++ }
    if (n) this.save()
    return n
  }

  /** newest first. { dir?, limit?, before? (ISO), starred? } */
  list ({ dir, limit = 100, before, starred } = {}) {
    const lim = Math.max(1, Math.min(400, Math.floor(Number(limit) || 100)))
    return this.load().items
      .filter((x) => (!dir || x.dir === dir) && (!before || x.createdAt < before) && (!starred || x.starred))
      .slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, lim)
  }

  stats () {
    const items = this.load().items
    let unread = 0; let latest = null; let pendingIn = 0; let newForPet = 0; let starred = 0
    for (const it of items) {
      if (it.dir === 'out' && !it.read) { unread++; if (!latest || it.createdAt > latest) latest = it.createdAt }
      if (it.dir === 'in' && (it.status === 'queued' || it.status === 'delivered')) pendingIn++
      if (it.dir === 'in' && !it.aiSeen) newForPet++
      if (it.starred) starred++
    }
    return { unread, total: items.length, latestUnreadAt: latest, pendingIn, newForPet, starred }
  }

  /** Over the cap: push the oldest settled items (read letters, replied/failed messages) to a monthly JSONL. */
  _archive () {
    const d = this.data
    let over = d.items.length - this.maxItems
    if (over <= 0) return
    const settled = (x) => !x.starred && (x.dir === 'out' ? x.read : x.status === 'replied' || x.status === 'failed')
    const sorted = d.items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const drop = new Set()
    for (const x of sorted) { if (over <= 0) break; if (settled(x)) { drop.add(x); over-- } }
    // still over (everything unread / pending): the oldest settled-or-not go, but a starred letter never
    // leaves the live list (over the cap is fine; an inaccessible favorite is not)
    for (const x of sorted) { if (over <= 0) break; if (!drop.has(x) && !x.starred) { drop.add(x); over-- } }
    if (!drop.size) return
    mkdirSync(this.dir, { recursive: true })
    const byMonth = new Map()
    for (const x of drop) {
      const m = String(x.createdAt).slice(0, 7).replace('-', '') || 'unknown'
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push(JSON.stringify(x))
    }
    for (const [m, lines] of byMonth) appendFileSync(join(this.dir, 'archive-' + m + '.jsonl'), lines.join('\n') + '\n', 'utf8')
    // archived letters keep their text in the JSONL; their private attachment folder goes (never a starred one)
    for (const x of drop) if (x && !x.starred && x.attachments) { try { rmSync(join(this.dir, 'files', String(x.id)), { recursive: true, force: true }) } catch {} }
    d.items = d.items.filter((x) => !drop.has(x))
  }
}
