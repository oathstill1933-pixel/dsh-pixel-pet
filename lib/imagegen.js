/**
 * Image generation client (Node side only; the settings page never talks to the provider directly).
 *
 * One interface for every provider: createImageClient(...).generate({ prompt, n, references }) -> PNG/JPEG/WebP
 * buffers, .test() -> { ok, model, listed } | { ok: false, code, message }. Callers (create.js, furniture-create.js)
 * never see which provider is behind it.
 *
 * Providers (PROVIDERS below):
 *   openai      https://api.openai.com/v1, model gpt-image-2 (fixed)
 *   compatible  any OpenAI-compatible endpoint: user-filled base URL + model name
 *   doubao      Volcengine Ark (火山方舟) Seedream, OpenAI-like JSON but its own fields
 *                 POST {base}/images/generations, Authorization: Bearer <ARK_API_KEY>
 *                 body: model, prompt, image (string | string[] of URL or data:image/...;base64), size ("1K"/"2K"/...
 *                 or "WxH"), response_format "b64_json" | "url" (url valid 24 h), watermark, output_format.
 *                 No `n`: one image per call (sequential_image_generation is a "group of related images" mode,
 *                 not independent candidates, and pro/flash models don't support it), so we loop.
 *                 Errors: { error: { code, message } } — AuthenticationError 401, AccountOverdueError 403,
 *                 ModelNotOpen 404, RateLimitExceeded.* / AccountRateLimitExceeded 429,
 *                 Input/OutputImage/TextSensitiveContentDetected 400.
 *                 Probe: GET {base}/models (lists models, generates nothing).
 *                 Docs: https://www.volcengine.com/docs/82379/1541523  (图片生成 API)
 *                       https://www.volcengine.com/docs/82379/1824121  (图片生成教程，模型列表与尺寸)
 *                       https://www.volcengine.com/docs/82379/1299023  (错误码)
 *                       https://docs.volcengine.com/docs/ark/models-api (Models API)
 *   gemini      Google Gemini API image models ("Nano Banana")
 *                 POST {base}/models/{model}:generateContent, header x-goog-api-key
 *                 body: contents[0].parts = [{ inlineData: { mimeType, data } }..., { text }],
 *                 generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize } }
 *                 Image bytes: candidates[].content.parts[].inlineData.data (base64) + mimeType.
 *                 Blocked: promptFeedback.blockReason (SAFETY / PROHIBITED_CONTENT / IMAGE_SAFETY / ...), or
 *                 candidates[].finishReason (SAFETY, IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT, NO_IMAGE, ...).
 *                 candidateCount is unsupported on Gemini 3 image models, so we loop.
 *                 Probe: GET {base}/models (validates the key only; no generation, no charge).
 *                 Docs: https://ai.google.dev/gemini-api/docs/image-generation (now aistudio.google.com/docs/image-generation)
 *                       https://aistudio.google.com/api-reference/generate-content
 *                       https://aistudio.google.com/docs/models
 *                       https://aistudio.google.com/docs/troubleshooting
 *                       https://aistudio.google.com/docs/api-errors
 *
 * The key is never part of settings. settings.imagegen.keyRef names it (an environment-variable-shaped
 * reference; per-provider default OPENAI_API_KEY / ARK_API_KEY / GEMINI_API_KEY). It is resolved per request through
 * DSH's credential store (ctx.credentials: stored value first, then the launch environment and .env files) when the
 * host has one, otherwise from process.env. Nothing here logs, returns or writes the value; provider error text is
 * scrubbed of it before it reaches a message.
 */

export const OPENAI_BASE = 'https://api.openai.com/v1'
export const OPENAI_MODEL = 'gpt-image-2'
export const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
export const SEEDREAM_MODEL = 'doubao-seedream-5-0-flash-260915'
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_MODEL = 'gemini-3.1-flash-image'
export const PROVIDERS = {
  openai: { baseUrl: OPENAI_BASE, model: OPENAI_MODEL, keyRef: 'OPENAI_API_KEY', fixed: true },
  compatible: { baseUrl: '', model: OPENAI_MODEL, keyRef: 'OPENAI_API_KEY' },
  doubao: { baseUrl: ARK_BASE, model: SEEDREAM_MODEL, keyRef: 'ARK_API_KEY' },
  gemini: { baseUrl: GEMINI_BASE, model: GEMINI_MODEL, keyRef: 'GEMINI_API_KEY' },
}
export const PROVIDER_IDS = Object.keys(PROVIDERS)
export const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// baseUrl / model: '' = the provider default. profiles: what the user set per provider, restored on switching back.
export const DEFAULT_IMAGEGEN = { provider: 'openai', baseUrl: '', model: '', keyRef: 'OPENAI_API_KEY', size: '1024x1024', candidates: 4, profiles: {} }
const SIZES = ['1024x1024', '1536x1536', '2048x2048']
const MODEL_RE = /^[\w.:/@-]{0,80}$/

/** appended for providers that can't reliably give a transparent background; the converter keys out #00FF00 */
export const KEYING_SUFFIX = '\n\n背景：纯色 #00FF00 绿底，无阴影，无渐变背景，无地面。Background: flat solid #00FF00 green only, no shadow, no gradient.' +
  '\n像素风：清晰方形像素、统一像素网格、有限色板、深色描边，无抗锯齿、无模糊。Pixel art: crisp square pixels on one grid, limited palette, no anti-aliasing, no blur.'
export const decoratePrompt = (provider, prompt) => (provider === 'doubao' || provider === 'gemini') ? String(prompt || '') + KEYING_SUFFIX : String(prompt || '')

const cleanBase = (v) => {
  if (typeof v !== 'string') return undefined
  const u = v.trim().replace(/\/+$/, '')
  if (!u) return ''
  return validBase(u) ? u : undefined
}
const cleanModel = (v) => (typeof v === 'string' && MODEL_RE.test(v.trim()) ? v.trim() : undefined)
const cleanRef = (v) => (typeof v === 'string' && v.trim().length <= 64 && REF_RE.test(v.trim()) ? v.trim() : undefined)
function cleanProfile (p, id) {
  const o = { baseUrl: '', model: '', keyRef: PROVIDERS[id].keyRef }
  if (!p || typeof p !== 'object') return o
  const b = cleanBase(p.baseUrl); if (b !== undefined) o.baseUrl = b
  const m = cleanModel(p.model); if (m !== undefined) o.model = m
  const r = cleanRef(p.keyRef); if (r) o.keyRef = r
  return o
}

export function sanitizeImagegen (cur, patch) {
  const out = { ...DEFAULT_IMAGEGEN, ...(cur && typeof cur === 'object' ? pick(cur) : {}) }
  if (patch && typeof patch === 'object') {
    if (PROVIDER_IDS.includes(patch.provider) && patch.provider !== out.provider) {
      // stash the outgoing provider's fields, bring back (or default) the incoming one's
      out.profiles = { ...out.profiles, [out.provider]: { baseUrl: out.baseUrl, model: out.model, keyRef: out.keyRef } }
      const p = cleanProfile(out.profiles[patch.provider], patch.provider)
      out.provider = patch.provider; out.baseUrl = p.baseUrl; out.model = p.model; out.keyRef = p.keyRef
    }
    const b = cleanBase(patch.baseUrl); if (b !== undefined) out.baseUrl = b
    const m = cleanModel(patch.model); if (m !== undefined) out.model = m
    const r = cleanRef(patch.keyRef); if (r) out.keyRef = r
    if (SIZES.includes(patch.size)) out.size = patch.size
    if (Number.isInteger(patch.candidates) && patch.candidates >= 1 && patch.candidates <= 4) out.candidates = patch.candidates
  }
  out.profiles = { ...out.profiles, [out.provider]: { baseUrl: out.baseUrl, model: out.model, keyRef: out.keyRef } }
  return out
}
// only known fields survive (anything else in an old settings.json — e.g. a pasted key — is dropped)
function pick (o) {
  const r = {}
  for (const k of Object.keys(DEFAULT_IMAGEGEN)) if (k in o) r[k] = o[k]
  if (!PROVIDER_IDS.includes(r.provider)) delete r.provider
  const id = r.provider || DEFAULT_IMAGEGEN.provider
  if ('baseUrl' in r) r.baseUrl = cleanBase(r.baseUrl) || ''   // an old saved http://remote is not trusted either
  if ('model' in r) r.model = cleanModel(r.model) || ''
  if ('keyRef' in r) r.keyRef = cleanRef(r.keyRef) || PROVIDERS[id].keyRef
  if (!SIZES.includes(r.size)) delete r.size
  if (!(Number.isInteger(r.candidates) && r.candidates >= 1 && r.candidates <= 4)) delete r.candidates
  const profiles = {}
  if (r.profiles && typeof r.profiles === 'object') for (const p of PROVIDER_IDS) if (r.profiles[p]) profiles[p] = cleanProfile(r.profiles[p], p)
  r.profiles = profiles
  return r
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** https anywhere; plain http only to this machine (the key travels in a request header) */
export function validBase (u) {
  try {
    const p = new URL(u)
    if (p.username || p.password || u.length > 300) return false
    if (p.protocol === 'https:') return true
    return p.protocol === 'http:' && LOOPBACK.has(p.hostname.toLowerCase())
  } catch { return false }
}

export function endpointOf (cfg) {
  const c = sanitizeImagegen(cfg, {})
  const d = PROVIDERS[c.provider]
  if (d.fixed) return { provider: c.provider, base: d.baseUrl, model: d.model }
  return { provider: c.provider, base: c.baseUrl || d.baseUrl, model: c.model || d.model }
}

/** credential access: DSH store when present, else process env. Returns helpers that never expose the value. */
export function createKeyStore (ctx, env = process.env) {
  const svc = () => { try { const s = ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : ctx && ctx.credentials; return s && typeof s.resolve === 'function' ? s : null } catch { return null } }
  return {
    get kind () { return svc() && typeof svc().set === 'function' ? 'dsh' : 'env' },
    async resolve (ref) {
      if (!REF_RE.test(String(ref || ''))) return ''
      const s = svc()
      if (s) { try { const hit = await s.resolve(ref); if (hit && typeof hit.value === 'string' && hit.value) return hit.value } catch {} }
      const v = env[ref]
      return typeof v === 'string' ? v.trim() : ''
    },
    async describe (ref) {
      if (!REF_RE.test(String(ref || ''))) return { configured: false, store: this.kind }
      const s = svc()
      if (s && typeof s.describe === 'function') {
        try { const d = await s.describe(ref); return { configured: !!(d && d.configured), source: d && d.source ? String(d.source).slice(0, 40) : undefined, store: 'dsh' } } catch {}
      }
      return { configured: !!(typeof env[ref] === 'string' && env[ref].trim()), source: env[ref] ? 'env' : undefined, store: 'env' }
    },
    async set (ref, value) {
      const s = svc()
      if (!s || typeof s.set !== 'function') return { ok: false, code: 501, message: '没有密钥存储，请用环境变量' }
      if (!REF_RE.test(String(ref || ''))) return { ok: false, code: 400, message: '变量名不对' }
      try {
        if (value) await s.set(ref, value); else if (typeof s.unset === 'function') await s.unset(ref)
      } catch { return { ok: false, code: 500, message: '保存失败' } }
      return { ok: true }
    },
  }
}

export class ImageGenError extends Error {
  constructor (code, message, status) { super(message); this.code = code; this.status = status }
}

const POLICY_RE = /safety|moderation|content_policy|SensitiveContent|PROHIBITED|BLOCKLIST|content_blocked/i
const QUOTA_RE = /insufficient_quota|billing|balance|credit|Overdue|QuotaExceeded|quota_exceeded|payment_required|欠费|余额/i

/** provider response / network failure -> readable Chinese message (never echoes request headers or the key) */
export function explain (status, body, err, secret) {
  if (err) {
    const c = (err.name === 'TimeoutError' || err.name === 'AbortError') ? err.name : (typeof err.code === 'string' && err.code) || (err.cause && err.cause.code) || err.name
    if (c === 'TimeoutError' || c === 'AbortError' || c === 'timeout') return new ImageGenError('timeout', '请求超时，出图服务没有及时响应')
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new ImageGenError('network', '找不到服务器，检查地址或网络')
    if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'UND_ERR_SOCKET' || c === 'ETIMEDOUT' || c === 'UND_ERR_CONNECT_TIMEOUT') return new ImageGenError('network', '连不上出图服务')
    if (c === 'nokey') return new ImageGenError('nokey', err.message)
    return new ImageGenError('network', '网络错误：' + String(c || '未知').slice(0, 40))
  }
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {}
  // OpenAI: code/type strings; Ark: code like "AuthenticationError"; Google: numeric code + status + details[].reason
  const reasons = Array.isArray(e.details) ? e.details.map((d) => d && d.reason).filter(Boolean).join(' ') : ''
  const code = [typeof e.code === 'string' ? e.code : '', e.type, e.status, reasons].filter((x) => typeof x === 'string' && x).join(' ')
  let raw = typeof e.message === 'string' ? e.message : ''
  if (secret && secret.length >= 4) raw = raw.split(secret).join('…')
  raw = raw.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-…').replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…').slice(0, 160)
  const all = code + ' ' + raw
  if (status === 401 || /AuthenticationError|API_KEY_INVALID|invalid_api_key|API key not valid|\bauthentication\b/i.test(code) || (status === 400 && /API key not valid|API_KEY_INVALID/i.test(all))) return new ImageGenError('auth', 'Key 无效或已过期（' + (status || 401) + '）', status)
  if (QUOTA_RE.test(code + ' ' + raw.replace(/check your plan and billing details/i, '')) || status === 402) return new ImageGenError('quota', '余额不足或额度用完，请到服务商后台充值', status)
  if (status === 429) return new ImageGenError('rate', '请求太频繁，被限流了（429），稍后再试' + (/quota/i.test(raw) ? '；也可能是免费额度用完' : ''), status)
  if (POLICY_RE.test(code) || (status === 400 && POLICY_RE.test(raw))) return new ImageGenError('policy', '提示词或参考图被安全策略拦截', status)
  if (/ModelNotOpen/i.test(code)) return new ImageGenError('notopen', '这个模型还没开通，到火山方舟控制台「开通管理」里开通', status)
  if (/location is not supported|FAILED_PRECONDITION/i.test(all)) return new ImageGenError('region', '所在地区不能用这个服务（' + status + '）', status)
  if (status === 403) return new ImageGenError('forbidden', '没有权限使用这个模型（403）' + (raw ? '：' + raw : ''), status)
  if (status === 404) return new ImageGenError('notfound', '接口或模型不存在（404），检查地址和模型名', status)
  if (status >= 500) return new ImageGenError('server', '出图服务出错（' + status + '）', status)
  return new ImageGenError('bad', '请求被拒绝（' + status + '）' + (raw ? '：' + raw : ''), status)
}

const BLOCK_RE = /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/
/** Gemini answered 200 but without an image: blocked prompt, blocked output, or simply no image */
function geminiNoImage (body) {
  const pf = body && body.promptFeedback
  if (pf && pf.blockReason && pf.blockReason !== 'BLOCK_REASON_UNSPECIFIED') return new ImageGenError('policy', '提示词或参考图被安全策略拦截（' + String(pf.blockReason).slice(0, 40) + '）')
  const fr = body && Array.isArray(body.candidates) ? body.candidates.map((c) => c && c.finishReason).filter(Boolean) : []
  const hit = fr.find((r) => BLOCK_RE.test(r))
  if (hit) return new ImageGenError('policy', '生成的图被安全策略拦截（' + String(hit).slice(0, 40) + '）')
  if (fr.includes('NO_IMAGE') || fr.includes('IMAGE_OTHER')) return new ImageGenError('empty', '模型这次没有画出图片，换个说法再试')
  return new ImageGenError('empty', '服务没有返回图片')
}

const dataUri = (buf) => 'data:' + (imageType(buf) || 'image/png') + ';base64,' + buf.toString('base64')
const geminiSize = (s) => (s === '1024x1024' ? '1K' : '2K')

/**
 * @param {{ settings: () => object, keys: ReturnType<typeof createKeyStore>, fetch?: typeof fetch, timeoutMs?: number, testTimeoutMs?: number }} o
 */
export function createImageClient ({ settings, keys, fetch: fetchImpl = globalThis.fetch, timeoutMs = 180_000, testTimeoutMs = 15_000 }) {
  const prep = async () => {
    const cfg = sanitizeImagegen(settings(), {})
    const ep = endpointOf(cfg)
    if (!ep.base) throw new ImageGenError('config', '还没填接口地址')
    const key = await keys.resolve(cfg.keyRef)
    if (!key) throw new ImageGenError('nokey', keys.kind === 'dsh' ? '还没设置 Key' : '环境变量 ' + cfg.keyRef + ' 没有值')
    return { cfg, ep, key }
  }
  const call = async (url, init, ms, key) => {
    let res
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) }) } catch (e) { throw explain(0, null, e) }
    let body = null
    let text = ''
    try { text = await res.text() } catch (e) { throw explain(0, null, e) }
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok) throw explain(res.status, body, null, key)
    return body
  }
  const download = async (url) => {
    let r
    try { r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }) } catch (e) { throw explain(0, null, e) }
    if (!r.ok) throw explain(r.status, null)
    return Buffer.from(await r.arrayBuffer())
  }
  /** OpenAI-shaped data[] -> buffers (b64_json or a URL to fetch) */
  const fromData = async (body, key) => {
    const items = body && Array.isArray(body.data) ? body.data : []
    const out = []
    let itemErr = null
    for (const it of items) {
      if (it && typeof it.b64_json === 'string' && it.b64_json) out.push(Buffer.from(it.b64_json, 'base64'))
      else if (it && typeof it.url === 'string' && /^https?:/.test(it.url)) out.push(await download(it.url))
      else if (it && it.error) itemErr = itemErr || explain(400, { error: it.error }, null, key)
    }
    if (!out.length && itemErr) throw itemErr
    if (!out.length && body && body.error) throw explain(400, body, null, key)
    return out
  }

  // ---- adapters: each does one provider's probe and generation; the wrapper below does the shared checks
  const adapters = {
    openai: {
      async test ({ ep, key }) {
        const body = await call(ep.base + '/models', { headers: { Authorization: 'Bearer ' + key } }, testTimeoutMs, key)
        const ids = body && Array.isArray(body.data) ? body.data.map((m) => m && m.id).filter(Boolean) : []
        return { listed: ids.length ? ids.includes(ep.model) : null }
      },
      async generate ({ cfg, ep, key }, { prompt, n, references }) {
        const auth = { Authorization: 'Bearer ' + key }
        let body
        if (references.length) {
          const form = new FormData()
          form.append('model', ep.model); form.append('prompt', prompt); form.append('n', String(n)); form.append('size', cfg.size)
          for (const r of references) form.append('image[]', new Blob([r.data], { type: imageType(r.data) || 'image/png' }), r.name || 'ref.png')
          body = await call(ep.base + '/images/edits', { method: 'POST', headers: auth, body: form }, timeoutMs, key)
        } else {
          body = await call(ep.base + '/images/generations', {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ep.model, prompt, n, size: cfg.size }),
          }, timeoutMs, key)
        }
        return fromData(body, key)
      },
    },
    doubao: {
      async test ({ ep, key }) {
        const body = await call(ep.base + '/models', { headers: { Authorization: 'Bearer ' + key } }, testTimeoutMs, key)
        const ids = body && Array.isArray(body.data) ? body.data.map((m) => m && m.id).filter(Boolean) : []
        return { listed: ids.length ? ids.includes(ep.model) : null }
      },
      perCall: 1,
      async generate ({ ep, key }, { prompt, references }) {
        const req = { model: ep.model, prompt, size: '2K', response_format: 'b64_json', output_format: 'png', watermark: false }
        if (references.length === 1) req.image = dataUri(references[0].data)
        else if (references.length > 1) req.image = references.map((r) => dataUri(r.data))
        const body = await call(ep.base + '/images/generations', {
          method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(req),
        }, timeoutMs, key)
        return fromData(body, key)
      },
    },
    gemini: {
      async test ({ ep, key }) {
        const body = await call(ep.base + '/models?pageSize=1000', { headers: { 'x-goog-api-key': key } }, testTimeoutMs, key)
        const ids = body && Array.isArray(body.models) ? body.models.map((m) => m && String(m.name || '').replace(/^models\//, '')).filter(Boolean) : []
        return { listed: ids.length ? ids.includes(ep.model) : null }
      },
      perCall: 1,
      async generate ({ cfg, ep, key }, { prompt, references }) {
        const parts = references.map((r) => ({ inlineData: { mimeType: imageType(r.data) || 'image/png', data: r.data.toString('base64') } }))
        parts.push({ text: prompt })
        const body = await call(ep.base + '/models/' + encodeURIComponent(ep.model) + ':generateContent', {
          method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: geminiSize(cfg.size) } } }),
        }, timeoutMs, key)
        const out = []
        for (const c of (body && Array.isArray(body.candidates) ? body.candidates : [])) {
          for (const p of (c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [])) {
            const d = p && (p.inlineData || p.inline_data)
            if (d && typeof d.data === 'string' && d.data && !p.thought) out.push(Buffer.from(d.data, 'base64'))
          }
        }
        if (!out.length) throw geminiNoImage(body)
        return out.slice(-1) // a thinking model may stream drafts first; the last image is the answer
      },
    },
  }
  adapters.compatible = adapters.openai

  /** cheap authenticated probe (lists models; never generates) */
  const test = async () => {
    try {
      const p = await prep()
      const r = await adapters[p.ep.provider].test(p)
      return { ok: true, provider: p.ep.provider, model: p.ep.model, listed: r.listed }
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e instanceof ImageGenError ? e.message : '测试失败' }
    }
  }

  /**
   * prompt -> image buffers, n of them. references: [{ name, data: Buffer }] (the character / first frame).
   */
  const generate = async ({ prompt, n = 1, references = [] }) => {
    const p = await prep()
    const a = adapters[p.ep.provider]
    const refs = (references || []).filter((r) => r && Buffer.isBuffer(r.data))
    const text = decoratePrompt(p.ep.provider, prompt)
    const want = Math.max(1, Math.min(8, Number(n) || 1))
    const out = []
    if (a.perCall) { for (let i = 0; i < want; i++) out.push(...(await a.generate(p, { prompt: text, n: 1, references: refs })).slice(0, 1)) } else out.push(...(await a.generate(p, { prompt: text, n: want, references: refs })))
    if (!out.length) throw new ImageGenError('empty', '服务没有返回图片')
    for (const b of out) if (!imageType(b)) throw new ImageGenError('format', '返回的不是图片')
    return out
  }
  return { test, generate }
}

export function imageType (b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return ''
  if (b.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}
export const isPng = (b) => Buffer.isBuffer(b) && b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a
export function pngSize (b) { return isPng(b) ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null }
