/**
 * dsh-pixel-pet host side.
 *
 * Routes under /dsh-pixel-pet (webServer prefix):
 *   GET  /                      settings page (web/)
 *   GET  /api/state             characters, furniture, settings, voices, deps, sessions, pet process
 *   GET  /api/thumb/:kind/:id   first idle frame of a pack (png)
 *   POST /api/settings          merge settings (whitelisted keys) -> <data>/settings.json
 *   POST /api/pet/start|stop    start / stop the Python pet (auto-resolved python, see lib/pyruntime.js)
 *   POST /api/python/prepare    (re)resolve Python, downloading the portable runtime when needed
 *   POST /api/deps/download     install / retry the voice components (same as /api/voice/install)
 *   GET  /api/voice/status      install progress (runtime/voice_cli.py writes <data>/models/progress.json)
 *   POST /api/voice/install     start or resume the background install (auto-started on first enable)
 *   POST /api/voice/clone       body = reference audio bytes, ?name=&text=
 *   POST /api/voice/delete      { id } remove one cloned voice
 *   POST /api/voice/test        { text? } synthesise with the current voice -> { wav } for GET /api/voice/wav/:name
 *   POST /api/stt               pet only (X-PixelPet-Key): 16 kHz wav -> DSH's own recogniser (ctx.speechToText)
 *   POST /api/ask               {sessionId, text} from the pet -> followup into that DSH session,
 *                               waits for turn/end, returns the assistant's text. Needs X-PixelPet-Key,
 *                               a random key generated per pet launch and handed to it via env.
 *                               Optional shots: ids from /api/shot, attached through DSH's attachments service.
 *   POST /api/shot              pet only (X-PixelPet-Key): raw PNG/JPEG (<= 8 MB) -> { id }, kept in <data>/tmp
 *                               until the next /api/ask sends it (then deleted; stale ones swept).
 *   GET  /create                "+ 新建角色" page (web/create.*)
 *   GET  /api/imagegen          image provider settings + key status (configured / source, never the value)
 *   POST /api/imagegen/key      { value } -> DSH credential store under settings.imagegen.keyRef ('' removes it)
 *   POST /api/imagegen/test     authenticated probe of the configured endpoint
 *   GET  /api/create/jobs | /api/create/spec | /api/create/:id | /api/create/:id/img/:slot[/:name]
 *   POST /api/create/new | :id/meta | :id/upload?slot=upload|ref (image body) | :id/candidates | :id/pick
 *        :id/run { confirm, keys? } | :id/stop | :id/import?name=<state>_<NN>.png (image body)
 *        :id/build | :id/install | :id/delete           (see lib/create.js)
 *   GET  /mailbox               mailbox window (web/mailbox.*), opened from the mailbox furniture or the settings page
 *   GET  /api/mail              ?limit=&before=  both directions newest first + stats + Agently state
 *   GET  /api/mail/unread       { unread, total, latestUnreadAt, pendingIn }
 *   POST /api/mail/read         { ids?: [], all?: true }   pet's letters -> read
 *   POST /api/mail/write        { body, key? }  user -> pet; relayed into the pointed session, reply lands as a letter
 *   POST /api/mail/retry        { id }          re-deliver a failed message
 *   POST /api/mail/star         { id, on? }     red heart (local only); GET /api/mail?starred=1 filters
 *                               (items may also carry liked: true — set by the AI through pixelpet_mail_like)
 *   GET /api/mail also returns owner: { name, domain }  (partnerName || character name; AI address domain)
 *   POST /api/mail/delete       { ids: [] }     local delete (never touches the real mailbox upstream)
 *   POST /api/mail/clear        { keepStarred? = true }
 *   GET  /api/mail/agently/guide          prompt for the user's own AI (official URL + commands only)
 *   POST /api/mail/agently/guide/send     same prompt -> followup into the pointed session
 *   POST /api/mail/agently/probe          auth status + aliases through the user's own agently-cli
 *
 *   GET  /api/prompt            the pet usage prompt (effective text, default, delivery mode) — see lib/prompt.js
 *   GET  /api/preview?id=       every state of a character for the "动作" grid; GET /api/frame/:id/:state/:n -> png
 *   POST /api/preview/play      { id?, state } -> pose / mood command to the running pet (lib/preview.js)
 *
 * AI tools (global, see lib/tools.js): pixelpet_move / pose / look / mood / say / furniture / stop / status / mail_send / mail_list / screen.
 * Registered while settings.aiControl is on; switching it off unregisters them. pixelpet_screen also needs settings.screen.
 * The usage prompt reaches the pointed session through DSH's systemPrompt service when present, else rides along once
 * with the first relayed message per session and version (lib/prompt.js).
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTools, sendCommand } from './tools.js'
import { createPackManager, PACK_LIMIT, incomingName } from './packmgr.js'
import { KIND_DIR, packFrame } from './packs.js'
import { compareVersions, loadPointer, permissionIds, resolveOne, snapshot as packSnapshot } from './packkit.js'
import { DEFAULT_PASSIVE, DEFAULT_PROACTIVE, DEFAULT_PROMPT, PART_MAX, PROMPT_MAX, autonomyOn, basePrompt, createPromptChannel, effectivePrompt, sanitizePrompt } from './prompt.js'
import { DEFAULT_AUTONOMY, sanitizeAutonomy } from './autonomy.js'
import { createRelay, RELAY_LIMITS } from './relay.js'
import { frameFile, loadCharacter, playCommand, previewOf } from './preview.js'
import { DEFAULT_MAIL, MailService, sanitizeMail } from './mail.js'
import { attachmentCsp, disposition, findAttachment, readMailFile } from './mail-files.js'
import { cardFrameDocument, cardFramePolicy } from './mail-card-frame.js'
import { createCardRenderer } from './mail-render.js'
import { buildAgentlyGuide } from './agently-guide.js'
import { DEFAULT_HUB, buildContent, createShotStore, sanitizeHub, SHOT_LIMIT } from './hub.js'
import { DEFAULT_IMAGEGEN, PROVIDERS as IMAGE_PROVIDERS, createImageClient, createKeyStore, sanitizeImagegen } from './imagegen.js'
import { CUSTOM_FRAMES_MAX, CUSTOM_MAX, DUR_RANGE, SPEC, createStudio } from './create.js'
import { createFurnitureStudio, furnitureRoutes } from './furniture-create.js'
import { DEFAULT_VOICE, createInstaller, depsStatus as voiceDeps, listVoices as voiceList, sanitizeVoice, transcribeWithDsh } from './voice.js'
import { createPythonManager } from './pyruntime.js'
import { openWindow, pagePath } from './open-window.js'
import { createActivityFollower } from './activity.js'
import { createAnimFollower } from './anim-follow.js'
import { createNotifier } from './notice.js'
import { createAwareness, renderNote } from './awareness.js'
import { createVoicePrintApi, sanitizeVoiceprint, VOICEPRINT_DEFAULT } from './voiceprint.js'
import { createBalance } from './balance.js'
import { createProactive } from './proactive.js'
import { createSessionGuard } from './session-guard.js'
import { dayBounds, todayKey } from './activity-day.js'
import { INSIGHT_DEFAULT, createQuotaSampler, quotaConfigured, quotaDay, sanitizeInsight } from './quota-log.js'
import { createPetActivity, petDay } from './pet-activity.js'
import { createCalendar, sanitizeCalendar, CALENDAR_DEFAULT } from './calendar.js'
import { createMusic, LISTEN_DEFAULT, sanitizeListen } from './music.js'
import { createMusicDaily } from './music-daily.js'
import { createPetMusic } from './music-pet.js'
import { createMusicTools } from './music-tools.js'
import { createReading, READING_DEFAULT, sanitizeReading } from './reading.js'
import { createReadingTools } from './reading-tools.js'
// 「跟随外部桥会话」（docs/FOLLOW.md）：新逻辑全在 lib/follow.js，这里只开一个「读会话 id」的口子
import { FOLLOW_DEFAULT, createFollow, followDirOf, sanitizeFollow, shortSessionId, sourceMatches } from './follow.js'
import { archivedKeys } from './session-target.js'
import { createCleanup } from './cleanup.js'
import { clapDirOf, purge } from './purge.js'

export const name = 'dsh-pixel-pet'
export const childAlive = (child) => !!child && child.exitCode === null && child.signalCode == null && !child.killed
export const inject = ['webServer', 'sessions', 'sessionTitle', 'agents', 'tools', 'attachments']

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = join(HERE, '..')
const WEB_DIR = join(PLUGIN_ROOT, 'web')
const PREFIX = '/dsh-pixel-pet'
const BODY_LIMIT = 64 * 1024
const AUDIO_LIMIT = 20 * 1024 * 1024
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const IMAGE_LIMIT = 20 * 1024 * 1024
const CONVERT_TIMEOUT_MS = 10 * 60_000

export const SETTINGS_KEYS = ['character', 'size', 'topmost', 'stayPut', 'follow', 'aiControl', 'furniture', 'voice', 'python', 'mail', 'hub', 'imagegen', 'prompt', 'screen', 'voiceprint', 'hidden', 'autonomy', 'autoStart', 'partnerName', 'addressAs', 'listen', 'reading', 'insight', 'calendar', 'followSession']
export const DEFAULT_SETTINGS = {
  character: '', size: 0.65, topmost: true, stayPut: false, follow: true, aiControl: true, furniture: {}, python: '',
  autoStart: true,
  // 「跟随外部桥会话」的开关组。注意 `follow`（布尔）是老设置「看鼠标」，两者无关，别合并
  followSession: FOLLOW_DEFAULT,
  voice: DEFAULT_VOICE,
  mail: DEFAULT_MAIL,
  hub: DEFAULT_HUB,
  imagegen: DEFAULT_IMAGEGEN,
  prompt: '', screen: false, hidden: { character: [], furniture: [] },
  voiceprint: { ...VOICEPRINT_DEFAULT },
  autonomy: DEFAULT_AUTONOMY,
  partnerName: '',
  addressAs: '',
  listen: LISTEN_DEFAULT,
  reading: READING_DEFAULT,
  insight: INSIGHT_DEFAULT,
  calendar: CALENDAR_DEFAULT,
}

/**
 * 「ta的名字」(settings.partnerName) + 「称呼你为」(settings.addressAs)。
 * 这两个值会作为一行身份说明拼进发给该会话的提示词
 * （旧注释写的是 display-only / never goes into any prompt，那是 11 月前定的，已作废）。
 */
export const PARTNER_NAME_MAX = 24
export function sanitizePartnerName (v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, PARTNER_NAME_MAX) : ''
}

/** name shown on the UI: settings.partnerName, else the current character's display name. characters: [{ id, name }] */
export const ADDRESS_AS_MAX = 24
export function sanitizeAddressAs (v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, ADDRESS_AS_MAX) : ''
}

export function partnerNameOf (settings, characters = []) {
  const own = sanitizePartnerName(settings && settings.partnerName)
  if (own) return own
  const list = Array.isArray(characters) ? characters : []
  const cur = list.find((c) => c && c.id === (settings && settings.character)) || list.find((c) => c && !c.draft) || list[0]
  return (cur && cur.name) || ''
}

/** domain of the AI's own mail address (settings.mail.agently.address), '' when none */
export function mailDomainOf (settings) {
  const a = String((settings && settings.mail && settings.mail.agently && settings.mail.agently.address) || '')
  const i = a.lastIndexOf('@')
  return i > 0 ? a.slice(i + 1) : ''
}

export function defaultDataDir (env = process.env) {
  return env.PIXELPET_DATA_DIR || join(env.LOCALAPPDATA || env.HOME || '.', 'dsh-pixel-pet')
}

// --------------------------------------------------------------------------- pure helpers

export function mergeSettings (current, patch) {
  const out = { ...DEFAULT_SETTINGS, ...(current || {}) }
  // Never retain legacy names, scores, vectors or unknown voiceprint fields in settings.
  out.voiceprint = sanitizeVoiceprint(out.voiceprint)
  if (!patch || typeof patch !== 'object') return out
  for (const k of SETTINGS_KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (k === 'character' && (typeof v !== 'string' || (v && !ID_RE.test(v)))) continue
    if (k === 'size' && !(typeof v === 'number' && v >= 0.3 && v <= 3)) continue
    if (['topmost', 'stayPut', 'follow', 'aiControl', 'screen', 'autoStart'].includes(k) && typeof v !== 'boolean') continue
    if (k === 'partnerName') { if (typeof v === 'string') out.partnerName = sanitizePartnerName(v); continue }
    if (k === 'addressAs') { if (typeof v === 'string') out.addressAs = sanitizeAddressAs(v); continue }
    if (k === 'prompt') { if (typeof v === 'string') out.prompt = sanitizePrompt(v); continue }
    if (k === 'python' && (typeof v !== 'string' || v.length > 400)) continue
    if (k === 'furniture') {
      if (typeof v !== 'object' || v === null) continue
      const f = { ...(out.furniture || {}) }
      for (const [id, item] of Object.entries(v)) {
        if (!ID_RE.test(id) || typeof item !== 'object' || item === null) continue
        const clean = { ...(f[id] || {}) }
        if (typeof item.enabled === 'boolean') clean.enabled = item.enabled
        f[id] = clean
      }
      out.furniture = f
      continue
    }
    if (k === 'hidden') { out.hidden = sanitizeHidden(v); continue }
    if (k === 'followSession') { out.followSession = sanitizeFollow(v, out.followSession); continue }
    if (k === 'autonomy') { out.autonomy = sanitizeAutonomy(out.autonomy, v); continue }
    if (k === 'voiceprint') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const merged = { ...out.voiceprint, ...v }
      if ('enabled' in v && typeof v.enabled !== 'boolean') merged.enabled = out.voiceprint.enabled
      out.voiceprint = sanitizeVoiceprint(merged)
      continue
    }
    if (k === 'mail') { out.mail = sanitizeMail(out.mail, v); continue }
    if (k === 'listen') { out.listen = sanitizeListen(out.listen, v); continue }
    if (k === 'reading') { out.reading = sanitizeReading(out.reading, v); continue }
    if (k === 'insight') { out.insight = sanitizeInsight(out.insight, v); continue }
    if (k === 'calendar') { out.calendar = sanitizeCalendar(out.calendar, v); continue }
    if (k === 'hub') { out.hub = sanitizeHub(out.hub, v); continue }
    if (k === 'imagegen') { out.imagegen = sanitizeImagegen(out.imagegen, v); continue }
    if (k === 'voice') {
      if (typeof v !== 'object' || v === null) continue
      out.voice = sanitizeVoice(out.voice, v)
      continue
    }
    out[k] = v
  }
  out.voice = sanitizeVoice(out.voice, {})
  out.hub = sanitizeHub(out.hub, {})
  out.imagegen = sanitizeImagegen(out.imagegen, {})
  out.prompt = sanitizePrompt(out.prompt)
  out.screen = out.screen === true
  out.hidden = sanitizeHidden(out.hidden)
  out.autonomy = sanitizeAutonomy(out.autonomy, {})
  out.listen = sanitizeListen(out.listen, {})
  out.reading = sanitizeReading(out.reading, {})
  out.insight = sanitizeInsight(out.insight, {})
  out.calendar = sanitizeCalendar(out.calendar, {})
  out.followSession = sanitizeFollow(out.followSession, {})   // 老用户升级后这里就是 { mode: 'manual', … }，行为不变
  return out
}

/** built-in packs the user removed from the settings page (restorable; files stay in the plugin) */
export function sanitizeHidden (v) {
  const list = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 100)
  return { character: list(v && v.character), furniture: list(v && v.furniture) }
}

/** 用户自己的角色 / 家具文件夹：真删，经 purge（只许落在数据目录里面） */
function dropUserPack (dataDir, kind, id) {
  const r = purge(join(dataDir, KIND_DIR[kind], id), { roots: [dataDir] })
  return r.ok ? { ok: true } : { ok: false, code: r.code === 'busy' ? 409 : 500, message: r.code === 'busy' ? '有程序还在用，关掉桌宠再试' : '没删掉' }
}

/**
 * Remove a character / furniture from the settings page.
 *   user version of a built-in pack (<data>/… 同名覆盖, "已改")      -> folder deleted, built-in comes back
 *   user pack (<data>/characters|furniture/<id>, made with "+ 新建…")  -> folder deleted
 *   built-in pack (plugin folder)                                     -> hidden in settings, restorable
 * Returns { ok, how, patch } — patch is a settings patch the caller applies.
 */
export function removePack (dataDir, settings, kind, id) {
  if (!['character', 'furniture'].includes(kind) || !ID_RE.test(String(id || ''))) return { ok: false, code: 400, message: '不认识' }
  const hidden = sanitizeHidden(settings.hidden)
  const list = (kind === 'character' ? listCharacters(dataDir) : listFurniture(dataDir)).filter((p) => p.user || !hidden[kind].includes(p.id))
  const pack = list.find((p) => p.id === id)
  if (!pack) return { ok: false, code: 404, message: '没找到' }
  if (pack.pack) return { ok: false, code: 409, message: '请在「拓展包」里停用或卸载' }
  // an edited copy of a built-in pack: only the user layer goes, the built-in one is still there afterwards
  if (pack.user && pack.overlay) {
    const gone = dropUserPack(dataDir, kind, id)
    if (!gone.ok) return gone
    return { ok: true, how: 'restored', patch: { hidden: { ...hidden, [kind]: hidden[kind].filter((x) => x !== id) } } }
  }
  const patch = {}
  if (kind === 'character') {
    const left = list.filter((p) => p.id !== id && !p.draft)
    if (!left.length && !pack.draft) return { ok: false, code: 409, message: '至少留一个角色' }
    if (left.length && (settings.character === id || !settings.character)) patch.character = left[0].id
  } else {
    patch.furniture = { [id]: { enabled: false } }
  }
  if (pack.user) {
    const gone = dropUserPack(dataDir, kind, id)
    if (!gone.ok) return gone
    return { ok: true, how: 'deleted', patch }
  }
  patch.hidden = { ...hidden, [kind]: [...hidden[kind], id] }
  return { ok: true, how: 'hidden', patch }
}

/** built-in packs only, for self-checks (ids / draft flags). Layer resolution goes through packkit. */
export function listPacks (root, kind) {
  return packSnapshot({ pluginRoot: root, dataDir: null, settings: {} })[kind === 'character' ? 'characters' : 'furniture']
}

/**
 * Characters for the settings page: built-ins + user packs, resolved by packkit's frozen layering
 * (a valid user folder with a built-in id overrides it: user: true, overlay: true, builtin: true).
 */
export function listCharacters (dataDir) {
  return packSnapshot({ pluginRoot: PLUGIN_ROOT, dataDir, settings: {} }).characters
}

/** Furniture, same rules as listCharacters */
export function listFurniture (dataDir) {
  return packSnapshot({ pluginRoot: PLUGIN_ROOT, dataDir, settings: {} }).furniture
}

export const listVoices = (dataDir) => voiceList(PLUGIN_ROOT, dataDir)
export const depsStatus = (dataDir) => voiceDeps(PLUGIN_ROOT, dataDir)

/** assistant message -> plain text (text parts only). */
export function extractText (message) {
  const parts = message && Array.isArray(message.content) ? message.content : []
  return parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('').trim()
}

export const sessionKey = (id) => { const s = String(id ?? '').trim(); return s.startsWith('session-') ? s.slice(8) : s }

export function keyMatches (given, expected) {
  if (!expected || typeof given !== 'string') return false
  const a = Buffer.from(given); const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export { createRelay } from './relay.js'

/**
 * 「复制给 AI 的接入说明」：prompts/follow-integration.md 里只有三个占位符，换成这台机器的真实值。
 * 里面没有会话 id、没有号码、没有 key——只有本机路径和接口地址。
 */
let followTpl = null
export function renderFollowIntegration ({ followDir, apiBase, channelHint } = {}) {
  if (followTpl === null) {
    try { followTpl = readFileSync(join(PLUGIN_ROOT, 'prompts', 'follow-integration.md'), 'utf8') } catch { followTpl = '' }
  }
  const text = String(followTpl)
    .replace(/\{\{FOLLOW_DIR\}\}/g, String(followDir || ''))
    .replace(/\{\{PET_API\}\}/g, String(apiBase || ''))
    .replace(/\{\{CHANNEL_HINT\}\}/g, String(channelHint || '<channel>'))
  // 模板被改坏时不留占位符给用户（宁可少一段，也不给他一段看不懂的花括号）
  return text.replace(/\{\{[^}]{0,40}\}\}/g, '')
}

/** what the mailbox window gets: no raw HTML, no internal keys */
export function publicItem (it) {
  if (!it || typeof it !== 'object') return it
  const { html, key, ...rest } = it
  return rest
}

/** hand one verified local file to the OS default program (no shell, no user-supplied path) */
export function openWithDefault (file) {
  try {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(cmd, [file], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}

/** hand an http(s) link to the system browser — a URL only, never a path, never anything else */
export function openLink (url) {
  const u = String(url || '').trim()
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return false
  return openWithDefault(u)
}

// --------------------------------------------------------------------------- plugin
export function apply (ctx, rawConfig) {
  const cfg = (rawConfig && typeof rawConfig === 'object') ? rawConfig : {}
  if (cfg.enabled === false) return
  const logger = ctx.logger
  const dataDir = typeof cfg.dataDir === 'string' && cfg.dataDir ? cfg.dataDir : defaultDataDir()
  const settingsFile = join(dataDir, 'settings.json')
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') { logger?.warn?.('[dsh-pixel-pet] webServer 不可用'); return }

  let pet = null // { child, key, startedAt }
  let purged = false // 「清除全部数据」做完后为真：不再往数据目录写任何东西（下次启动插件才恢复）
  const spawnPet = typeof cfg.spawn === 'function' ? cfg.spawn : spawn // tests pass a fake; DSH config (JSON) cannot
  const openFile = typeof cfg.openFile === 'function' ? cfg.openFile : openWithDefault // tests never launch a real program
  const shots = createShotStore(dataDir)
  try { shots.clear() } catch {} // leftovers from a previous run

  let settingsReadError = false
  /**
   * 磁盘上的设置原值（手填的 voice.llm.sessionId 就在这儿）。
   * 只有两类地方该用它：写设置时找回手填值、跟随器自己取值。其余一律用下面的 readSettings()。
   */
  const readSettingsRaw = () => {
    try {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid settings')
      settingsReadError = false
      return mergeSettings(raw, {})
    } catch (e) {
      settingsReadError = e?.code !== 'ENOENT'
      // Existing unreadable settings must not silently turn the gate off or be overwritten.
      return mergeSettings(settingsReadError ? { voiceprint: { ...VOICEPRINT_DEFAULT, enabled: true } } : {}, {})
    }
  }
  // 「跟随外部桥会话」：跟随器自己也要读设置（取模式/来源/目录），而 readSettings 又依赖它，
  // 所以先占个位：跟随器在 relay / petSend / proactive 都建好之后才装配，之前读到的就是原值。
  let follow = null
  /**
   * **有效视图**：跟随模式下 voice.llm.sessionId 换成有效会话，别的字段原样。
   * activity / balance / guard / prompt / reading / relay / voice 这些模块照旧读这里，
   * 一行都不用改就能跟着会话走；写回设置时用 readSettingsRaw()，手填值永不被有效值覆盖。
   */
  const readSettings = () => {
    const raw = readSettingsRaw()
    return follow ? follow.view(raw) : raw
  }
  const mailOwner = () => {
    const s = readSettings()
    let chars = []
    try { chars = packSnapshot({ pluginRoot: PLUGIN_ROOT, dataDir, settings: s }).characters } catch {}
    return { name: partnerNameOf(s, chars), domain: mailDomainOf(s) }
  }
  /**
   * 保存设置。默认把手填的 voice.llm.sessionId 还原成磁盘上的原值——readSettings() 给的是「有效视图」，
   * 直接把它存回去就等于让跟随值污染手填值。唯一要改手填值的入口（/api/settings）显式传 keepSessionId。
   */
  const writeSettings = (s, opts = {}) => {
    if (purged) return
    if (settingsReadError) throw new Error('设置文件损坏或不可读，已拒绝覆盖；请先修复设置文件')
    let out = s
    if (!opts.keepSessionId && out && out.voice && out.voice.llm) {
      const rawSid = readSettingsRaw().voice.llm.sessionId
      if (out.voice.llm.sessionId !== rawSid) out = { ...out, voice: { ...out.voice, llm: { ...out.voice.llm, sessionId: rawSid } } }
    }
    mkdirSync(dataDir, { recursive: true })
    const tmp = settingsFile + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    renameSync(tmp, settingsFile)
  }

  // ---- Python: settings.python -> downloaded runtime -> a PATH python, prepared on demand (pyruntime.js)
  const python = cfg.pythonManager || createPythonManager({ root: PLUGIN_ROOT, dataDir, settings: readSettings, logger })
  /** the interpreter to run; empty until resolved (the pet start waits for it) */
  const pyPath = () => python.path || readSettings().python.trim() || 'python'
  // resolve once in the background so the settings page can show which interpreter is in use
  ctx.effect(() => {
    const timer = setTimeout(() => { python.detect().catch(() => {}) }, 1500)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  // live + not-yet-loaded sessions (archived hidden); the saved one is always listed, flagged missing if deleted
  // 用原值：设置页那个选择框编辑的就是手填值，跟随模式下也要一直能选回别的会话
  const sessionsList = async () => {
    try { return await relay.target.list(readSettingsRaw().voice.llm.sessionId) } catch { return [] }
  }

  // ---- AI tools: one global registration (the pet is one desktop entity, not per session), so no
  //      per-session name clash. Toggled by settings.aiControl; execute() re-checks it as well.
  // 「允许感知在做什么」(lib/awareness.js): off = no note, no summary, no log rows served
  const awareness = createAwareness({ dataDir, settings: readSettings })
  // 「活动与额度」页签 v2：监测桌宠自己（lib/pet-activity.js）。只记类别/计数/时长/结果。
  const petlog = createPetActivity({ dataDir })
  // 所有发往桌宠的命令都走这里：cmd === 'say' 时给「今日桌宠做了什么」记一笔（出声/气泡，只记字数）；
  // 出声的同时通知音乐服务（duck）：回环别把自己的 TTS 当成用户在听的歌
  const petSend = (body, ms) => {
    if (purged) return Promise.resolve({ ok: false, message: '数据已清除' })
    try {
      if (body && body.cmd === 'say') {
        const chars = typeof body.text === 'string' ? body.text.length : 0
        petlog.record('say', { speak: body.speak === true, chars })
        if (body.speak === true && music) music.duckSpeaking(Math.min(30, Math.max(3, 2.5 + chars * 0.16)))
      }
    } catch {}
    return sendCommand(dataDir, body, ms)
  }
  // 「日历与日记」拓展包（lib/calendar.js）：日程 / 提醒 / 桌宠日记 / 只读订阅。关着时 API 409、工具不注册。
  // openWindow 必须传：漏传时 /api/calendar/open 永远回「打不开日历窗」
  const calendar = createCalendar({ dataDir, settings: readSettings, sendCommand: petSend, fetchImpl: cfg.fetch, logger, openWindow: (url, size) => openPageAndLook(url, size) })
  ctx.effect(() => calendar.start())
  // bound session: pixelpet_* tools the model is not offered (request/header, lib/session-guard.js)
  // (its agent/pre-step reading rides balance.attach's listener: onStep below)
  const guard = createSessionGuard({ dataDir, settings: readSettings, registered: () => [...toolOffs.keys()] })
  const promptChannel = createPromptChannel({ ctx, dataDir, settings: readSettings, logger, note: () => renderNote(awareness.note()), near: () => calendar.nearLine() })
  ctx.effect(() => () => promptChannel.dispose())
  // 「一起看书」上下文槽：阅读窗有当前划选时，经任何入口（输入条打字/语音、阅读卡片）发给绑定会话的话都附上它
  let readingDecor = null
  const relay = createRelay(ctx, undefined, {
    decorate: (sid, content) => {
      let d = promptChannel.decorate(sid, content)
      try { d = readingDecor ? readingDecor(sid, d) : d } catch { /* 阅读槽坏了一次就不附 */ }
      try { d = calendar.decorate(sid, d) || d } catch { /* 日记捎带坏了一次就不附 */ }
      return d
    },
    // 桌宠发起的每一次模型请求（ask / job）结束时记一笔：来源、成败、耗时、token（DSH 事件带才有）
    onTurn: (info) => {
      if (purged) return
      try { petlog.record('turn', { source: info.source, ok: info.ok === true, ms: info.ms, tokens: info.tokens }) } catch {}
      try { calendar.onTurn(info) } catch {}
    },
  })
  const followActivity = createActivityFollower({
    targetId: () => readSettings().voice.llm.sessionId, keyOf: sessionKey, send: (cmd) => petSend(cmd),
  })
  // 工具级小动作（lib/anim-follow.js）：搜索举放大镜、读文件翻书、审批收牌… 只演瞬时动作，
  // 不动会话状态；素材没到位时由 anim-map 的 CURRENT 映射到已有状态。aiControl 关掉就整体不演。
  // 动画排查日志：<dataDir>/anim-log.jsonl，一行一次触发（只记状态名/工具名，不记参数）
  const animLog = (row) => {
    try {
      appendFileSync(join(dataDir, 'anim-log.jsonl'),
        JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n', 'utf8')
    } catch {}
  }
  const followAnim = createAnimFollower({
    targetId: () => readSettings().voice.llm.sessionId,
    keyOf: sessionKey,
    send: (cmd) => petSend(cmd),
    enabled: () => readSettings().aiControl !== false,
    log: animLog,
  })
  // 位置行为（lib/notice.js）：用户说「检查一下」、审批卡出现、插件页面被打开 → 跑过去看一眼再回来。
  // 「动不动」的最终裁决在桌宠侧 move_guard（别乱走 / 全屏 / 被拿着 / 一分钟走太多都安静不动）。
  const notifier = createNotifier({
    send: (cmd) => petSend(cmd),
    targetId: () => readSettings().voice.llm.sessionId,
    keyOf: sessionKey,
    enabled: () => readSettings().aiControl !== false,
  })
  // 打开插件自己的页面（创建/信箱/日历…）→ 等窗口起来后桌宠跑过去看一眼。
  // 日历窗走的是它自己注入的 openWindow，所以统一从这里包一层，别只挂 /api/open。
  const openPageAndLook = (url, size) => {
    try {
      const fn = cfg.openWindow || openWindow
      const ok = fn(url, size)
      if (ok !== false) { try { notifier.onPageOpen() } catch {} }
      return ok
    } catch { return false }
  }
  // one subscription: some hosts keep a single handler per event name
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('session/event', (session, event) => { relay.onEvent(session, event); followActivity(session, event); followAnim(session, event); notifier.onEvent(session, event); guard.onEvent(session, event); proactive.onEvent(session, event) }))
  const ask = relay.ask

  // HTML cards sent out by mail need a real local screenshot; no browser -> the sync reports the failure
  const cardShot = createCardRenderer({ logger })
  // 2026-11-16：授权掉线不再静默——桌宠说一句、能自动恢复、恢复后把掉线期间的信补回来
  const mail = new MailService({
    dataDir, relay, settings: readSettings, logger, snapshot: cardShot,
    agentlyFactory: typeof cfg.agentlyFactory === 'function' ? cfg.agentlyFactory : undefined,
    openUrl: typeof cfg.openUrl === 'function' ? cfg.openUrl : openLink,
    onAuthLost: () => petSend({ cmd: 'say', text: '邮箱授权掉了，去设置里重新授权一下', seconds: 9 }, 2_000),
    onAddress: (email) => {
      // 只在用户从没填过时回填；写回走和设置页同一条 sanitize 通道
      const cur = readSettings()
      if (String((cur.mail && cur.mail.agently && cur.mail.agently.address) || '').trim()) return
      try { writeSettings(mergeSettings(readSettingsRaw(), { mail: { agently: { address: email } } }), { keepSessionId: true }) } catch {}
    },
  })
  ctx.effect(() => {
    mail.start().catch((e) => logger?.warn?.('[dsh-pixel-pet] 信箱启动失败：' + String(e && e.message || e).slice(0, 160)))
    return () => mail.stop()
  })

  const toolsSvc = ctx.tools || (ctx.get ? ctx.get('tools') : null)
  // 家具工具说明里带上「现在摆着：…」，模型不必先 list 就知道能用什么（2026-11-10）
  // M0 起走 packkit 统一解析（用户层有效才胜出），和页面/运行时看到的是同一份
  const furnitureBrief = () => {
    const s = readSettings()
    const on = Object.entries(s.furniture || {}).filter(([, v]) => v && v.enabled).map(([k]) => k)
    if (!on.length) return ''
    return on.map((id) => {
      const pk = resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: 'furniture', id })
      const d = pk && pk.data
      if (!d) return ''
      const verbs = (d.interactions || []).map((i) => i.verb + '=' + (i.say || i.verb)).join('、')
      return d.name + '（id=' + id + '）' + (verbs ? '：' + verbs : '')
    }).filter(Boolean).join('；')
  }
  // 「一起听歌」v2（docs/MUSIC_CONTRACT.md）：listen.enabled 关着时工具不注册（def.when）
  const musicDaily = cfg.musicDaily || createMusicDaily({ dataDir, settings: readSettings, relay, logger })
  const music = createMusic({
    dataDir, settings: readSettings, relay, logger, daily: musicDaily, openWindow: cfg.openWindow || openWindow,
    bridge: cfg.musicBridge, pickAudioFolder: cfg.pickAudioFolder,
    changeAudioDirs: (edit) => {
      const raw = readSettingsRaw()
      if (!raw.listen.enabled) return null
      const audioDirs = edit(raw.listen.audioDirs)
      writeSettings({ ...raw, listen: { ...raw.listen, audioDirs } })
      return audioDirs
    },
  })
  ctx.effect(() => () => music.dispose())
  const musicTools = createMusicTools({ music, daily: musicDaily, settings: readSettings })
  // 「一起看书」（docs/READING_CONTRACT.md）：reading.enabled 关着时 API 409、工具不注册
  const reading = createReading({
    dataDir, settings: readSettings, relay, logger, spawnFn: cfg.readingSpawn,
    sendCommand: (body, ms) => petSend(body, ms),
    transcribe: (wav) => transcribeWithDsh(ctx, wav),
    partner: () => { const s = readSettings(); return { name: mailOwner().name, character: s.character || '' } },
  })
  readingDecor = reading.decorate
  ctx.effect(() => () => reading.dispose())
  const readingTools = createReadingTools({ reading, settings: readSettings })
  const buildToolDefs = () => makeTools({ dataDir, send: (dir, body) => petSend(body), enabled: () => readSettings().aiControl !== false, mail, furnitureLine: furnitureBrief(),
    screen: { screenEnabled: () => readSettings().screen === true, attachments: () => ctx.attachments || (ctx.get ? ctx.get('attachments') : null) },
    balance: () => balance.status(), activity: () => awareness.today(), care: () => proactive.view() }).concat(musicTools.tools(), readingTools.tools(), calendar.tools())
  // DeepSeek 余额（lib/balance.js）：懒取 + 5 分钟缓存；key 只在 <data>/balance-settings.json；每轮给桌宠绑定会话附一行
  const balance = cfg.balance || createBalance({ dataDir, fetchImpl: cfg.fetch, pointed: () => readSettings().voice.llm.sessionId, onStep: (a) => guard.onStep(a) })
  ctx.effect(() => balance.attach(ctx) || undefined)
  // 「主动关心」（叫醒 + AI 自己判断说不说，lib/proactive.js）：每 60 s 一次 tick，只读本地状态；
  // 熔断读 balance.js 的磁盘缓存，不额外请求。事件里认「用户说话了」/「会话在跑」。
  const proactive = createProactive({
    dataDir, settings: readSettings, relay,
    sendCommand: (body, ms) => petSend(body, ms),
    // 主动关心每次叫醒的判定结果，给「今日桌宠做了什么」记一笔
    onWake: (info) => { try { petlog.record('care', info) } catch {} },
    // 日历由头：提醒 / 特别日子（lib/calendar.js wakeContext）；叫醒成功后销账
    extras: () => calendar.wakeContext(),
    onFired: ({ type, item, date } = {}) => {
      try {
        if (type === 'reminder' && item) calendar.markReminded(item.id, item.occurrenceDate, item.daysBefore)
        else if (type === 'special_day' && date) calendar.markSpecialDay(date)
      } catch {}
    },
  })
  ctx.effect(() => proactive.start())
  // ---- 「跟随外部桥会话」（docs/FOLLOW.md）：桥写门牌，桌宠跟过去。逻辑全在 lib/follow.js，
  //      这里只提供三样东西：怎么读设置（原值）、怎么核实会话还活着、变了以后通知谁。
  /**
   * 会话存在、而且没有被归档。用 DSH 自己的会话表：
   *   workspaceRegistry.archivedSessionIds -> 归档列表（lib/session-target.js 的 archivedKeys）
   *   sessionQuery.listSessions()          -> 活的和没加载的都算（sessionTarget.list 的缓存 8 s，逐条核实不贵）
   * 查不到就当门牌坏了（跟随器会保持上次已知会话），绝不猜。
   */
  const verifySession = async (id) => {
    const want = sessionKey(id)
    if (!want) return { ok: false, reason: 'empty' }
    try { if (archivedKeys(ctx).has(want)) return { ok: false, reason: 'archived' } } catch {}
    try {
      const list = await relay.target.list(id)
      const hit = (list || []).find((x) => x && sessionKey(x.id) === want)
      if (!hit) return { ok: false, reason: 'missing' }
      if (hit.archived) return { ok: false, reason: 'archived' }
      if (hit.missing) return { ok: false, reason: 'missing' }
      return { ok: true }
    } catch { return { ok: false, reason: 'error' } }
  }
  follow = createFollow({
    dataDir,
    settings: readSettingsRaw,
    verify: verifySession,
    logger,
    // 有效会话变了：冒个不出声的气泡让人看得见；复位动画与「会话在跑」判断；只记变化本身，不记会话 id
    onChange: ({ from, to, label, reason }) => {
      if (reason === 'moved') {
        try { petSend({ cmd: 'say', text: '搬到新会话了：' + (label || '新会话'), seconds: 8 }, 3_000) } catch {}
      }
      try { petlog.record('follow', { changed: true }) } catch {}
      try { proactive.resetSession() } catch {}      // turns 只记绑定会话，切换后旧 turn 的 end 会被过滤
      try { petSend({ cmd: 'activity', state: 'idle' }) } catch {} // 别让「思考中」卡在旧会话上
      if (from && to) logger?.info?.('[dsh-pixel-pet] 跟随切换会话（' + reason + '）')
    },
  })
  ctx.effect(() => follow.start())
  /**
   * 桌宠发问时用哪个会话。
   *   手动模式：完全照旧（请求体里的 sessionId 优先，其次手填值）。
   *   跟随模式：**忽略请求体里的 sessionId**——桌宠那边的设置文件里存的是手填值，
   *   它每次都带着旧值来（F8 语音、输入条两条路都是），照用就等于跟随白做了。
   *   但已经发出去的那一轮仍按发出时的会话收：同一 requestId 再问一次、或者回来取结果，
   *   用的一定是当初那条消息进的会话（切换只改「下一句发去哪儿」，不打断在途任务）。
   */
  const askSids = new Map() // requestId -> 发出时的会话（只在跟随模式下用，界 256 条）
  const noteAskSid = (requestId, sid) => {
    if (!follow.effectiveSessionId() || typeof requestId !== 'string' || !requestId) return
    askSids.delete(requestId)
    askSids.set(requestId, String(sid))
    if (askSids.size > 256) askSids.delete(askSids.keys().next().value)
  }
  const askTarget = (body) => {
    const eff = follow.effectiveSessionId()
    if (!eff) return String((body && body.sessionId) || readSettingsRaw().voice.llm.sessionId || '')
    const remember = body && typeof body.requestId === 'string' ? askSids.get(body.requestId) : ''
    return remember || String(eff)
  }
  // 「活动与额度」页签的额度采样（lib/quota-log.js）：每 5 分钟走 balance.js 的缓存查询写一行，
  // 只写成功的（没配 key / 失败一律跳过，绝不写假点）；settings.insight.on 关掉即停，随插件起停。
  const quota = createQuotaSampler({ dataDir, getBalance: () => balance.get(false), logger })
  const syncInsight = () => { try { return readSettings().insight.on ? quota.start() : quota.stop() } catch {} }
  ctx.effect(() => { syncInsight(); return () => quota.stop() })
  let toolDefs = buildToolDefs()
  const toolOffs = new Map() // name -> disposer
  let toolWarned = false
  const toolPrints = new Map() // name -> what the model sees of it (see syncTools)
  const toolPrint = (def) => JSON.stringify([def.description, def.parameters, def.timeoutMs])
  const syncTools = () => {
    if (!toolsSvc || typeof toolsSvc.register !== 'function') {
      if (!toolWarned) { toolWarned = true; logger?.warn?.('[dsh-pixel-pet] tools 服务不可用，AI 工具未注册') }
      return
    }
    const cur = readSettings()
    const want = cur.aiControl !== false
    toolDefs = buildToolDefs()
    // Diff, don't churn: every settings save used to unregister + re-register every tool, which briefly
    // invalidated the tool handles an open session was holding. Now only tools that appear, disappear or
    // change what the model sees (description / parameters / timeout — e.g. the furniture line) are touched.
    const wanted = new Map()
    if (want) {
      for (const full of toolDefs) {
        // optional def.when(settings): an extension that is switched off stays invisible to the AI (no tokens)
        if (typeof full.when === 'function' && !full.when(cur)) continue
        const { when: _when, ...def } = full
        wanted.set(def.name, { def, fp: toolPrint(def) })
      }
    }
    for (const [n, off] of toolOffs) {
      const w = wanted.get(n)
      if (w && w.fp === toolPrints.get(n)) continue
      try { if (typeof off === 'function') off() } catch {}
      toolOffs.delete(n); toolPrints.delete(n)
    }
    for (const [n, { def, fp }] of wanted) {
      if (toolOffs.has(n)) continue
      // 「今日桌宠做了什么」：在注册处统一包一层 execute 记 tool 事件（不逐个工具改，返回值原样透传）
      const monitored = {
        ...def,
        execute: async (args, exec) => {
          let r
          try { r = await def.execute(args, exec) } catch (e) {
            try { petlog.record('tool', { name: def.name, ok: false }) } catch {}
            throw e
          }
          try { petlog.record('tool', { name: def.name, ok: !!(r && r.ok === true) }) } catch {}
          return r
        },
      }
      try { toolOffs.set(n, toolsSvc.register(monitored)); toolPrints.set(n, fp) } catch (e) {
        const msg = String(e && e.message || e)
        // a stale registration of the same name still holds it: treat as present, do not retry-spam
        if (/already registered/i.test(msg)) { toolOffs.set(n, null); toolPrints.set(n, fp) }
        logger?.warn?.('[dsh-pixel-pet] 注册 ' + n + ' 失败：' + msg.slice(0, 160))
      }
    }
  }
  syncTools()
  ctx.effect(() => () => { for (const off of toolOffs.values()) { try { if (typeof off === 'function') off() } catch {} } toolOffs.clear(); toolPrints.clear() })

  // ---- "+ 新建角色": image provider (Node side only) + creation jobs
  const keys = createKeyStore(ctx)
  const images = cfg.images || createImageClient({ settings: () => readSettings().imagegen, keys })
  const convertPack = typeof cfg.convert === 'function' ? cfg.convert : ({ src, out, specFile }) => new Promise((done) => {
    let outText = ''; let child
    try {
      child = spawn(pyPath(), [join(PLUGIN_ROOT, 'runtime', 'create_convert.py'), '--src', src, '--out', out, '--spec', specFile],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    } catch { return done({ ok: false, available: false, message: '启动 Python 失败' }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, CONVERT_TIMEOUT_MS)
    child.stdout.on('data', (b) => { outText += b })
    child.stderr.on('data', () => {})
    child.on('error', () => { clearTimeout(timer); done({ ok: false, available: false, message: '找不到 Python' }) })
    child.on('close', () => {
      clearTimeout(timer)
      try { done({ ...JSON.parse(outText.trim().split('\n').pop()), available: true }) } catch { done({ ok: false, available: true, message: '转换脚本没有有效输出' }) }
    })
  })
  /** Python validate.py --strict <dir> -> { ok, draft, issues, message } | null when no interpreter */
  const validatePackDir = typeof cfg.validate === 'function' ? cfg.validate : (dir) => new Promise((done) => {
    let out = ''
    let child
    try {
      child = spawn(pyPath(), [join(PLUGIN_ROOT, 'runtime', 'validate.py'), '--strict', dir],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    } catch { return done(null) }
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); done(r) } }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish(null) }, 90_000)
    child.stdout.on('data', (b) => { out += b; if (out.length > 200_000) out = out.slice(-200_000) })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(null))
    child.on('close', () => {
      const lines = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      if (!lines.length) return finish(null)
      finish({ ok: /^OK/.test(lines[0]), draft: /骨架/.test(lines[0]), message: lines[0], issues: lines.slice(1, 61) })
    })
  })
  const studio = createStudio({ dataDir, images, convert: convertPack, validate: validatePackDir, logger })
  ctx.effect(() => () => studio.dispose())
  // "+ 新建家具": same image client, its own converter (runtime/furniture_convert.py), handoff through the relay
  const convertFurniture = typeof cfg.convertFurniture === 'function' ? cfg.convertFurniture : ({ src, out, frames, size }) => new Promise((done) => {
    let outText = ''; let child
    try {
      child = spawn(pyPath(), [join(PLUGIN_ROOT, 'runtime', 'furniture_convert.py'), '--src', src, '--out', out, '--frames', frames.join(','), '--size', size.join(',')],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    } catch { return done({ ok: false, available: false, message: '启动 Python 失败' }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, CONVERT_TIMEOUT_MS)
    child.stdout.on('data', (b) => { outText += b })
    child.stderr.on('data', () => {})
    child.on('error', () => { clearTimeout(timer); done({ ok: false, available: false, message: '找不到 Python' }) })
    child.on('close', () => {
      clearTimeout(timer)
      try { done({ ...JSON.parse(outText.trim().split('\n').pop()), available: true }) } catch { done({ ok: false, available: true, message: '转换脚本没有有效输出' }) }
    })
  })
  const fstudio = createFurnitureStudio({ dataDir, images, convert: convertFurniture, validate: validatePackDir, relay: { post: (...a) => relay.post(...a) }, sessionId: () => readSettings().voice.llm.sessionId })
  ctx.effect(() => () => fstudio.dispose())
  const imagegenView = async () => {
    const s = readSettings().imagegen
    return { settings: s, store: keys.kind, key: await keys.describe(s.keyRef), providers: IMAGE_PROVIDERS }
  }

  const runPython = (args, input) => new Promise((done) => {
    const py = pyPath()
    let out = ''
    let child
    try {
      child = spawn(py, [join(PLUGIN_ROOT, 'runtime', 'voice_cli.py'), '--data-dir', dataDir, ...args], { windowsHide: true })
    } catch (e) { return done({ ok: false, available: false, message: '启动 Python 失败' }) }
    child.stdout.on('data', (b) => { out += b })
    child.on('error', () => done({ ok: false, available: false, message: '找不到 Python' }))
    child.on('close', () => { try { done(JSON.parse(out.trim().split('\n').pop())) } catch { done({ ok: false, message: '无输出' }) } })
    if (input) child.stdin.end(input)
  })

  // ---- voice components: installed in the background when the plugin is first enabled (the
  //      built-in TTS is the core experience, so no manual download step). Retry resumes partial files.
  //      The Python runtime is prepared by `python` above, so it is left out of this installer's auto set.
  const installer = createInstaller({ root: PLUGIN_ROOT, dataDir, python: pyPath, logger })
  const vpApi = createVoicePrintApi({
    send: (body) => petSend(body),
    installModel: () => installer.start({ ids: ['speaker-model'] }),
  })
  // 用户在设置页删掉语音引擎后，不能一重启又自动装回来：留一个标记，点「下载」时才撤掉
  const noAutoFile = join(dataDir, 'voice-no-auto.json')
  const setAutoInstall = (on) => {
    try {
      if (on) rmSync(noAutoFile, { force: true })
      else { mkdirSync(dataDir, { recursive: true }); writeFileSync(noAutoFile, JSON.stringify({ at: new Date().toISOString() }), 'utf8') }
    } catch {}
  }
  if (cfg.autoInstall !== false && !process.env.PIXELPET_NO_AUTO_INSTALL) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        if (existsSync(noAutoFile)) return
        // voice deps are pip-installed into whichever interpreter runs them: settle Python first
        Promise.resolve(python.ensure()).then(() => installer.start()).catch(() => {}) // Python rechecks revisions for its exact interpreter tag; installed components are skipped
      }, 3000)
      timer.unref?.()
      return () => { clearTimeout(timer); installer.stop() }
    })
  }
  const voiceStatus = () => {
    const s = installer.status()
    const p = s.progress
    return { running: s.running, ready: s.ready, total: s.total, deps: s.deps, last: s.last,
      progress: p ? { phase: p.phase, id: p.id, file: p.file, done: p.done, total: p.total, overall: p.overall, message: p.message } : null }
  }

  // ---- 拓展包管理器（M1）：pack_cli.py 是注册表唯一写者，这里编排安装/回执/卸载
  const packmgr = cfg.packManager || createPackManager({
    root: PLUGIN_ROOT, dataDir, python: pyPath, logger,
    send: (body) => petSend(body, 45_000),
    permissionIds: permissionIds(),
  })
  const claudePack = 'builtin.claude-girl'
  // 迁移在桌宠启动前被 await：目录条目是网络地址（GitHub Release）时必须有超时，超时按失败处理（退回鲸鱼娘并提示）
  const MIGRATION_TIMEOUT_MS = Number(cfg.migrationTimeoutMs) > 0 ? Number(cfg.migrationTimeoutMs) : 30_000
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('下载超时')), ms + 2000)
    t.unref?.()
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
  const migrationInstall = (opts) => withTimeout(packmgr.installFromCatalog(claudePack, { ...opts, timeoutMs: MIGRATION_TIMEOUT_MS, retries: 1 }), MIGRATION_TIMEOUT_MS)
  const claudeCatalogEntry = () => packmgr.catalog().entries.find((entry) => entry.id === claudePack && (entry.bundled || entry.url))
  const migrationKey = 'claude-girl-to-pack'
  const migrationFile = join(dataDir, 'packs', 'migrations.json')
  let migrationNotice = ''
  let claudeMigrationAttempted = false
  const bookBed = 'claude-book-bed'
  const bedMigration = 'book-bed-to-pack'
  const packedCharacter = (id) => resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: 'character', id })
  const fallbackCharacter = (id) => {
    const s = readSettingsRaw()
    if (s.character !== id || packedCharacter(id)?.valid) return
    writeSettings({ ...s, character: 'whale-girl' })
    syncTools()
  }
  async function migrateClaude () {
    if (readSettingsRaw().character !== 'claude-girl'
      || resolveOne({ pluginRoot: PLUGIN_ROOT, kind: 'character', id: 'claude-girl' })) return
    if (!claudeCatalogEntry()) return
    const installed = packmgr.status().registry?.packs?.[claudePack]
    if (installed) {
      if (!loadPointer(installed)) fallbackCharacter('claude-girl')
      return
    }
    let marks = {}
    try { marks = JSON.parse(readFileSync(migrationFile, 'utf8')) } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    if (marks[migrationKey]) {
      fallbackCharacter('claude-girl')
      return
    }
    // Claim before starting so an interrupted migration cannot silently reinstall an uninstalled pack.
    mkdirSync(dirname(migrationFile), { recursive: true })
    writeFileSync(migrationFile + '.tmp', JSON.stringify({ ...marks, [migrationKey]: new Date().toISOString() }, null, 2), 'utf8')
    renameSync(migrationFile + '.tmp', migrationFile)
    claudeMigrationAttempted = true
    const r = await migrationInstall({ enable: true })
    if (!r.ok || !packedCharacter('claude-girl')?.valid) throw new Error(r.message || '桌宠没加载到角色')
    migrationNotice = 'Claude娘 现在是拓展包了，已经帮你装上'
  }
  function migrationFailed (err) {
    try { fallbackCharacter('claude-girl') } catch {}
    migrationNotice = 'Claude娘 自动安装失败：' + String(err?.message || err).slice(0, 160) + '。可在「拓展包」里手动下载。'
    logger?.warn?.('[dsh-pixel-pet] ' + migrationNotice)
  }
  const newer = (version, current) => {
    if (!version || !current) return false
    try { return compareVersions(version, current) > 0 } catch { return false }
  }
  function claimPackMigration (key) {
    let marks = {}
    try { marks = JSON.parse(readFileSync(migrationFile, 'utf8')) } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    if (marks[key]) return false
    mkdirSync(dirname(migrationFile), { recursive: true })
    writeFileSync(migrationFile + '.tmp', JSON.stringify({ ...marks, [key]: new Date().toISOString() }, null, 2), 'utf8')
    renameSync(migrationFile + '.tmp', migrationFile)
    return true
  }
  async function migrateClaudeExtras () {
    if (claudeMigrationAttempted) { syncTools(); return }
    const source = claudeCatalogEntry()
    if (!source) return
    const installed = packmgr.status().registry?.packs?.[claudePack]
    const needsUpgrade = installed && newer(source.version, installed.active?.version)
    const needsBed = !installed && readSettingsRaw().furniture?.[bookBed]?.enabled === true
      && !existsSync(join(PLUGIN_ROOT, 'furniture', bookBed, 'furniture.json'))
    if (!needsUpgrade && !needsBed) return
    // 每个附带版本各记一次：写死 1.1 会让以后的 1.2 等永远被这条旧记录挡住
    const key = needsUpgrade ? 'claude-girl-pack-' + source.version : bedMigration
    const action = needsUpgrade ? '更新' : '安装书页床'
    try {
      if (!claimPackMigration(key)) return
      const r = await migrationInstall({ enable: needsUpgrade ? installed.wantEnabled === true : true })
      if (!r.ok) throw new Error(r.message || '拓展包操作失败')
      migrationNotice = needsUpgrade
        ? 'Claude娘 拓展包已更新到 ' + source.version
        : '书页床现在在 Claude娘 拓展包里，已经帮你装上'
      syncTools()
    } catch (err) {
      migrationNotice = 'Claude娘 拓展包自动' + action + '失败：' + String(err?.message || err).slice(0, 160) + '。可在「拓展包」里手动处理。'
      logger?.warn?.('[dsh-pixel-pet] ' + migrationNotice)
    }
  }
  const migration = migrateClaude().catch(migrationFailed).then(migrateClaudeExtras)
  // 启动时清掉过了保留期的旧版本（新版本收到回执后保留 7 天，见 docs/PACK_SPEC.md §7.5）。没有旧版本就不拉 Python。
  migration.then(() => {
    const packs = packmgr.status().registry?.packs || {}
    if (!Object.values(packs).some((e) => e && e.previous && e.previousExpiresAt)) return
    return packmgr.prunePrevious({})
  }).catch(() => {})
  const selectedPreset = () => {
    const id = readSettingsRaw().voice.tts.voice
    return !id.startsWith('clone-') && listVoices(dataDir).some((voice) => voice.kind === 'preset' && voice.id === id) ? id : null
  }
  const afterPackChange = (preset = null) => {
    if (preset && !listVoices(dataDir).some((voice) => voice.kind === 'preset' && voice.id === preset)) {
      const s = readSettingsRaw()
      if (s.voice.tts.voice === preset) {
        s.voice = sanitizeVoice(s.voice, { tts: { voice: DEFAULT_VOICE.tts.voice } })
        writeSettings(s) // the pet's settings mtime reload replaces the TTS bridge
      }
    }
    syncTools()
  }
  const petMusic = createPetMusic({
    enabled: music.enabled,
    petId: () => pet && childAlive(pet.child) ? pet.child : null,
    live: music.live,
    send: (body) => petSend(body, 2000),
  })
  ctx.effect(() => () => petMusic.dispose())
  const packsStatus = () => {
    const status = packmgr.status()
    const catalog = packmgr.catalog()
    const updates = Object.fromEntries(catalog.entries.filter((entry) =>
      newer(entry.version, status.registry?.packs?.[entry.id]?.active?.version)).map((entry) => [entry.id, entry.version]))
    return { ...status, catalog, updates }
  }

  /** spawn the pet with one concrete interpreter */
  const launchPet = (baseUrl, exe) => {
    if (pet && childAlive(pet.child)) return { ok: true, running: true }
    const s = readSettings()
    const key = randomBytes(24).toString('base64url')
    const args = [join(PLUGIN_ROOT, 'runtime', 'run_pet.py'), '--data-dir', dataDir]
    if (s.character) args.push('--character', s.character)
    let child
    try {
      child = spawnPet(exe, args, {
        windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PIXELPET_DATA_DIR: dataDir, PIXELPET_HOST_BASE: baseUrl + PREFIX, PIXELPET_BRIDGE_KEY: key,
          // M5: the pet's own numpy is only used for small echo-guard FFTs; OpenBLAS otherwise reserves
          // a per-thread buffer pool and that alone was hundreds of MB of commit charge.
          OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' },
      })
    } catch (e) { return { ok: false, message: '启动失败' } }
    let err = ''
    child.stderr.on('data', (b) => { err = (err + b).slice(-2000) })
    child.on('error', () => { err = '找不到 Python' })
    child.on('exit', (code) => { if (pet && pet.child === child) pet.lastExit = { code, err } })
    pet = { child, key, startedAt: Date.now(), lastExit: null }
    void petMusic.sync()
    if (packmgr.confirmPending) {
      const check = async (tries) => {
        if (pet?.child !== child || !childAlive(child)) return
        const reg = packmgr.status().registry
        if (!Object.values(reg?.packs || {}).some((entry) => entry.state === 'installed-disabled' && loadPointer(entry))) return
        const status = await petSend({ cmd: 'packs', action: 'status' }, 1000)
        if (status.ok && !packmgr.running) {
          const preset = selectedPreset()
          const result = await packmgr.confirmPending()
          afterPackChange(preset)
          const failedClaude = result.failures?.find((failure) => failure.id === claudePack)
          if (failedClaude && migrationNotice) migrationFailed(failedClaude.message)
          else if (readSettingsRaw().character === 'claude-girl' && failedClaude) fallbackCharacter('claude-girl')
          return
        }
        if (tries > 1) setTimeout(() => void check(tries - 1).catch(() => {}), 1000).unref?.()
      }
      setTimeout(() => void check(45).catch(() => {}), 1000).unref?.()
    }
    return { ok: true, running: true }
  }

  let pendingStart = null // baseUrl of a start that is waiting for Python to be prepared
  const prepareThenStart = (baseUrl) => {
    pendingStart = baseUrl
    python.ensure().then((p) => {
      if (!pendingStart || pet) return
      const target = pendingStart
      pendingStart = null
      launchPet(target, p.path)
    }).catch(() => { pendingStart = null })
    return { ok: true, running: false, preparing: true, python: python.snapshot() }
  }

  const startPet = (baseUrl) => {
    if (pet && childAlive(pet.child)) return { ok: true, running: true }
    const exe = python.path || python.quick()            // an explicitly configured python needs no probing
    if (!exe) return prepareThenStart(baseUrl)           // nothing usable yet: prepare, then start
    return launchPet(baseUrl, exe)
  }

  const stopPet = () => {
    if (pet && childAlive(pet.child)) { try { pet.child.kill() } catch {} }
    return { ok: true, running: false }
  }
  /** 停桌宠并等它真的退出（Windows 上文件被占着删不掉），最多等 8 秒 */
  const stopPetAndWait = async () => {
    const p = pet
    if (!p || !childAlive(p.child)) return
    let gone = false
    const exited = new Promise((done) => { p.child.once?.('exit', () => { gone = true; done() }) })
    try { p.child.kill() } catch {}
    // kill() 之后 child.killed 立刻为真，但进程要等 exit 事件（或 exitCode）才算真的放手
    const deadline = Date.now() + 8000
    while (!gone && p.child.exitCode === null && p.child.signalCode == null && Date.now() < deadline) await Promise.race([exited, new Promise((r) => setTimeout(r, 100))])
  }

  // ---- 真正的清除（lib/cleanup.js）：每类资源一个删除入口 + 「清除全部数据」
  const cleanup = cfg.cleanup || createCleanup({
    dataDir, clapDir: clapDirOf(), logger,
    hooks: {
      petRunning: () => !!(pet && childAlive(pet.child)),
      stopPet: stopPetAndWait,
      startPet: () => startPet('http://' + (readLastHost() || '127.0.0.1:3080')),
      stopInstaller: () => installer.stop(),
      stopMusic: () => music.stopService(),
      stopReading: () => reading.stopWindow(),
      resetReading: () => reading.reset(),
      autoInstall: (on) => setAutoInstall(on),
      patchSettings: (patch) => { writeSettings(mergeSettings(readSettingsRaw(), patch)); syncTools(); try { music.syncClap() } catch {} },
      // 清除全部数据：停掉所有会往数据目录写东西的后台任务（之后宿主只剩空壳，等用户在 DSH 里卸载）
      stopWriters: () => {
        for (const fn of [() => mail.stop(), () => follow.stop(), () => proactive.stop(), () => quota.stop(), () => calendar.stop(),
          () => music.dispose(), () => reading.dispose(), () => petMusic.dispose(), () => promptChannel.dispose()]) { try { fn() } catch {} }
      },
      markPurged: () => { purged = true },
    },
  })

  // ---- 随 DSH 启动自动拉起桌宠 ----
  //      设置项 autoStart（默认开）。宿主的 host/端口只能在请求里拿到，所以记一份"上次用过的 host"；
  //      没有记录时退回 127.0.0.1:3080（DSH 默认端口）。host 只影响桌宠回调，猜错顶多命令通道不通，桌宠照样出现。
  const lastHostFile = join(dataDir, 'last-host.txt')
  const readLastHost = () => { try { return readFileSync(lastHostFile, 'utf8').trim() } catch { return '' } }
  const rememberHost = (h) => {
    const v = String(h || '').trim()
    if (!v || v === readLastHost()) return
    try { writeFileSync(lastHostFile, v, 'utf8') } catch {}
  }
  ctx.effect(() => {
    if (!readSettings().autoStart) return
    const timer = setTimeout(async () => {
      try {
        await migration
        if (!readSettings().autoStart) return
        if (pet && childAlive(pet.child)) return
        const host = readLastHost() || '127.0.0.1:3080'
        const r = startPet('http://' + host)
        if (r && r.ok === false) logger?.warn?.('[dsh-pixel-pet] 自启桌宠未成功：' + String(r.message || ''))
        else logger?.warn?.('[dsh-pixel-pet] 已随宿主自动启动桌宠（host=' + host + '）')
      } catch (e) {
        logger?.warn?.('[dsh-pixel-pet] 自启桌宠失败：' + String((e && e.message) || e).slice(0, 160))
      }
    }, 3000)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  const readBody = (req, limit) => new Promise((ok, bad) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { bad(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', bad)
  })
  const send = (res, code, obj) => {
    const b = Buffer.from(JSON.stringify(obj))
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
    res.end(b)
  }
  const sendFile = (res, file, type) => {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.wav': 'audio/wav' }
    try {
      const b = readFileSync(file)
      res.writeHead(200, { 'Content-Type': type || types[extname(file)] || 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' })
      res.end(b)
    } catch { res.writeHead(404); res.end() }
  }
  const fhttp = { studio: fstudio, send, sendFile, readBody, imageLimit: IMAGE_LIMIT,
    resolve: (id) => resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: 'furniture', id }),
    resolveCharacter: (id) => resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: 'character', id }),
    imagegenReady: async () => { const v = await imagegenView(); return !!(v.key && v.key.configured) } }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://local')
        const path = url.pathname.slice(PREFIX.length) || '/'
        const host = req.headers.host || '127.0.0.1'
        if (purged && path.startsWith('/api/')) return send(res, 410, { ok: false, code: 'purged', message: '数据已清除，可以在 DSH 里卸载插件了' })
        if (!purged) rememberHost(host)
        if (path.startsWith('/api/cleanup/') && await cleanup.handle(req, res, { path, url, host, send, readBody })) return
        if (path.startsWith('/api/music/') && await music.handle(req, res, { path, url, host, send, readBody })) return
        if (path.startsWith('/api/calendar/')) {
          // origin 校验同其它路由；包关着时 handle 内部 409
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          await calendar.handle(req, res, { path, url, send, readBody, originBase: 'http://' + host + PREFIX })
          return
        }
        if ((path === '/reading' || path.startsWith('/reading/') || path.startsWith('/api/reading/')) && await reading.handle(req, res, {
          path, url, host, send, readBody, base: 'http://' + host + PREFIX + '/',
          // 书架家具等桌宠侧入口：X-PixelPet-Key（与 /api/shot、/api/ask 同一把 key）
          petKeyOk: (r) => !!pet && keyMatches(r.headers['x-pixelpet-key'], pet.key),
        })) return
        if (path === '/api/balance' || path.startsWith('/api/balance/')) {
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          let body = {}
          if (req.method === 'POST') { try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') } catch { return send(res, 400, { ok: false }) } }
          const r = await balance.handle(req.method, path, body)
          return send(res, r.code, r.body)
        }
        if (path === '/api/toolgap' && req.method === 'GET') {
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          return send(res, 200, guard.view())
        }
        if (path === '/api/voiceprint' || path.startsWith('/api/voiceprint/')) {
          let body = {}
          if (req.method === 'POST') {
            if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { ok: false })
            if (Number(req.headers['content-length']) > 4096) return send(res, 413, { ok: false })
            body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
          }
          const r = await vpApi.handle(req.method, path, body, req)
          return send(res, r.code || 200, r.body)
        }
        if (req.method === 'GET') {
          if (path === '/' || path === '/index.html') return sendFile(res, join(WEB_DIR, 'index.html'))
          if (path === '/app.js' || path === '/app.css' || path === '/extras.js' || path === '/extras.css' || path === '/balance.js' || path === '/toolgap.js' || path === '/insight.js' || path === '/insight.css') return sendFile(res, join(WEB_DIR, path.slice(1)))
          // pack avatars on the settings page: web/packs/<name>.png only (no subpaths, no other types)
          { const m = /^\/packs\/([a-z0-9][a-z0-9_-]{0,63})\.png$/.exec(path); if (m) return sendFile(res, join(WEB_DIR, 'packs', m[1] + '.png')) }
          if (path === '/create' || path === '/create.html') return sendFile(res, join(WEB_DIR, url.searchParams.get('kind') === 'furniture' ? 'furniture.html' : 'create.html'))
          if (path === '/furniture.js' || path === '/furniture.css') return sendFile(res, join(WEB_DIR, path.slice(1)))
          if (await furnitureRoutes(req, res, path, url, fhttp)) return
          if (path === '/create.js' || path === '/create.css') return sendFile(res, join(WEB_DIR, path.slice(1)))
          if (path === '/api/imagegen') return send(res, 200, { ok: true, ...(await imagegenView()) })
          if (path === '/api/create/jobs') return send(res, 200, { ok: true, jobs: studio.list() })
          if (path === '/api/create/spec') return send(res, 200, { ok: true, spec: SPEC, customMax: CUSTOM_MAX, customFramesMax: CUSTOM_FRAMES_MAX, durRange: DUR_RANGE })
          const cj = path.match(/^\/api\/create\/([a-z0-9][a-z0-9-]{0,39})(?:\/img\/(ref|upload|cand|raw|frame)(?:\/([A-Za-z0-9_.-]{1,60}))?)?$/)
          if (cj) {
            if (!cj[2]) { const v = studio.view(cj[1]); return v ? send(res, 200, { ok: true, job: v }) : send(res, 404, { ok: false }) }
            const f = studio.file(cj[1], cj[2], cj[3] || '')
            if (f) return sendFile(res, f, 'image/png')
            res.writeHead(404); return res.end()
          }
          if (path === '/card' || path === '/card.html') return sendFile(res, join(WEB_DIR, 'card.html'))
          if (path === '/card.js' || path === '/card.css') return sendFile(res, join(WEB_DIR, path.slice(1)))
          // 日历窗（「日历与日记」拓展包）
          if (path === '/calendar' || path === '/calendar/' || path === '/calendar/index.html') return sendFile(res, join(WEB_DIR, 'calendar', 'index.html'))
          if (path === '/calendar/calendar.js' || path === '/calendar/calendar.css') return sendFile(res, join(WEB_DIR, 'calendar', path.slice(10)))
          if (path === '/api/card/meta') return send(res, 200, { ok: true, name: mailOwner().name })
          if (path === '/mailbox' || path === '/mailbox.html') return sendFile(res, join(WEB_DIR, 'mailbox.html'))
          if (path === '/mailbox.js' || path === '/mailbox.css') return sendFile(res, join(WEB_DIR, path.slice(1)))
          if (path === '/api/mail') {
            const items = mail.store.list({ limit: url.searchParams.get('limit') || 200, before: url.searchParams.get('before') || undefined, starred: url.searchParams.get('starred') === '1' })
            return send(res, 200, { ok: true, items: items.map(publicItem), stats: mail.store.stats(), agently: mail.agentlyStatus(), session: !!readSettings().voice.llm.sessionId, owner: mailOwner() })
          }
          if (path === '/api/mail/unread') return send(res, 200, { ok: true, ...mail.store.stats() })
          // 「跟随外部桥会话」的只读自检口：面板用它画来源表，桥那边的 agent 也用它验收。
          // peer / 会话 id 都已脱敏，只认本机同源。
          if (path === '/api/follow' || path === '/api/follow/integration') {
            if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
            if (path === '/api/follow') return send(res, 200, await follow.snapshot())
            const fraw = readSettingsRaw()
            const picked = follow.sources.find((p) => sourceMatches(p.source, fraw.followSession.source))
            const fdir = followDirOf(dataDir, fraw)
            const text = renderFollowIntegration({
              followDir: fdir,
              apiBase: 'http://' + (readLastHost() || host) + PREFIX,
              channelHint: (picked && picked.channel) || '<channel>',
            })
            return send(res, 200, { ok: true, text, dir: fdir })
          }
          if (path.startsWith('/api/mail/file/')) {
            // the letter id + attachment id come from the store, never from the URL as a path
            const fm = path.match(/^\/api\/mail\/file\/([a-z]-[a-z0-9]+)\/([^/]+)$/)
            let leaf = ''
            try { leaf = fm ? decodeURIComponent(fm[2]) : '' } catch {}
            if (!leaf || /[\/\\\x00-\x1f]/.test(leaf) || leaf === '.' || leaf === '..') { res.writeHead(404); return res.end() }
            const it = fm ? mail.store.get(fm[1]) : null
            const attachment = it?.attachments?.find((a) => a.id === leaf || a.name === leaf)
            const hit = attachment ? findAttachment(mail.dir, it, attachment.id) : null
            if (!hit) { res.writeHead(404); return res.end() }
            let body = readMailFile(join(mail.dir, 'files', it.id), hit.file)
            if (!body) { res.writeHead(404); return res.end() }
            const kind = hit.att.kind
            const isHtml = kind === 'html'
            const isSvg = kind === 'svg'
            let download = url.searchParams.get('dl') === '1'
            const origin = 'http://' + host
            const resourceBase = origin + PREFIX + '/api/mail/file/' + it.id + '/'
            let policy
            if (isHtml && !download) {
              if (url.searchParams.get('raw') === '1') {
                // A raw card is executable only as a frame. Normal address-bar opens download it.
                if (req.headers['sec-fetch-dest'] !== 'iframe') download = true
                policy = attachmentCsp(origin, resourceBase)
              } else {
                const raw = resourceBase + encodeURIComponent(hit.att.id) + '?raw=1'
                body = Buffer.from(cardFrameDocument(raw))
                policy = cardFramePolicy(raw)
              }
            }
            const headers = {
              'Content-Type': download && (isHtml || isSvg) ? 'application/octet-stream' : hit.att.mime,
              'Content-Length': body.length,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              // opening the URL directly must be as contained as the in-page frame: opaque origin, no host access
              ...(isHtml && !download ? { 'Content-Security-Policy': policy } : {}),
              ...(isSvg ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
              'Content-Disposition': disposition(hit.att.filename, !download && kind !== 'pptx'),
              ...(isHtml || isSvg ? { 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off',
                'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), web-share=()' } : {}),
            }
            res.writeHead(200, headers)
            return res.end(body)
          }
          if (path === '/api/mail/agently/guide') return send(res, 200, { ok: true, text: buildAgentlyGuide({ settingsUrl: 'http://' + host + PREFIX + '/' }) })
          if (path === '/api/prompt') {
            const s = readSettings()
            return send(res, 200, {
              ok: true, text: basePrompt(s), default: DEFAULT_PROMPT, custom: !!s.prompt, max: PROMPT_MAX, mode: promptChannel.mode,
              // the paragraph appended after the base text: proactive while 主动一点 is on, else passive
              autonomy: autonomyOn(s),
              proactive: s.autonomy.proactivePrompt || DEFAULT_PROACTIVE, proactiveDefault: DEFAULT_PROACTIVE,
              passive: s.autonomy.passivePrompt || DEFAULT_PASSIVE, passiveDefault: DEFAULT_PASSIVE,
              partMax: PART_MAX, full: effectivePrompt(s),
            })
          }
          if (path === '/api/awareness') {
            // 「当前识别成」 + recent log rows; categories and process names only. Off = nothing asked, nothing read.
            if (!awareness.on()) return send(res, 200, { ok: true, aware: false })
            const now = await petSend({ cmd: 'awareness' }, 3_000).catch(() => null)
            const d = now && now.ok && now.data && typeof now.data === 'object' ? now.data : {}
            return send(res, 200, {
              ok: true, aware: true, state: d.state || null, label: d.label || '', app: d.app || '',
              learned: awareness.learned(), log: url.searchParams.get('log') ? awareness.recent(80) : undefined,
            })
          }
          if (path === '/api/preview') {
            const v = previewOf(PLUGIN_ROOT, dataDir, url.searchParams.get('id') || readSettings().character || 'whale-girl')
            return v ? send(res, 200, { ok: true, ...v }) : send(res, 404, { ok: false })
          }
          const fr = path.match(/^\/api\/frame\/([a-z0-9][a-z0-9-]{0,39})\/([A-Za-z0-9_-]{1,48})\/(\d{1,3})$/)
          if (fr) {
            const file = frameFile(PLUGIN_ROOT, dataDir, fr[1], fr[2], fr[3])
            if (file) return sendFile(res, file, 'image/png')
            res.writeHead(404); return res.end()
          }
          if (path === '/api/state') {
            await migration
            return send(res, 200, {
              migrationNotice,
              // settings 给的是手填值（设置页那个选择框编辑的就是它）；跟随中的有效会话单列一个字段。
              // 两个都是本机同源才看得到，图片/卡片等其它出口从不带会话 id。
              ok: true, settings: readSettingsRaw(),
              effectiveSessionId: follow.effectiveSessionId(),
              followMode: (readSettingsRaw().followSession || {}).mode || 'manual',
              // M0：设置卡片走 packkit 快照单一入口（页面/AI 工具/运行时同一份判定），hidden 只作用于非用户包
              ...(() => { const snap = packSnapshot({ pluginRoot: PLUGIN_ROOT, dataDir, settings: readSettings() }); return { characters: snap.characters.filter((c) => c.user || !c.hidden), furniture: snap.furniture.filter((f) => f.user || !f.hidden) } })(),
              voices: listVoices(dataDir), deps: depsStatus(dataDir), voice: voiceStatus(), sessions: await sessionsList(),
              packs: packsStatus(),
              mail: { ...mail.store.stats(), agently: mail.agentlyStatus() },
              imagegen: await imagegenView(),
              python: python.snapshot(),
              care: proactive.status(),
              pet: { running: !!(pet && childAlive(pet.child)), lastExit: pet && pet.lastExit ? { code: pet.lastExit.code, message: String(pet.lastExit.err || '').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 160) } : null },
            })
          }
          if (path === '/api/voice/status') return send(res, 200, { ok: true, ...voiceStatus() })
          if (path === '/api/packs/status') { await migration; return send(res, 200, { ok: true, ...packsStatus() }) }
          if (path === '/api/relay/status') return send(res, 200, { ok: true, protocol: 1, progressProtocol: 1, timeoutMs: RELAY_LIMITS.DEFAULT_TIMEOUT_MS })
          // 「活动与额度」页签 v2：监测桌宠自己（2026-11-15 改版）。只读聚合；date 非法回 400；
          // 用户的活动日志不再出现在这里（只在「AI 行为」页签的感知日志里看）。
          if (path === '/api/insight/pet') {
            const date = url.searchParams.get('date') || todayKey()
            if (!dayBounds(date)) return send(res, 400, { ok: false, message: 'date 要是 YYYY-MM-DD（真实日历日）' })
            return send(res, 200, { ok: true, date, ...petDay(dataDir, date) })
          }
          if (path === '/api/insight/quota') {
            const date = url.searchParams.get('date') || todayKey()
            const b = dayBounds(date)
            if (!b) return send(res, 400, { ok: false, message: 'date 要是 YYYY-MM-DD（真实日历日）' })
            const d = quotaDay(dataDir, date)
            return send(res, 200, { ok: true, date, configured: quotaConfigured(dataDir), points: d.points, spent: d.spent, first: d.first, last: d.last })
          }
          const w = path.match(/^\/api\/voice\/wav\/(say-\d{1,16}\.wav)$/)
          if (w) return sendFile(res, join(dataDir, 'tts-cache', w[1]))
          const m = path.match(/^\/api\/thumb\/(character|furniture)\/([a-z0-9-]+)$/)
          if (m) {
            // packkit 统一分层：有效用户层的首帧才是卡片该显示的
            const pack = resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: m[1], id: m[2] })
            const d = pack && pack.data
            const st = d && d.states && (d.states[m[1] === 'character' ? 'idle' : d.idle])
            const rel = st && Array.isArray(st.frames) && st.frames[0]
            const file = pack && rel ? packFrame(pack.dir, rel) : null
            if (file) return sendFile(res, file)
            res.writeHead(404); return res.end()
          }
          res.writeHead(404); return res.end()
        }
        if (req.method !== 'POST') { res.writeHead(405); return res.end() }
        if (path === '/api/ask/start' || path === '/api/ask/result') {
          if (!pet || !keyMatches(req.headers['x-pixelpet-key'], pet.key)) return send(res, 401, { ok: false, message: 'unauthorized', delivery: 'not-sent', accepted: false })
          const owner = pet.key // bind authentication before awaits, never to a subsequent pet launch
          let body
          try { body = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8') || '{}') } catch { return send(res, 400, { ok: false, message: 'invalid JSON', delivery: 'not-sent', accepted: false }) }
          if (!pet || pet.key !== owner) return send(res, 401, { ok: false, message: 'launch changed', delivery: 'not-sent', accepted: false })
          const sid = askTarget(body)
          const requestId = body.requestId
          if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) return send(res, 400, { ok: false, message: 'invalid requestId', delivery: 'not-sent', accepted: false })
          noteAskSid(requestId, sid)
          if (path === '/api/ask/result') {
            // progress v1：只有合法的非负整数 afterSeq 才 opt-in（老客户端不传 → 旧心跳语义）
            const afterSeq = Number.isInteger(body.afterSeq) && body.afterSeq >= 0 && body.afterSeq <= 1e9 ? body.afterSeq : undefined
            const r = await relay.result(sid, requestId, { owner, waitMs: body.waitMs, afterAccepted: body.accepted === true, afterSeq })
            if (!pet || pet.key !== owner) return send(res, 401, { ok: false, message: 'launch changed' })
            return send(res, r.code, r.body)
          }
          const text = String(body.text || '').trim().slice(0, 2000)
          const ids = Array.isArray(body.shots) ? body.shots.filter((x) => typeof x === 'string').slice(0, 8) : []
          const fingerprint = createHash('sha256').update(JSON.stringify([sessionKey(sid), text, ids])).digest('hex')
          // Retry checks precede consumed screenshot lookup. A repeated UUID never repeats the task.
          const existing = relay.lookup(requestId, sid, { owner, fingerprint })
          if (existing.code !== 404) return send(res, existing.code, existing.code >= 400 ? { ...existing.body, delivery: 'not-sent', accepted: false } : existing.body)
          try {
            const images = shots.blocks(ids)
            if (!text && !images.length) return send(res, 400, { ok: false, message: 'empty', delivery: 'not-sent', accepted: false })
            const built = await buildContent(ctx, text, images)
            if (!pet || pet.key !== owner) return send(res, 401, { ok: false, message: 'launch changed', delivery: 'not-sent', accepted: false })
            const r = await relay.start(sid, text || '（截图）', built.content, { requestId, owner, fingerprint, source: 'hub' })
            return send(res, r.code, r.code >= 400 ? { ...r.body, delivery: 'not-sent', accepted: false } : { ...r.body, attached: built.attached, dropped: built.dropped, reason: built.reason })
          } catch {
            return send(res, 400, { ok: false, message: '截图或消息准备失败，尚未提交', delivery: 'not-sent', accepted: false })
          } finally { shots.drop(ids) }
        }
        if (path === '/api/ask') {
          if (!pet || !keyMatches(req.headers['x-pixelpet-key'], pet.key)) return send(res, 401, { ok: false, message: 'unauthorized' })
          const body = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8') || '{}')
          const text = String(body.text || '').trim().slice(0, 2000)
          const ids = Array.isArray(body.shots) ? body.shots.filter((x) => typeof x === 'string').slice(0, 8) : []
          if (text) proactive.noteUserActivity() // 桌宠输入条/语音：用户说话了
          try {
            const images = shots.blocks(ids)
            if (!text && !images.length) return send(res, 400, { ok: false, message: 'empty' })
            const built = await buildContent(ctx, text, images)
            const r = await ask(askTarget(body), text || '（截图）', built.content, { source: 'hub' })
            return send(res, r.code, images.length ? { ...r.body, attached: built.attached, dropped: built.dropped, reason: built.reason } : r.body)
          } finally { shots.drop(ids) }
        }
        if (path === '/api/shot') {
          if (!pet || !keyMatches(req.headers['x-pixelpet-key'], pet.key)) return send(res, 401, { ok: false, message: 'unauthorized' })
          if (Number(req.headers['content-length']) > SHOT_LIMIT) return send(res, 413, { ok: false, message: 'too large' })
          let buf
          try { buf = await readBody(req, SHOT_LIMIT) } catch { return send(res, 413, { ok: false, message: 'too large' }) }
          const r = shots.save(buf)
          return send(res, r.code, r.body)
        }
        if (path === '/api/stt') {
          if (!pet || !keyMatches(req.headers['x-pixelpet-key'], pet.key)) return send(res, 401, { ok: false, message: 'unauthorized' })
          const wav = await readBody(req, AUDIO_LIMIT)
          if (wav.length < 46 || wav.toString('latin1', 0, 4) !== 'RIFF') return send(res, 400, { ok: false, message: '不是 wav' })
          const r = await transcribeWithDsh(ctx, wav)
          return send(res, r.code, r.body)
        }
        if (path === '/api/packs/import') {
          // 二进制 .petpack 上传：必须在通用 JSON 预解析之前接住（同 /api/shot 的 raw 处理区）
          // CSRF：先过与 JSON 路由同一套 Origin/Host 一致校验（再加 Sec-Fetch-Site 兜底），且只收
          // application/octet-stream —— 非"简单"类型，跨站页面不经 CORS 预检发不出来，本服务从不应答预检
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          if (['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''))) return send(res, 403, { ok: false })
          if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return send(res, 415, { ok: false, message: '导入只收 application/octet-stream' })
          if (Number(req.headers['content-length']) > PACK_LIMIT) return send(res, 413, { ok: false, message: '包太大（上限 64MB）' })
          const buf = await readBody(req, PACK_LIMIT).catch(() => null)
          if (!buf || !buf.length) return send(res, 400, { ok: false, message: '没有收到包内容' })
          if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return send(res, 400, { ok: false, message: '不是 .petpack（ZIP）容器' })
          const rel = incomingName()
          mkdirSync(join(dataDir, 'packs', dirname(rel)), { recursive: true })
          const staged = join(dataDir, 'packs', rel)
          writeFileSync(staged, buf)
          await migration
          const preset = selectedPreset()
          const r = await packmgr.installFromFile(staged, { enable: url.searchParams.get('enable') === '1' })
          if (r.ok || r.code === 'E_RECEIPT_FAILED') afterPackChange(preset)
          return send(res, r.ok ? 200 : r.code === 'E_RECEIPT_FAILED' ? 502 : 400, { ...r, ...packsStatus() })
        }
        if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
        if (await furnitureRoutes(req, res, path, url, fhttp)) return
        const cb = path.match(/^\/api\/create\/([a-z0-9][a-z0-9-]{0,39})\/(upload|import)$/)
        if (cb) {
          if (Number(req.headers['content-length']) > IMAGE_LIMIT) return send(res, 413, { ok: false, message: '图片太大（上限 20 MB）' })
          let buf
          try { buf = await readBody(req, IMAGE_LIMIT) } catch { return send(res, 413, { ok: false, message: '图片太大（上限 20 MB）' }) }
          const r = cb[2] === 'upload' ? studio.putImage(cb[1], url.searchParams.get('slot'), buf) : studio.importFrame(cb[1], url.searchParams.get('name'), buf)
          return send(res, r.code, r.body)
        }
        if (path === '/api/voice/clone') {
          const buf = await readBody(req, AUDIO_LIMIT)
          const ext = ({ 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg' })[String(req.headers['content-type'] || '').split(';')[0]] || '.wav'
          const tmpDir = join(dataDir, 'tmp'); mkdirSync(tmpDir, { recursive: true })
          const tmp = join(tmpDir, 'ref-' + Date.now() + ext)
          writeFileSync(tmp, buf)
          const name = String(url.searchParams.get('name') || '').slice(0, 40)
          const text = String(url.searchParams.get('text') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400)
          const r = await runPython(['clone', tmp, ...(name ? ['--name', name] : []), ...(text ? ['--text', text] : [])])
          if (r.ok && /^clone-[0-9a-f]{10}$/.test(r.voice)) {
            const s = readSettings(); s.voice = sanitizeVoice(s.voice, { tts: { engine: 'qwen', voice: r.voice } }); writeSettings(s)
          }
          return send(res, 200, r)
        }
        const body = JSON.parse((await readBody(req, BODY_LIMIT)).toString('utf8') || '{}')
        if (path === '/api/open' && body.page === 'card') {
          // the card is no longer a browser page window: the pet opens its own window process
          const r = await petSend({ cmd: 'card', op: 'open' }, 5_000).catch(() => null)
          if (!r || r.running === false) return send(res, 200, { ok: false, message: '桌宠没有在运行，先启动桌宠。' })
          return send(res, 200, { ok: !!r.ok, message: r.message || '' })
        }
        if (path === '/api/open') {
          const pg = pagePath(body.page)
          const h = String(req.headers.host || '')
          if (!pg || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h)) return send(res, 400, { ok: false, message: '打不开这个页面' })
          return send(res, 200, { ok: openPageAndLook('http://' + h + PREFIX + '/' + pg.path, pg.size) })
        }
        if (path === '/api/card/open') {
          // 听歌小卡 is a pywebview window owned by the pet runtime (card_dock.py CardHost): ask the pet to open it
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          const r = await petSend({ cmd: 'card', op: 'open' }, 5_000).catch(() => null)
          if (!r || r.running === false) return send(res, 200, { ok: false, message: '桌宠没有在运行，先启动桌宠。' })
          return send(res, 200, { ok: !!r.ok, message: r.message || '' })
        }
        if (path === '/api/awareness/learn') {
          // 「认不准就学」: <data>/activity.json, keyed by process name; state '' forgets
          if (!awareness.on()) return send(res, 409, { ok: false, message: '先打开「允许感知在做什么」' })
          const l = awareness.learn(body.app, body.state || '')
          return l ? send(res, 200, { ok: true, learned: l }) : send(res, 400, { ok: false, message: '不认识的分类' })
        }
        if (path === '/api/preview/play') {
          const c = loadCharacter(PLUGIN_ROOT, dataDir, typeof body.id === 'string' ? body.id : (readSettings().character || 'whale-girl'))
          const cmd = c && typeof body.state === 'string' ? playCommand(c.data, body.state) : null
          if (!cmd) return send(res, 400, { ok: false, message: '这个动作没法让桌宠演' })
          return send(res, 200, await petSend(cmd))
        }
        if (path === '/api/pack/remove' || path === '/api/pack/restore') {
          const cur = readSettings()
          let patch
          let how = 'restored'
          if (path === '/api/pack/restore') patch = { hidden: { character: [], furniture: [] } }
          else {
            const r = removePack(dataDir, cur, body.kind, body.id)
            how = r.how
            if (!r.ok) return send(res, r.code, { ok: false, message: r.message })
            patch = r.patch
          }
          const next = mergeSettings(cur, patch)
          writeSettings(next)
          syncTools()
          if (patch.furniture) await mail.syncAgently().catch(() => {})
          return send(res, 200, { ok: true, how, settings: next })
        }
        if (path === '/api/settings') {
          await migration
          // 从**原值**合并：body 没给 voice.llm.sessionId 时沿用用户手填值，不会被有效会话覆盖；
          // 给了就按用户的选择写（这是唯一允许改手填值的入口）。
          const patch = { ...body }
          if (body.listen && typeof body.listen === 'object' && !Array.isArray(body.listen)) {
            const { audioDirs, ...listen } = body.listen
            patch.listen = listen
          }
          const next = mergeSettings(readSettingsRaw(), patch)
          writeSettings(next, { keepSessionId: true })
          syncTools()
          if (body.insight) syncInsight() // 额度采样开关随设置即时启停
          if (body.listen) { try { music.syncClap() } catch {}; void petMusic.sync() } // 「听得更细」开关：设置是唯一真源，同步进 clap.json
          if (body.followSession) follow.kick() // 换了模式/来源立刻生效，不用等下一个 tick
          // mailbox furniture on/off also decides whether the Agently watcher should run (M6)
          if (body.mail || body.furniture) await mail.syncAgently().catch(() => {})
          return send(res, 200, { ok: true, settings: next, effectiveSessionId: follow.effectiveSessionId() })
        }
        if (path === '/api/imagegen/key') {
          // the value goes straight to the host's credential store; never into settings, logs or a response
          const value = typeof body.value === 'string' ? body.value.trim() : ''
          if (value.length > 400 || /\s/.test(value)) return send(res, 400, { ok: false, message: 'Key 格式不对' })
          const r = await keys.set(readSettings().imagegen.keyRef, value)
          return send(res, r.ok ? 200 : r.code, r.ok ? { ok: true, ...(await imagegenView()) } : { ok: false, message: r.message })
        }
        if (path === '/api/imagegen/test') return send(res, 200, await images.test())
        if (path === '/api/create/new') {
          const job = studio.create({ name: body.name, desc: body.desc })
          return send(res, 200, { ok: true, job: studio.view(job.id) })
        }
        if (path === '/api/create/reverse' || path === '/api/create/edit') {
          // re-edit an installed pack: read it back into a job (never the author's draft, never the plugin files)
          const pk = resolveOne({ pluginRoot: PLUGIN_ROOT, dataDir, kind: 'character', id: body.id })
          if (!pk) return send(res, 404, { ok: false, message: '没找到这个角色' })
          const r = studio.reverse({ id: pk.id, dir: pk.dir, data: pk.data, base: pk.base, installed: pk.base === 'user' })
          return send(res, r.code, r.body)
        }
        const cp = path.match(/^\/api\/create\/([a-z0-9][a-z0-9-]{0,39})\/(meta|candidates|pick|run|stop|build|install|delete)$/)
        if (cp) {
          const [, id, op] = cp
          let r
          if (op === 'meta') { const j = studio.update(id, body); r = j ? { code: 200, body: { ok: true } } : { code: 404, body: { ok: false } } }
          else if (op === 'candidates') r = await studio.candidates(id, { n: body.n || readSettings().imagegen.candidates, useUpload: body.useUpload === true })
          else if (op === 'pick') r = studio.pick(id, body.candidate)
          else if (op === 'run') r = studio.run(id, { keys: body.keys, confirm: body.confirm })
          else if (op === 'stop') r = studio.stop(id)
          else if (op === 'build') r = await studio.build(id)
          else if (op === 'install') r = studio.install(id)
          else r = studio.remove(id)
          const v = op === 'delete' ? null : studio.view(id)
          return send(res, r.code, v ? { ...r.body, job: v } : r.body)
        }
        if (path === '/api/mail/read') {
          const ids = body.all === true ? 'all' : Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 400) : []
          const changed = mail.store.markRead(ids)
          return send(res, 200, { ok: true, changed, ...mail.store.stats() })
        }
        if (path === '/api/mail/write') {
          const text = typeof body.body === 'string' ? body.body.trim().slice(0, 20000) : ''
          if (!text) return send(res, 400, { ok: false, message: 'empty' })
          const key = typeof body.key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.key) ? body.key : undefined
          proactive.noteUserActivity() // 用户给桌宠写了信
          return send(res, 200, { ok: true, item: publicItem(mail.write(text, key)) })
        }
        if (path === '/api/mail/star' || path === '/api/mail/delete' || path === '/api/mail/clear') {
          const r = mail.manage(path.slice(10), body)
          return send(res, r.ok ? 200 : 404, r.item ? { ...r, item: publicItem(r.item) } : r)
        }
        if (path === '/api/mail/open') {
          // only a copied attachment of a stored letter, only on an explicit click, only PDFs (never HTML/SVG)
          const it = typeof body.id === 'string' ? mail.store.get(body.id) : null
          const hit = it ? findAttachment(mail.dir, it, body.att) : null
          if (!hit) return send(res, 404, { ok: false, message: '没有这个附件' })
          if (hit.att.kind !== 'pdf') return send(res, 400, { ok: false, message: '这种附件不交给系统程序打开' })
          const ok = openFile(hit.file)
          return send(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, message: '打不开' })
        }
        if (path === '/api/mail/retry') {
          const it = typeof body.id === 'string' ? mail.retry(body.id) : null
          return it ? send(res, 200, { ok: true, item: publicItem(it) }) : send(res, 404, { ok: false })
        }
        if (path === '/api/mail/agently/guide/send') {
          const r = await relay.post(readSettings().voice.llm.sessionId, buildAgentlyGuide({ settingsUrl: 'http://' + host + PREFIX + '/' }))
          return send(res, r.code, r.body)
        }
        if (path === '/api/mail/agently/probe') {
          const a = readSettings().mail.agently
          const be = mail.agently || mail.agentlyFactory({ workDir: join(mail.dir, 'agently-work'), command: a.command || undefined })
          const health = await be.health()      // a good probe re-arms the watcher, so 「已连接」 always has a process behind it
          const me = health === 'ok' ? await be.me() : { ok: false, code: health }
          return send(res, 200, { ok: me.ok === true, health, aliases: me.aliases || [] })
        }
        if (path === '/api/mail/agently/reauth') {
          // runs the user's own `agently-cli auth login`, hands the link to the system browser; the link never
          // comes back to the page and is never written anywhere. Only a click reaches this.
          if (req.headers.origin && req.headers.origin !== 'http://' + host) return send(res, 403, { ok: false })
          const r = await mail.reauth({ urlWaitMs: 8000 })
          return send(res, r.ok ? 200 : 400, r)
        }
        if (path === '/api/pet/start') { await migration; return send(res, 200, startPet('http://' + host)) }
        if (path === '/api/pet/stop') return send(res, 200, stopPet())
        if (path === '/api/python/prepare') {
          // "重新准备运行时": forget what was resolved and redo it (installing the runtime if needed).
          // Answers at once — the settings page follows `python` in /api/state.
          python.prepare().then(() => { if (pendingStart && !pet) prepareThenStart(pendingStart) }).catch(() => {})
          return send(res, 200, { ok: true, preparing: true, python: python.snapshot() })
        }
        if (path === '/api/deps/download' || path === '/api/voice/install') {
          setAutoInstall(true)
          const r = installer.start()
          return send(res, r.ok ? 200 : 500, { ...r, ...voiceStatus() })
        }
        // ---- 拓展包（M1）：手动下载 / 卸载（JSON 区；导入在上方 raw 区，pack_cli.py 完成事务，packmgr 收运行时回执）
        if (path === '/api/packs/install') {
          await migration
          const preset = selectedPreset()
          const r = await packmgr.installFromCatalog(typeof body.packId === 'string' ? body.packId : '', { enable: body.enable === true })
          if (r.ok || r.code === 'E_RECEIPT_FAILED') afterPackChange(preset)
          return send(res, r.ok ? 200 : r.code === 'E_RECEIPT_FAILED' ? 502 : 400, { ...r, ...packsStatus() })
        }
        // 确认权限并启用 / 停用（pack_cli 写授权与启用意图；启用以运行时回执为准）
        if (path === '/api/packs/grant' || path === '/api/packs/disable') {
          const id = typeof body.packId === 'string' ? body.packId : ''
          await migration
          const selected = readSettingsRaw().character
          const wasSelected = packedCharacter(selected)?.pack === id
          const preset = selectedPreset()
          const r = await (path === '/api/packs/grant' ? packmgr.grant(id) : packmgr.disable(id))
          if (r.ok && wasSelected && path === '/api/packs/disable') fallbackCharacter(selected)
          if (r.ok || r.code === 'E_RECEIPT_FAILED') afterPackChange(preset)
          return send(res, r.ok ? 200 : r.code === 'E_RECEIPT_FAILED' ? 502 : 400, { ...r, ...packsStatus() })
        }
        if (path === '/api/packs/uninstall') {
          await migration
          const id = typeof body.packId === 'string' ? body.packId : ''
          const selected = readSettingsRaw().character
          const wasSelected = packedCharacter(selected)?.pack === id
          const preset = selectedPreset()
          const r = await packmgr.uninstall(id)
          if (r.ok && wasSelected) fallbackCharacter(selected)
          if (r.ok && Array.isArray(r.furnitureIds) && r.furnitureIds.length) {
            // 卸载后清掉这些家具的开关记忆（settings.furniture 只认 enabled，键留给用户版家具）
            const s = readSettings()
            for (const fid of r.furnitureIds) delete s.furniture?.[fid]
            writeSettings(s)
          }
          if (r.ok) {
            if (id === claudePack) {
              // An explicit uninstall also opts out of bringing the bed back on a later boot.
              try { claimPackMigration(bedMigration) } catch (err) { logger?.warn?.('[dsh-pixel-pet] ' + String(err?.message || err)) }
            }
            afterPackChange(preset)
          }
          return send(res, r.ok ? 200 : 400, { ...r, ...packsStatus() })
        }
        // 设置页「清理旧版本」：不等保留期，立刻清掉这个包的 previous（回滚随之不可用）
        if (path === '/api/packs/prune') {
          await migration
          const r = await packmgr.prunePrevious({ packId: typeof body.packId === 'string' ? body.packId : '', force: true })
          return send(res, r.ok ? 200 : 400, { ...r, ...packsStatus() })
        }
        if (path === '/api/voice/delete') {
          if (typeof body.id !== 'string' || !/^clone-[0-9a-f]{10}$/.test(body.id)) return send(res, 400, { ok: false })
          const gone = purge(join(dataDir, 'voices', body.id), { roots: [dataDir] })
          if (!gone.ok) return send(res, gone.code === 'busy' ? 409 : 500, { ok: false, code: gone.code, message: gone.code === 'busy' ? '有程序还在用，关掉桌宠再试' : '没删掉' })
          const s = readSettings()
          if (s.voice.tts.voice === body.id) { s.voice = sanitizeVoice(s.voice, { tts: { voice: 'whale-girl' } }); writeSettings(s) }
          return send(res, 200, { ok: true })
        }
        if (path === '/api/voice/test') {
          const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 120) : '你好呀，我在这儿。'
          const r = await runPython(['say', text])
          return send(res, 200, r.ok ? { ok: true, wav: r.wav, seconds: r.seconds } : r)
        }
        res.writeHead(404); return res.end()
      } catch (e) {
        // a JSON.parse message quotes the body (could be a pasted key): log the kind only
        logger?.warn?.('[dsh-pixel-pet] ' + (e instanceof SyntaxError ? 'bad request body' : String(e && e.message || e).slice(0, 200)))
        return send(res, 500, { ok: false, message: 'error' })
      }
    },
  }))

  ctx.effect(() => () => { stopPet(); relay.dispose(); try { shots.clear() } catch {} })
}
