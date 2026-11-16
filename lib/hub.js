/**
 * Hub bar, host side: its settings, and screenshots the pet attaches to a message.
 *
 * Flow: the pet POSTs each screenshot (raw PNG/JPEG bytes) to /api/shot with its per-launch key. The
 * host keeps it as <data>/tmp/shot-<hex>.<ext> and returns the id. The next /api/ask names those ids;
 * the host turns them into image blocks, lets DSH's `attachments` service admit them
 * (admitPromptContent -> blocks that reference stored attachments), hands the content to
 * agent.followup and deletes the temp files whatever happens. Stale files are swept.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_HUB = { show: true, autoCollapseS: 20, speak: true }
export const SHOT_LIMIT = 8 * 1024 * 1024
export const SHOT_MAX_PENDING = 8
export const SHOT_MAX_PER_MESSAGE = 4
export const SHOT_TTL_MS = 15 * 60_000
const SHOT_ID = /^shot-[0-9a-f]{16}$/
const TYPES = { png: 'image/png', jpg: 'image/jpeg' }

/** Whitelisted: retired keys (handsFree, now a runtime switch on the bar) are dropped without complaint. */
export function sanitizeHub (cur, patch) {
  const base = { ...DEFAULT_HUB, ...(cur && typeof cur === 'object' ? cur : {}) }
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = { ...base }
  for (const k of ['show', 'speak']) {
    if (typeof p[k] === 'boolean') out[k] = p[k]
    if (typeof out[k] !== 'boolean') out[k] = DEFAULT_HUB[k]
  }
  if ('autoCollapseS' in p) out.autoCollapseS = p.autoCollapseS
  const n = Number(out.autoCollapseS)
  out.autoCollapseS = Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.round(n) : DEFAULT_HUB.autoCollapseS
  return { show: out.show, autoCollapseS: out.autoCollapseS, speak: out.speak }
}

/** 'png' | 'jpg' | null from magic bytes */
export function imageKind (buf) {
  if (!buf || buf.length < 8) return null
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  return null
}

export function createShotStore (dataDir, { now = () => Date.now() } = {}) {
  const dir = join(dataDir, 'tmp')
  const files = () => { try { return readdirSync(dir).filter((n) => /^shot-[0-9a-f]{16}\.(png|jpg)$/.test(n)) } catch { return [] } }
  const pathOf = (id) => {
    if (!SHOT_ID.test(String(id))) return null
    const hit = files().find((n) => n.startsWith(id + '.'))
    return hit ? join(dir, hit) : null
  }
  const sweep = (maxAgeMs = SHOT_TTL_MS) => {
    let removed = 0
    for (const n of files()) {
      try { if (now() - statSync(join(dir, n)).mtimeMs >= maxAgeMs) { rmSync(join(dir, n), { force: true }); removed++ } } catch {}
    }
    return removed
  }
  /** -> { code, body } */
  const save = (buf) => {
    const kind = imageKind(buf)
    if (!kind) return { code: 415, body: { ok: false, message: 'not an image' } }
    if (buf.length > SHOT_LIMIT) return { code: 413, body: { ok: false, message: 'too large' } }
    sweep()
    if (files().length >= SHOT_MAX_PENDING) return { code: 429, body: { ok: false, message: 'too many' } }
    mkdirSync(dir, { recursive: true })
    const id = 'shot-' + randomBytes(8).toString('hex')
    writeFileSync(join(dir, id + '.' + kind), buf)
    return { code: 200, body: { ok: true, id } }
  }
  /** ids -> image blocks ({ type, data, mediaType, name }); unknown ids skipped. Files stay until drop(). */
  const blocks = (ids) => {
    const out = []
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, SHOT_MAX_PER_MESSAGE)) {
      const p = pathOf(id)
      if (!p) continue
      const ext = p.endsWith('.jpg') ? 'jpg' : 'png'
      try { out.push({ type: 'image', data: readFileSync(p).toString('base64'), mediaType: TYPES[ext], name: id + '.' + ext }) } catch {}
    }
    return out
  }
  const drop = (ids) => { for (const id of (Array.isArray(ids) ? ids : [])) { const p = pathOf(id); if (p) rmSync(p, { force: true }) } }
  const clear = () => { for (const n of files()) rmSync(join(dir, n), { force: true }) }
  return { dir, save, blocks, drop, sweep, clear, files }
}

/**
 * Text + image blocks -> followup content. Images go through DSH's attachments service; without it
 * (or when it refuses) the message goes as text only and `dropped` says how many images were lost.
 */
export async function buildContent (ctx, text, images) {
  const head = [{ type: 'text', text: text || '（截图）' }]
  if (!images.length) return { content: head, attached: 0, dropped: 0 }
  let svc = null
  try { svc = ctx.attachments || (ctx.get ? ctx.get('attachments') : null) } catch { svc = null }
  if (!svc || typeof svc.admitPromptContent !== 'function') return { content: head, attached: 0, dropped: images.length }
  try {
    const content = await svc.admitPromptContent(head.concat(images))
    const attached = (Array.isArray(content) ? content : []).filter((b) => b && b.type === 'image').length
    if (!Array.isArray(content) || !attached) return { content: head, attached: 0, dropped: images.length }
    return { content, attached, dropped: images.length - attached }
  } catch {
    return { content: head, attached: 0, dropped: images.length }
  }
}
