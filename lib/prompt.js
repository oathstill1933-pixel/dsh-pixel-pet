/**
 * The pet's usage prompt for the pointed session = base + one autonomy paragraph:
 *   base       settings.prompt ('' = prompts/default.md)
 *   paragraph  settings.autonomy.enabled !== false ? autonomy.proactivePrompt ('' = prompts/proactive.md)
 *                                                  : autonomy.passivePrompt   ('' = prompts/passive.md)
 *
 * Delivery, in order of preference:
 *   1. host: DSH's systemPrompt service. One global section whose text is a function of the assembly
 *      context — it renders only for the pointed session's agent (context.agent.session.id) and only while
 *      aiControl is on; every other session gets '' (empty sections are dropped). Nothing is sent twice
 *      because nothing is sent: the system prompt is rebuilt each step from the current settings.
 *   2. message: without that service, the prompt rides along with the first message the pet relays into a
 *      session, and again after it changes. <data>/prompt-sent.json keeps one version hash per session.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROMPT_MAX = 4000
export const SECTION_NAME = 'plugin:dsh-pixel-pet'
export const SECTION_ORDER = 9600 // after first-party tool guidance, before the harness-source suffix (10000)
const SENT_LIMIT = 200

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundled = (name) => { try { return clean(readFileSync(join(ROOT, 'prompts', name), 'utf8')) } catch { return '' } }
export const DEFAULT_PROMPT = bundled('default.md')
export const DEFAULT_PROACTIVE = bundled('proactive.md')
export const DEFAULT_PASSIVE = bundled('passive.md')
export const PART_MAX = 2000

function clean (v) {
  return String(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** stored value: '' means "the default"; anything else is the user's own text, cleaned and capped */
export function sanitizePrompt (v) {
  if (typeof v !== 'string') return ''
  const s = clean(v).slice(0, PROMPT_MAX).trim()
  return s === DEFAULT_PROMPT ? '' : s
}

/** an autonomy paragraph: '' = the bundled default for that slot */
export function sanitizePart (v, def) {
  if (typeof v !== 'string') return ''
  const s = clean(v).slice(0, PART_MAX).trim()
  return s === def ? '' : s
}

export const basePrompt = (settings) => (settings && typeof settings.prompt === 'string' && settings.prompt) || DEFAULT_PROMPT
export const autonomyOn = (settings) => !(settings && settings.autonomy && settings.autonomy.enabled === false)
export function autonomyPrompt (settings) {
  const a = (settings && settings.autonomy) || {}
  const own = autonomyOn(settings) ? a.proactivePrompt : a.passivePrompt
  return (typeof own === 'string' && own) || (autonomyOn(settings) ? DEFAULT_PROACTIVE : DEFAULT_PASSIVE)
}
/**
 * 身份行：把「TA 叫什么」和「怎么称呼用户」拼成一句话，压在提示词最前面。
 * 早先这两个值只在界面上用、不进任何提示词，现在改成进提示词——养 AI 的人未必知道怎么起头教它认人。
 */
export const identityLine = (settings) => {
  const name = String((settings && settings.partnerName) || '').trim()
  const as = String((settings && settings.addressAs) || '').trim()
  const parts = []
  if (name) parts.push('你叫「' + name + '」')
  if (as) parts.push('称呼用户为「' + as + '」')
  return parts.length ? parts.join('，') + '。' : ''
}
/** what the session actually gets；near = 「日历与日记」包的「近日」行（lib/calendar.js nearLine()，一天最多变一次） */
export const effectivePrompt = (settings, { near = '' } = {}) => [identityLine(settings), near, basePrompt(settings), autonomyPrompt(settings)].filter(Boolean).join('\n\n')
export const promptHash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
const sessionKey = (id) => { const s = String(id ?? '').trim(); return s.startsWith('session-') ? s.slice(8) : s }
/** user text cannot close our frame */
const frame = (text) => '<pixelpet-guide>\n' + text.replace(/<\/?pixelpet-guide>/gi, '') + '\n</pixelpet-guide>'

export function renderSection (text) { return text ? '# 桌面桌宠\n\n' + frame(text) : '' }
export function renderAttachment (text) { return '（桌宠插件的使用说明，只在首次或修改后附带一次）\n' + frame(text) }

/**
 * @param {{ ctx: any, dataDir: string, settings: () => any, logger?: any }} o
 * @returns {{ mode: 'system'|'message', decorate: (sessionId: string, content: any[]) => { content: any[], commit: () => void }, sectionText: (c: any) => string, dispose: () => void }}
 */
export function createPromptChannel ({ ctx, dataDir, settings, logger, note = null, near = null }) {
  const file = join(dataDir, 'prompt-sent.json')
  const active = () => { try { return settings().aiControl !== false } catch { return false } }
  const pointed = () => { try { return sessionKey(settings().voice.llm.sessionId) } catch { return '' } }
  const nearText = () => { try { return near ? String(near() || '') : '' } catch { return '' } }

  const sectionText = (c) => {
    try {
      const agent = c && c.agent
      const id = agent && ((agent.session && agent.session.id) || agent.id)
      if (!id || !active() || sessionKey(id) !== pointed() || !pointed()) return ''
      return renderSection(effectivePrompt(settings(), { near: nearText() }))
    } catch { return '' }
  }

  let mode = 'message'
  let off = null
  let sp = null
  try { sp = (ctx.get && ctx.get('systemPrompt')) || ctx.systemPrompt } catch { sp = null }
  if (sp && typeof sp.section === 'function') {
    try {
      off = sp.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: sectionText })
      mode = 'system'
    } catch (e) {
      logger?.warn?.('[dsh-pixel-pet] 系统提示注册失败，改为随消息附带：' + String(e && e.message || e).slice(0, 160))
    }
  }

  const readSent = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {} } catch { return {} } }
  const writeSent = (m) => {
    try {
      const keys = Object.keys(m)
      for (const k of keys.slice(0, Math.max(0, keys.length - SENT_LIMIT))) delete m[k]
      mkdirSync(dataDir, { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      writeFileSync(tmp, JSON.stringify(m), 'utf8')
      renameSync(tmp, file)
    } catch {}
  }

  /**
   * Every relayed message: + the activity note (lib/awareness.js; '' while 「允许感知在做什么」 is off).
   * Message mode only: + the prompt once per (session, version); commit() after the followup went out.
   */
  const decorate = (sessionId, content) => {
    const d = decoratePrompt(sessionId, content)
    let extra = ''
    try { extra = note ? String(note() || '') : '' } catch { extra = '' }
    if (!extra) return d
    return { content: [...(Array.isArray(d.content) ? d.content : []), { type: 'text', text: extra }], commit: d.commit }
  }

  const decoratePrompt = (sessionId, content) => {
    const none = { content, commit () {} }
    if (mode !== 'message' || !active()) return none
    const k = sessionKey(sessionId)
    const text = effectivePrompt(settings(), { near: nearText() })
    if (!k || !text) return none
    const h = promptHash(text)
    if (readSent()[k] === h) return none
    return {
      // after the user's own blocks: the message still reads as theirs, the guide is a trailing note
      content: [...(Array.isArray(content) ? content : []), { type: 'text', text: renderAttachment(text) }],
      commit () { const m = readSent(); delete m[k]; m[k] = h; writeSent(m) },
    }
  }

  const dispose = () => { if (typeof off === 'function') { try { off() } catch {} } off = null }
  return { get mode () { return mode }, decorate, sectionText, dispose }
}
