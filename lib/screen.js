/**
 * pixelpet_screen: screen sense for the pointed session (registered with the other pixelpet_* tools).
 *
 * Gates: settings.aiControl (all pet tools) and settings.screen (this tool, default off). The pet re-checks
 * settings.screen itself (runtime/pixelpet/screen.py). A snapshot comes back from the pet as base64 JPEG in
 * memory, is handed to DSH's attachments service as the tool result's image and dropped here — the plugin
 * never writes it anywhere.
 */
import { imageKind } from './hub.js'

export const SCREEN_OFF = '用户关闭了「屏幕感知」，现在不能看屏幕。'
export const AI_OFF = '设置页已关闭「让 AI 指挥桌宠」。'
const SHOT_PER_MINUTE = 8
const SHOT_TIMEOUT_MS = 40_000
const TYPES = { png: 'image/png', jpg: 'image/jpeg' }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const SCREEN_DESCRIPTION =
  '看用户的屏幕。mode=windows：列出可见窗口（标题、进程、位置、是否前台）和显示器，不截画面，优先用它；' +
  'mode=shot：截一张屏幕快照（缩小并画上坐标网格，刻度就是屏幕坐标），看图标、按钮等画面内容时用。' +
  '坐标系：所有 x、y、w、h 都是屏幕坐标，和 pixelpet_move 的 x、y 是同一套（主显示器左上角为 0,0，副屏可能为负；' +
  '多显示器和缩放已换算好），从网格或窗口矩形读到的点可直接交给 pixelpet_move。' +
  '默认拍桌宠所在的显示器；monitor 选显示器（windows 结果里的 index，-1 为全部），region 只拍一块。截图时桌宠自己默认不入镜。'

export const SCREEN_PARAMETERS = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['windows', 'shot'], description: 'windows=窗口列表，shot=截图' },
    monitor: { type: 'integer', description: 'shot：显示器 index，-1 为全部' },
    region: {
      type: 'object', description: 'shot：只拍这一块（屏幕坐标）',
      properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
      required: ['x', 'y', 'w', 'h'], additionalProperties: false,
    },
    hidePet: { type: 'boolean', description: 'shot：截图时隐藏桌宠，默认 true' },
  },
  required: ['mode'],
  additionalProperties: false,
}

/** args -> control body | string (refusal) */
export function buildScreen (a) {
  if (a.mode === 'windows') return { cmd: 'screen', mode: 'windows' }
  if (a.mode !== 'shot') return 'mode 用 windows 或 shot。'
  const body = { cmd: 'screen', mode: 'shot' }
  if (num(a.monitor) !== undefined) body.monitor = Math.round(a.monitor)
  if (a.region && typeof a.region === 'object') {
    const r = a.region
    if ([r.x, r.y, r.w, r.h].some((v) => num(v) === undefined)) return 'region 要有数字 x、y、w、h。'
    body.region = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }
  }
  if (a.hidePet === false) body.hidePet = false
  return body
}

/** image bytes -> an image content block that references DSH's attachment store, or null */
export async function admitImage (svc, buf, name) {
  const kind = imageKind(buf)
  if (!svc || !kind) return null
  const mediaType = TYPES[kind]
  if (typeof svc.saveImage === 'function') {
    try {
      const ref = await svc.saveImage({ data: buf, mediaType, name })
      if (ref && ref.attachmentId) return { type: 'image', attachment: ref }
    } catch {}
  }
  if (typeof svc.admitPromptContent === 'function') {
    try {
      const out = await svc.admitPromptContent([{ type: 'image', data: buf.toString('base64'), mediaType, name }])
      const img = Array.isArray(out) ? out.find((b) => b && b.type === 'image') : null
      if (img) return img
    } catch {}
  }
  return null
}

const output = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render (_args, v) {
    if (!v || typeof v !== 'object') return [{ type: 'text', text: String(v) }]
    const text = v.data === undefined ? String(v.message) : String(v.message) + '\n' + JSON.stringify(v.data, null, 2)
    return v.image ? [{ type: 'text', text }, v.image] : [{ type: 'text', text }]
  },
}

/**
 * @param {{ dataDir: string, enabled: () => boolean, screenEnabled: () => boolean, send: Function,
 *           attachments: () => any, now?: () => number }} o
 */
export function makeScreenTool ({ dataDir, enabled, screenEnabled, send, attachments, now = () => Date.now() }) {
  const shots = []
  return {
    name: 'pixelpet_screen',
    description: SCREEN_DESCRIPTION,
    parameters: SCREEN_PARAMETERS,
    output,
    timeoutMs: 50_000,
    async execute (args) {
      if (!enabled()) return { ok: false, message: AI_OFF }
      if (!screenEnabled()) return { ok: false, message: SCREEN_OFF }
      const body = buildScreen(args && typeof args === 'object' ? args : {})
      if (typeof body === 'string') return { ok: false, message: body }
      if (body.mode === 'shot') {
        const t = now()
        while (shots.length && t - shots[0] > 60_000) shots.shift()
        if (shots.length >= SHOT_PER_MINUTE) return { ok: false, message: '一分钟内截图太多了，歇一会儿，或先用 mode=windows。' }
        shots.push(t)
      }
      const r = await send(dataDir, body, SHOT_TIMEOUT_MS)
      if (!r || !r.ok || body.mode !== 'shot') return r
      const data = { ...(r.data || {}) }
      const img = data.image
      delete data.image
      let buf = null
      try { buf = img && typeof img.base64 === 'string' ? Buffer.from(img.base64, 'base64') : null } catch { buf = null }
      if (!buf) return { ok: false, message: '桌宠没交回截图。' }
      let svc = null
      try { svc = attachments() } catch { svc = null }
      const block = await admitImage(svc, buf, 'screen-' + t36() + (imageKind(buf) === 'png' ? '.png' : '.jpg'))
      buf.fill(0)
      if (!block) return { ok: false, message: 'DSH 没有可用的图片附件服务，截图没发出去。' }
      return { ok: true, message: r.message, data: { ...data, image: { width: img.width, height: img.height } }, image: block }
    },
  }
}

const t36 = () => Date.now().toString(36)
