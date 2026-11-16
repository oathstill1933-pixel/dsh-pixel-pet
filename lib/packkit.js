/**
 * packkit — 统一包解析与冻结契约（M0，接口与版本冻结）。
 *
 * 单一事实源：contracts/pack-contract-v1.json（lib/packkit.js 与 runtime/pixelpet/packkit.py 同读；
 * 缺失或损坏 = 安装损坏，显式报错，不静默降级）。改契约任何值 = 契约变更，必须升 contractVersion
 * 并同步两份实现与 docs/ 五份规范；跨语言一致性由 scripts/pack-conformance.test.mjs +
 * tests/test_pack_conformance.py 钉死。
 *
 * 职责：
 *   1. 枚举规则统一：跳过 `.` / `_` 前缀、名字含 `.bak-`、符号链接目录（两个语言、所有读取端一致）
 *   2. 严格 JSON 清单读取 + 结构校验（对齐 runtime/pixelpet/validate.py 的规则；帧图查到 PNG 头级别
 *      —— 尺寸 + 8bit RGBA。PIL 级终审（含"整张全透明"检测）归 Python 运行时，见 docs/PACK_SPEC.md）
 *   3. 分层决策冻结：用户层仅当有效时胜出；无效 → 内置层胜出并记录 userErrors（页面不得显示
 *      "已装好"却在跑另一份）；仅用户层且无效 → 兜底展示但标 valid:false（运行时有效集排除它）
 *   4. 版本三域分离（pack / plugin / dsh）+ 最小 SemVer 范围语法；不支持的语法显式报错
 *   5. 拓展包 manifest v1 校验、requires 检查、引擎注册表、安装状态机 transition
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { statSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { KIND_DIR, KIND_FILE, PACK_ID_RE } from './packs.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT_FILE = join(HERE, '..', 'contracts', 'pack-contract-v1.json')

export class PackError extends Error {
  constructor (code, message, details) {
    super(message || code)
    this.name = 'PackError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const err = (code, path, message) => ({ code, path, message })

// --------------------------------------------------------------------------- 契约

let contractCache = null
const reCache = new Map()
const re = (source) => { let r = reCache.get(source); if (!r) { r = new RegExp(source); reCache.set(source, r) } return r }

/** 冻结契约。缺失 / 损坏 / 未知 contractVersion 都是显式错误，绝不静默降级。 */
export function loadContract () {
  if (contractCache) return contractCache
  let c
  try { c = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')) } catch (e) {
    throw new PackError('E_CONTRACT_MISSING', '读不了冻结契约 ' + CONTRACT_FILE + '：' + (e && e.message || e))
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new PackError('E_CONTRACT_INVALID', '契约内容不是对象')
  if (c.contractVersion !== 1) throw new PackError('E_CONTRACT_INVALID', '契约版本不支持：' + String(c.contractVersion))
  if (!Array.isArray(c.installStates) || !c.stateTransitions || !c.errorCodes || !Array.isArray(c.permissions) || !Array.isArray(c.capabilities) || !c.character || !c.furniture || !c.packManifest) {
    throw new PackError('E_CONTRACT_INVALID', '契约缺少必需段落')
  }
  contractCache = c
  return c
}

export const permissionIds = () => loadContract().permissions.map((p) => p.id)
export const capabilityIds = () => loadContract().capabilities.map((c) => c.id)

export function describePermission (id) {
  const p = loadContract().permissions.find((x) => x.id === id)
  if (!p) throw new PackError('E_PERMISSION_UNKNOWN', '未知权限：' + id)
  return { ...p }
}

export function describeCapability (id) {
  const c = loadContract().capabilities.find((x) => x.id === id)
  if (!c) throw new PackError('E_CAPABILITY_UNKNOWN', '未知能力：' + id)
  return { ...c }
}

// --------------------------------------------------------------------------- 版本三域与最小范围语法

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const PRE_ID_RE = /^(0|[1-9]\d*|[0-9A-Za-z-]+)$/

/** 严格 SemVer：major.minor.patch[-pre]。不合法 → E_VERSION_MALFORMED。返回 {major,minor,patch,pre:[],raw} */
export function parseVersion (s) {
  const str = String(s ?? '')
  const m = VERSION_RE.exec(str)
  if (!m) throw new PackError('E_VERSION_MALFORMED', '不是合法的 SemVer：' + JSON.stringify(str.slice(0, 60)))
  const pre = m[4] ? m[4].split('.').map((x) => {
    if (!PRE_ID_RE.test(x)) throw new PackError('E_VERSION_MALFORMED', '预发布段不合法：' + str)
    if (/^\d+$/.test(x)) { if (/^0\d/.test(x)) throw new PackError('E_VERSION_MALFORMED', '预发布段数字不能有前导零：' + str); return Number(x) }
    return x
  }) : []
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre, raw: str }
}

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const isParsed = (v) => !!v && typeof v === 'object' && typeof v.major === 'number'

/** SemVer 优先级：数字段逐比；预发布 < 正式；预发布段逐比（数字 < 字母数字；缺段更小）。 */
export function compareVersions (a, b) {
  const x = isParsed(a) ? a : parseVersion(a)
  const y = isParsed(b) ? b : parseVersion(b)
  let c = cmpNum(x.major, y.major) || cmpNum(x.minor, y.minor) || cmpNum(x.patch, y.patch)
  if (c) return c
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i]; const yi = y.pre[i]
    if (xi === undefined) return -1
    if (yi === undefined) return 1
    const xn = typeof xi === 'number'; const yn = typeof yi === 'number'
    if (xn && yn) c = cmpNum(xi, yi)
    else if (xn) c = -1
    else if (yn) c = 1
    else c = xi < yi ? -1 : xi > yi ? 1 : 0
    if (c) return c
  }
  return 0
}

/** 范围 → 比较器列表。最小语法集，之外一律 E_RANGE_UNSUPPORTED。 */
export function parseRange (s) {
  const str = String(s ?? '').trim()
  if (!str) throw new PackError('E_RANGE_UNSUPPORTED', '空的版本范围')
  if (/(\|\||\*|\bx\b|[0-9]\s+-\s+[0-9])/.test(str)) throw new PackError('E_RANGE_UNSUPPORTED', '范围语法不支持：' + JSON.stringify(str.slice(0, 60)))
  const comps = []
  for (const token of str.split(/\s+/)) {
    if (token.startsWith('^') || token.startsWith('~')) {
      const v = parsePartial(token.slice(1), token)
      const lower = { op: '>=', major: v.major, minor: v.minor, patch: v.patch, pre: v.pre }
      let upper
      if (token.startsWith('^')) upper = v.major > 0 ? [v.major + 1, 0, 0] : (v.minor > 0 ? [0, v.minor + 1, 0] : [0, 0, v.patch + 1])
      else upper = [v.major, v.minor + 1, 0]
      comps.push(lower, { op: '<', major: upper[0], minor: upper[1], patch: upper[2], pre: [] })
    } else {
      const m = /^(>=|<=|>|<|=)?(.*)$/.exec(token)
      const v = parsePartial(m[2], token)
      // 裸写或 '=' 加部分版本（1.2 / =1.2）不在最小语法集里：裸版本必须写全三段，避免"1.2 排除 1.2.3"的歧义
      if ((!m[1] || m[1] === '=') && v.partial) throw new PackError('E_RANGE_UNSUPPORTED', '裸版本必须写全三段（部分版本只跟 ^ ~ 和比较器）：' + token)
      comps.push({ op: m[1] || '=', major: v.major, minor: v.minor, patch: v.patch, pre: v.pre })
    }
  }
  return comps
}

/** 范围里的版本允许缺段（按 0 补齐），但必须有至少 major.minor.patch 的骨架。 */
function parsePartial (s, token) {
  const m = /^((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:\.(?:0|[1-9]\d*))?)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(s)
  if (!m) throw new PackError('E_RANGE_UNSUPPORTED', '范围里的版本不合法：' + JSON.stringify(token.slice(0, 60)))
  const parts = m[1].split('.').map(Number)
  while (parts.length < 3) parts.push(0)
  const pre = m[2] ? m[2].split('.').map((x) => {
    if (!/^\d+$/.test(x)) return x
    if (/^0\d/.test(x)) throw new PackError('E_RANGE_UNSUPPORTED', '范围里的预发布段数字不能有前导零：' + JSON.stringify(token.slice(0, 60)))
    return Number(x)
  }) : []
  return { major: parts[0], minor: parts[1], patch: parts[2], pre, partial: m[1].split('.').length < 3 }
}

const cmpTuple = (v, c) => compareVersions(v, { major: c.major, minor: c.minor, patch: c.patch, pre: c.pre, raw: '' })

/** version 是否满足 range。带预发布号的候选版本只在范围里存在同三元组、显式写预发布号的比较器时才可满足。 */
export function satisfiesRange (version, range) {
  const v = isParsed(version) ? version : parseVersion(version)
  const comps = Array.isArray(range) && range[0] && range[0].op !== undefined ? range : parseRange(range)
  if (v.pre.length) {
    const gate = comps.some((c) => c.pre.length && c.major === v.major && c.minor === v.minor && c.patch === v.patch)
    if (!gate) return false
  }
  return comps.every((c) => {
    const d = cmpTuple(v, c)
    if (c.op === '>=') return d >= 0
    if (c.op === '<=') return d <= 0
    if (c.op === '>') return d > 0
    if (c.op === '<') return d < 0
    return d === 0
  })
}

/** 主插件版号（requires.core 引用的域）。读不了 package.json 时为 null，requires 检查会显式失败。 */
let pluginVersionCache
export function pluginVersion () {
  if (pluginVersionCache === undefined) {
    try { pluginVersionCache = String(JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || '') || null } catch { pluginVersionCache = null }
  }
  return pluginVersionCache
}

// --------------------------------------------------------------------------- 枚举（规则两侧统一）

/**
 * 某个 root 下某类包的目录名（名字序）。跳过：`.` 前缀、`_` 前缀、名字含 `.bak-`、符号链接目录。
 * 与 runtime/pixelpet/packkit.py enumerate_packs 同规则；validate.py --all 的枚举刻意包含 `_template`，不在此列。
 */
export function enumeratePacks (root, kind) {
  if (!KIND_DIR[kind]) return []
  const base = join(root, KIND_DIR[kind])
  let list
  try { list = readdirSync(base, { withFileTypes: true }) } catch { return [] }
  return list.filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((n) => !n.startsWith('.') && !n.startsWith('_') && !n.includes('.bak-'))
    // 链接的包目录可能指向任何地方：绝不透过它读清单
    .filter((n) => { try { return !lstatSync(join(base, n)).isSymbolicLink() } catch { return false } })
    .sort()
}

// --------------------------------------------------------------------------- 严格清单读取

export function readManifestStrict (dir, kind) {
  let text
  try { text = readFileSync(join(dir, KIND_FILE[kind]), 'utf8') } catch {
    return { ok: false, errors: [err('E_MANIFEST_MISSING', '', '找不到 ' + KIND_FILE[kind])] }
  }
  let data
  try { data = JSON.parse(text) } catch (e) {
    return { ok: false, errors: [err('E_MANIFEST_JSON_INVALID', '', 'JSON 语法错误：' + String(e && e.message || e).slice(0, 120))] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: [err('E_MANIFEST_JSON_INVALID', '', '顶层必须是对象 {...}')] }
  }
  return { ok: true, data }
}

// --------------------------------------------------------------------------- PNG 头（结构级像素检查）

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 头：{w,h,depth,color} | null。只读前 33 字节；8bit RGBA 之外都算不合规。 */
function pngHeader (file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(33)
    const n = readSync(fd, buf, 0, 33, 0)
    if (n < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
    if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], color: buf[25] }
  } catch { return null } finally { if (fd !== undefined) { try { closeSync(fd) } catch {} } }
}

// --------------------------------------------------------------------------- 结构校验（对齐 validate.py，像素级终审归运行时）

const _str = (v) => typeof v === 'string' && v.trim() !== ''
const _num = (v) => typeof v === 'number' && Number.isFinite(v)
const _int = (v) => typeof v === 'number' && Number.isInteger(v) // JSON 里没有 bool 混进 number 的可能
const _obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const safeRel = (p) => typeof p === 'string' && p.startsWith('sprites/') &&
  !p.replace(/\\/g, '/').split('/').includes('..') && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) &&
  p.toLowerCase().endsWith('.png')

function frameOk (dir, rel, expectSize) {
  if (!safeRel(rel)) return false
  const h = pngHeader(join(dir, rel))
  return !!h && h.depth === 8 && h.color === 6 && h.w === expectSize[0] && h.h === expectSize[1]
}

function checkFramesBlock (dir, st, path, expectSize, draft, push) {
  const frames = st.frames
  const durs = st.durationsMs
  if (!Array.isArray(frames)) { push('E_FIELD_INVALID', path + '.frames', '必须是数组') } else {
    if (!Array.isArray(durs)) push('E_FIELD_INVALID', path + '.durationsMs', '必须是数组（每帧一个毫秒数）')
    if (!frames.length) { if (!draft) push('E_REQUIRED_MISSING', path + '.frames', '还没有帧') } else if (Array.isArray(durs) && durs.length !== frames.length) {
      push('E_FIELD_INVALID', path + '.durationsMs', '长度与 frames 不一致')
    }
    const C = loadContract().character
    if (Array.isArray(durs)) {
      durs.forEach((d, i) => { if (!(_int(d) && C.durationMs.min <= d && d <= C.durationMs.max)) push('E_FIELD_INVALID', path + '.durationsMs[' + i + ']', '毫秒数越界') })
    }
    frames.forEach((rel, i) => {
      if (!safeRel(rel)) push('E_FIELD_INVALID', path + '.frames[' + i + ']', '帧路径必须是 sprites/ 下的相对 .png 路径，不能含 ..')
      else if (!frameOk(dir, rel, expectSize)) push('E_FIELD_INVALID', path + '.frames[' + i + ']', '帧缺失、不是 PNG 或尺寸/位深/色彩模式不合')
    })
  }
}

/** Load optional preset metadata and confine every returned file to this character's voice directory. */
export function readVoicePreset (dir) {
  const file = join(dir, 'voice', 'preset.json')
  const invalid = (hint) => new PackError('E_FIELD_INVALID', '音色预设：' + hint)
  try { lstatSync(file) } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw invalid('无法读取 preset.json')
  }
  const limits = loadContract().voicePreset
  const inside = (root, path) => {
    const rel = relative(root, path)
    return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
  }
  try {
    const voice = realpathSync(join(dir, 'voice'))
    if (!inside(realpathSync(dir), voice)) throw invalid('voice 目录越界')
    const checked = (name, max) => {
      const path = realpathSync(join(voice, name))
      if (!inside(voice, path)) throw invalid(name + ' 越界')
      const st = statSync(path)
      if (!st.isFile() || st.size > max) throw invalid(name + ' 不是文件或超过大小限制')
      return path
    }
    const bytes = readFileSync(checked('preset.json', Infinity))
    const meta = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    if (!_obj(meta) || !_str(meta.name) || [...meta.name].length > limits.nameMax
      || !limits.modes.includes(meta.mode) || typeof meta.language !== 'string'
      || ('text' in meta && (typeof meta.text !== 'string' || [...meta.text].length > limits.textMax))
      || (meta.mode === 'icl' && !_str(meta.text))) throw invalid('名称、模式、语言或文本不合法')
    const exact = (value, pattern) => typeof value === 'string' && re(pattern).exec(value)?.[0] === value
    if (!exact(meta.ref, limits.refRe) || !exact(meta.anchor, limits.anchorRe)) throw invalid('ref 或 anchor 文件名不合法')
    return { meta, ref: checked(meta.ref, limits.refMaxBytes), anchor: checked(meta.anchor, limits.anchorMaxBytes) }
  } catch (e) {
    if (e instanceof PackError) throw e
    throw invalid('preset.json 或音色文件无效')
  }
}

/** 角色包结构校验。返回 {draft, errors:[{code,path,message}]}。全透明像素等 PIL 级问题由运行时终审。 */
export function validateCharacterPack (dir, data, dirName) {
  const C = loadContract().character
  const errors = []
  const push = (code, path, message) => errors.push(err(code, path, message))
  const draft = data.draft === true
  const id = data.id
  if (!(_str(id) && re(C.stateIdRe).test(id))) push('E_ID_INVALID', 'id', 'id 要是 1–40 位小写字母/数字/-')
  else if (id !== dirName) push('E_ID_INVALID', 'id', 'id 必须和目录名一致')
  if (!_str(data.name)) push('E_REQUIRED_MISSING', 'name', '缺显示名')
  if ('demo' in data && typeof data.demo !== 'boolean') push('E_FIELD_INVALID', 'demo', '只能是 true / false')
  const canvas = C.canvas
  if (!Array.isArray(data.canvas) || data.canvas.length !== 2 || data.canvas[0] !== canvas[0] || data.canvas[1] !== canvas[1]) push('E_FIELD_INVALID', 'canvas', 'canvas 固定为 [' + canvas.join(', ') + ']')
  if (data.logicalScale !== C.logicalScale) push('E_FIELD_INVALID', 'logicalScale', 'logicalScale 固定为 ' + C.logicalScale)
  const ds = 'displayScale' in data ? data.displayScale : C.displayScale.default
  if (!(_num(ds) && ds >= C.displayScale.min && ds <= C.displayScale.max)) push('E_FIELD_INVALID', 'displayScale', 'displayScale 要是 ' + C.displayScale.min + '–' + C.displayScale.max)

  const states = _obj(data.states) && Object.keys(data.states).length ? data.states : null
  if (!states) push('E_REQUIRED_MISSING', 'states', '必须是非空对象')
  else {
    const missing = C.requiredStates.filter((s) => !(s in states))
    if (missing.length) push('E_REQUIRED_MISSING', 'states', '缺必需状态：' + missing.join(', '))
    const roles = new Set()
    const stateRe = re(C.stateIdRe)
    for (const [sid, st] of Object.entries(states)) {
      const p = 'states.' + sid
      if (!stateRe.test(String(sid))) { push('E_FIELD_INVALID', p, '状态 id 不合法'); continue }
      if (!_obj(st)) { push('E_FIELD_INVALID', p, '必须是对象 {label, frames, durationsMs, loop}'); continue }
      if (!_str(st.label)) push('E_REQUIRED_MISSING', p + '.label', '缺 label')
      if ('loop' in st && typeof st.loop !== 'boolean') push('E_FIELD_INVALID', p + '.loop', '只能是 true / false')
      if ('requires' in st && (!_obj(st.requires) || Object.keys(st.requires).length !== 1 || !C.stateFeatures.includes(st.requires.feature))) {
        push('E_FIELD_INVALID', p + '.requires', '只支持 {feature: "listen"}')
      }
      if ('role' in st) {
        if (!C.musicRoles.includes(st.role) || roles.has(st.role) || st.requires?.feature !== 'listen') {
          push('E_FIELD_INVALID', p + '.role', '音乐 role 须唯一，并声明 requires.feature: listen')
        }
        roles.add(st.role)
      }
      checkFramesBlock(dir, st, p, canvas, draft, push)
    }
  }

  const aliases = 'aliases' in data ? data.aliases : {}
  if (!_obj(aliases)) push('E_FIELD_INVALID', 'aliases', '必须是对象 {别名: 状态id}')
  else for (const [a, target] of Object.entries(aliases)) {
    if (!states || !(target in states)) push('E_FIELD_INVALID', 'aliases.' + a, '指向不存在的状态')
    if (states && a in states) push('E_FIELD_INVALID', 'aliases.' + a, '别名和已有状态重名')
  }
  const moods = 'moods' in data ? data.moods : {}
  if (!_obj(moods)) push('E_FIELD_INVALID', 'moods', '必须是对象 {情绪标签: 状态id}')
  else for (const [tag, target] of Object.entries(moods)) {
    if (!states || !(target in states)) push('E_FIELD_INVALID', 'moods.' + tag, '指向不存在的状态')
  }

  const looks = 'lookDirections' in data ? data.lookDirections : []
  if (!Array.isArray(looks)) push('E_FIELD_INVALID', 'lookDirections', '必须是数组')
  else if (looks.length && looks.length !== 16) {
    if (!(draft && !looks.some((l) => _obj(l) && 'frame' in l))) push('E_FIELD_INVALID', 'lookDirections', '要么不给，要么正好 16 个方向')
  } else {
    looks.forEach((item, i) => {
      const p = 'lookDirections[' + i + ']'
      if (!_obj(item)) { push('E_FIELD_INVALID', p, '必须是对象 {degrees, frame}'); return }
      if (!(_num(item.degrees) && Math.abs(item.degrees - i * 22.5) < 1e-6)) push('E_FIELD_INVALID', p + '.degrees', '第 ' + i + ' 个方向应为 ' + (i * 22.5) + '°')
      if (!frameOk(dir, item.frame, canvas)) push('E_FIELD_INVALID', p + '.frame', '注视帧缺失或尺寸/位深/色彩模式不合')
    })
  }
  try { readVoicePreset(dir) } catch (e) { push(e.code, 'voice/preset.json', e.message) }
  return { draft, errors }
}

/** 家具包结构校验。规则对齐 validate.py check_furniture。 */
export function validateFurniturePack (dir, data, dirName) {
  const F = loadContract().furniture
  const errors = []
  const push = (code, path, message) => errors.push(err(code, path, message))
  const draft = data.draft === true
  const id = data.id
  if (!(_str(id) && re(loadContract().packId.re).test(id))) push('E_ID_INVALID', 'id', 'id 要是 1–40 位小写字母/数字/-')
  else if (id !== dirName && !dirName.startsWith('_')) push('E_ID_INVALID', 'id', 'id 必须和目录名一致')
  if (!_str(data.name)) push('E_REQUIRED_MISSING', 'name', '缺显示名')
  let size = data.size
  if (!(Array.isArray(size) && size.length === 2 && size.every((v) => _int(v) && F.sizeMin <= v && v <= F.sizeMax))) {
    push('E_FIELD_INVALID', 'size', 'size 要是 [宽, 高] 两个 ' + F.sizeMin + '–' + F.sizeMax + ' 的整数像素')
    size = null
  }
  const anchor = 'anchor' in data ? data.anchor : 'bottom-right'
  if (!F.anchors.includes(anchor)) push('E_FIELD_INVALID', 'anchor', 'anchor 不在允许值里')
  if (size) {
    const fy = 'floorY' in data ? data.floorY : size[1] - 4
    if (!(_num(fy) && fy >= 0 && fy <= size[1])) push('E_FIELD_INVALID', 'floorY', 'floorY 越界')
    const stand = 'stand' in data ? data.stand : {}
    if (!_obj(stand) || Object.keys(stand).some((k) => !((k === 'left' || k === 'right') && _num(stand[k]) && -size[0] <= stand[k] && stand[k] <= 2 * size[0]))) {
      push('E_FIELD_INVALID', 'stand', 'stand 要是 {left?: x, right?: x}')
    }
  }
  const states = _obj(data.states) && Object.keys(data.states).length ? data.states : null
  if (!states) push('E_REQUIRED_MISSING', 'states', '必须是非空对象')
  else {
    const stateRe = re(loadContract().character.stateIdRe)
    for (const [sid, st] of Object.entries(states)) {
      const p = 'states.' + sid
      if (!_obj(st)) { push('E_FIELD_INVALID', p, '必须是对象 {frames, durationsMs}'); continue }
      if (!stateRe.test(String(sid))) push('E_FIELD_INVALID', p, '状态 id 不合法')
      checkFramesBlock(dir, st, p, size || [0, 0], draft, push)
    }
    if (!(data.idle in states)) push('E_FIELD_INVALID', 'idle', '要指向一个已有状态')
  }

  const inters = Array.isArray(data.interactions) ? data.interactions : null
  if (data.interactions !== undefined && inters === null) push('E_FIELD_INVALID', 'interactions', '必须是数组')
  const list = inters || []
  const verbs = new Set()
  const stateRe = re(loadContract().character.stateIdRe)
  const inBounds = (x, y) => !size || (-size[0] <= x && x <= 2 * size[0] && -size[1] <= y && y <= 2 * size[1])
  list.forEach((it, i) => {
    const p = 'interactions[' + i + ']'
    if (!_obj(it)) { push('E_FIELD_INVALID', p, '必须是对象'); return }
    if (!_str(it.verb)) { push('E_REQUIRED_MISSING', p, '每条互动要有 verb'); return }
    if (verbs.has(it.verb)) push('E_FIELD_INVALID', p + '.verb', 'verb 重复：' + it.verb)
    verbs.add(it.verb)
    if (!F.modes.includes(it.mode || 'beside')) push('E_FIELD_INVALID', p + '.mode', 'mode 不在允许值里')
    const occ = 'occupant' in it ? it.occupant : null
    if (occ !== null && occ !== undefined) {
      if (!_obj(occ)) { push('E_FIELD_INVALID', p + '.occupant', '必须是对象'); occ = null }
    }
    if (occ) {
      const a = 'anchor' in occ ? occ.anchor : null
      const hasArea = 'area' in occ
      if (a === null && hasArea) { /* anchor 可省，交给 area */ } else if (!(Array.isArray(a) && a.length === 2 && a.every(_num))) {
        push('E_FIELD_INVALID', p + '.occupant.anchor', 'anchor 要是 [x, y]')
      } else if (size && !inBounds(a[0], a[1])) push('E_FIELD_INVALID', p + '.occupant.anchor', 'anchor 离家具太远')
      if ('area' in occ) {
        const ar = occ.area
        if (!(Array.isArray(ar) && ar.length === 4 && ar.every(_num))) push('E_FIELD_INVALID', p + '.occupant.area', 'area 要是 [x0, y0, x1, y1]')
        else if (!(ar[0] < ar[2] && ar[1] < ar[3])) push('E_FIELD_INVALID', p + '.occupant.area', '要 x0 < x1 且 y0 < y1')
        else if (!(inBounds(ar[0], ar[1]) && inBounds(ar[2], ar[3]))) push('E_FIELD_INVALID', p + '.occupant.area', 'area 离家具太远')
      }
      if ('clipPath' in occ) {
        const cp = occ.clipPath
        if (!(Array.isArray(cp) && cp.length >= 2 && cp.length <= 24 && cp.every((q) => Array.isArray(q) && q.length === 2 && q.every(_num)))) push('E_FIELD_INVALID', p + '.occupant.clipPath', 'clipPath 要是 2–24 个 [x, y] 点')
        else if (cp.some((q, j) => j && q[0] <= cp[j - 1][0])) push('E_FIELD_INVALID', p + '.occupant.clipPath', 'clipPath 的 x 要从左到右严格递增')
        else if (!cp.every((q) => inBounds(q[0], q[1]))) push('E_FIELD_INVALID', p + '.occupant.clipPath', 'clipPath 有点离家具太远')
      }
      if ('pose' in occ && !_str(occ.pose)) push('E_FIELD_INVALID', p + '.occupant.pose', 'pose 要是角色状态名')
      if ('clipY' in occ && !(_num(occ.clipY) && (!size || (occ.clipY >= 0 && occ.clipY <= size[1])))) push('E_FIELD_INVALID', p + '.occupant.clipY', 'clipY 越界')
      if ('under' in occ && (!states || !(occ.under in states))) push('E_FIELD_INVALID', p + '.occupant.under', 'under 要指向已有状态')
    }
    if ((it.mode || 'beside') === 'inside' && (!states || !(it.state in states)) && !occ) push('E_FIELD_INVALID', p + '.state', 'inside 互动要给 occupant 或指明进去后的 state')
    if ('furnitureState' in it && (!states || !(it.furnitureState in states))) push('E_FIELD_INVALID', p + '.furnitureState', '要指向已有状态')
    if ('holdMs' in it && !(_int(it.holdMs) && it.holdMs >= F.holdMs.min && it.holdMs <= F.holdMs.max)) push('E_FIELD_INVALID', p + '.holdMs', 'holdMs 越界')
    for (const k of ['pose', 'enterPose']) {
      if (k in it && !(typeof it[k] === 'string' && stateRe.test(it[k]))) push('E_FIELD_INVALID', p + '.' + k, k + ' 要是角色状态名')
    }
    for (const k of ['done', 'say', 'hint']) {
      if (k in it && typeof it[k] !== 'string') push('E_FIELD_INVALID', p + '.' + k, k + ' 必须是字符串')
    }
  })
  return { draft, errors }
}

export function validatePackStructural (dir, kind, data, dirName) {
  return kind === 'character' ? validateCharacterPack(dir, data, dirName) : validateFurniturePack(dir, data, dirName)
}

// --------------------------------------------------------------------------- 分层解析（冻结决策）

function readLayer (dir, kind, id) {
  if (!dir) return null
  try { if (lstatSync(dir).isSymbolicLink()) return null } catch { return null }
  const m = readManifestStrict(dir, kind)
  if (!m.ok) return { dir, data: null, manifestOk: false, draft: false, valid: false, errors: m.errors }
  const v = validatePackStructural(dir, kind, m.data, id)
  // 严格有效 = 无错误且非骨架包（draft 对齐 Python strict 语义：骨架包不能运行，不参与分层胜出）
  return { dir, data: m.data, manifestOk: true, draft: v.draft, valid: !v.errors.length && !v.draft, errors: v.errors }
}

/**
 * 单包解析（冻结决策）：
 *   用户层严格有效            -> 用户层胜出（overlay = 内置层同 id 存在）
 *   用户层无效/是骨架(draft)  -> 内置层胜出，userErrors 记录用户层问题
 *   两个层级都无效            -> 内置层胜出（valid:false，页面能看到错误，不再各读各的）
 *   只有用户层且无效          -> 用户层兜底展示（valid:false，draft 可能是 true），运行时有效集排除
 *   两层都没有                -> null
 */
function validCharacterDir (id, dir) {
  return typeof dir === 'string' && /^characters\/(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*$/.test(dir)
    && dir.split('/').at(-1) === id
}

export function packedCharacters (dataDir, reg = readRegistryLenient(dataDir).reg) {
  return packedResources(dataDir, reg, 'character')
}

function packedResources (dataDir, reg, kind) {
  const chars = kind === 'character'
  const dirs = new Map()
  for (const [pack, entry] of Object.entries(reg.packs)) {
    const ptr = loadPointer(entry)
    const store = packStoreDir(dataDir, ptr)
    if (!store) continue
    const ids = chars ? ptr.characterIds : ptr.furnitureIds
    if (!Array.isArray(ids)) continue
    let realStore
    try { realStore = realpathSync(store) } catch { continue }
    for (const id of ids) {
      if (typeof id !== 'string' || !PACK_ID_RE.test(id) || dirs.has(id)) continue
      const rel = chars ? ptr.characterDirs?.[id] ?? 'characters/' + id : 'furniture/' + id
      if (chars && !validCharacterDir(id, rel)) continue
      const dir = join(store, rel)
      try {
        if (!realpathSync(dir).startsWith(realStore + sep)) continue
      } catch { continue }
      dirs.set(id, { pack, dir })
    }
  }
  return dirs
}

export function resolveOne ({ pluginRoot, dataDir, kind, id, characterDirs, furnitureDirs }) {
  if (!KIND_DIR[kind] || !PACK_ID_RE.test(String(id || ''))) return null
  const userDir = dataDir ? join(dataDir, KIND_DIR[kind], id) : null
  const builtinDir = join(pluginRoot, KIND_DIR[kind], id)
  const u = readLayer(userDir, kind, id)
  const b = readLayer(builtinDir, kind, id)
  const packDirs = kind === 'character' ? characterDirs : furnitureDirs
  const installed = dataDir
    ? (packDirs || packedResources(dataDir, readRegistryLenient(dataDir).reg, kind)).get(id) : null
  if (u && u.valid) {
    return { id, kind, base: 'user', dir: userDir, data: u.data, overlay: !!b || !!installed, valid: true, draft: false, errors: [], userErrors: [], userDraft: false, userDir, builtinDir: b ? builtinDir : null, user: true, builtin: !!b }
  }
  const p = installed && readLayer(installed.dir, kind, id)
  if (p && (p.valid || !b)) {
    return { id, kind, base: 'pack', pack: installed.pack, dir: p.dir, data: p.data, overlay: false, valid: p.valid, draft: p.draft, errors: p.errors, userErrors: u ? u.errors : [], userDraft: !!u?.draft, userDir: u ? userDir : null, builtinDir: b ? builtinDir : null, user: false, builtin: !!b }
  }
  if (b) {
    return { id, kind, base: 'builtin', dir: builtinDir, data: b.data, overlay: false, valid: b.valid, draft: b.draft, errors: b.errors, userErrors: u && !u.valid ? u.errors : [], userDraft: u ? u.draft : false, userDir: u ? userDir : null, builtinDir, user: false, builtin: true }
  }
  if (u) {
    return { id, kind, base: 'user', dir: userDir, data: u.data, overlay: false, valid: false, draft: u.draft, errors: u.errors, userErrors: [], userDraft: u.draft, userDir, builtinDir: null, user: true, builtin: false }
  }
  return null
}

/**
 * 拓展包注册表（M1，读者侧）：<data>/packs/registry.json。缺失 → 空注册表；
 * 损坏 → 空注册表 + E_REGISTRY_INVALID（页面能看到错误，运行时 packkit.py 同语义）。
 * 写者是 runtime/pack_cli.py（严格版拒写），这里绝不写。
 */
export const REGISTRY_VERSION = 2
const EMPTY_REG = () => ({ v: REGISTRY_VERSION, generation: 0, packs: {} })
const LOADABLE_STATES = ['installed-disabled', 'enabled']

/** 需要用户确认的权限 id 集合（契约 permissions[].needsConfirm）。 */
export const confirmPermissionIds = () => new Set(loadContract().permissions.filter((p) => p.needsConfirm).map((p) => p.id))

/** v1 → v2 兼容迁移（就地）；规则与 runtime/pixelpet/packkit.py migrate_registry 一致。 */
export function migrateRegistry (reg) {
  if (!reg || reg.v !== 1) return reg
  const confirm = confirmPermissionIds()
  for (const entry of Object.values(reg.packs || {})) {
    if (!entry || typeof entry !== 'object') continue
    const a = entry.active && typeof entry.active === 'object' ? entry.active : null
    const perms = (a && Array.isArray(a.permissions) ? a.permissions : []).filter((p) => typeof p === 'string')
    const pending = perms.filter((p) => confirm.has(p))
    const state = !a ? 'not-downloaded' : a.status === 'failed' ? 'load-failed' : pending.length ? 'waiting-authorization' : 'enabled'
    for (const k of ['active', 'previous', 'failed']) if (entry[k] && typeof entry[k] === 'object') delete entry[k].status
    if (!('failed' in entry)) entry.failed = null
    entry.state = state
    entry.wantEnabled = state === 'enabled' || state === 'waiting-authorization'
    entry.grantedPermissions = perms.filter((p) => !confirm.has(p))
    entry.pendingPermissions = pending
    entry.receipt = a && a.receipt ? a.receipt : null
    if (a) delete a.receipt
  }
  reg.v = REGISTRY_VERSION
  return reg
}

export function readRegistryLenient (dataDir) {
  if (!dataDir) return { reg: EMPTY_REG(), error: null }
  let text
  try { text = readFileSync(join(dataDir, 'packs', 'registry.json'), 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return { reg: EMPTY_REG(), error: null }
    return { reg: EMPTY_REG(), error: 'E_REGISTRY_INVALID' }
  }
  try {
    const reg = JSON.parse(text)
    if (!reg || ![1, 2].includes(reg.v) || !Number.isInteger(reg.generation) || reg.generation < 0 || !reg.packs || typeof reg.packs !== 'object' || Array.isArray(reg.packs)) {
      return { reg: EMPTY_REG(), error: 'E_REGISTRY_INVALID' }
    }
    return { reg: migrateRegistry(reg), error: null }
  } catch { return { reg: EMPTY_REG(), error: 'E_REGISTRY_INVALID' } }
}

/** 注册表 dir 只认 store 下的安全相对路径（与 packkit.py safe_store_rel 同规则）。 */
export function safeStoreRel (rel) {
  if (typeof rel !== 'string' || !rel) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || isAbsolute(rel) || (rel.length > 1 && rel[1] === ':')) return false
  return rel.replace(/\\/g, '/').split('/').every((s) => s && s !== '.' && s !== '..' && DIR_SEG_RE.test(s))
}

/** 该被运行时加载的版本指针或 null —— 权限门（与 packkit.py load_pointer 同规则）。 */
export function loadPointer (entry) {
  if (!entry || typeof entry !== 'object' || entry.wantEnabled !== true) return null
  const granted = new Set((Array.isArray(entry.grantedPermissions) ? entry.grantedPermissions : []).filter((p) => typeof p === 'string'))
  const ok = (ptr) => ptr && typeof ptr === 'object' && (Array.isArray(ptr.permissions) ? ptr.permissions : []).every((p) => granted.has(p))
  if (LOADABLE_STATES.includes(entry.state) && ok(entry.active)) return entry.active
  if (entry.state === 'waiting-authorization' && ok(entry.previous)) return entry.previous
  return null
}

/** 加载指针的版本目录绝对路径（安全 + 不越出 store + 目录存在），否则 null。 */
export function packStoreDir (dataDir, ptr) {
  if (!dataDir || !ptr || !safeStoreRel(ptr.dir)) return null
  const root = resolve(dataDir, 'packs', 'store')
  const full = resolve(root, ...String(ptr.dir).replace(/\\/g, '/').split('/'))
  if (full === root || !full.startsWith(root + sep)) return null
  try {
    if (!statSync(full).isDirectory() || !realpathSync(full).startsWith(realpathSync(root) + sep)) return null
  } catch { return null }
  return full
}

/**
 * 已解析安装快照：设置卡片、缩略图、AI 提示、可调用动作、编辑器、运行时都用这一份判定，
 * 不能各读各的目录。排序与旧 packEntries 一致：内置名序在前（用户覆盖原位），用户独有按名序追加，
 * M1 起拓展包家具按「用户层 > 包库 > 内置」最后追加（同 id 冲突在安装时已拒绝，这里是兜底）。
 * 另出 packs 卡片列表（catalog 由 host 侧合并，这里只给注册表实况）。
 */
export function snapshot ({ pluginRoot, dataDir, settings }) {
  const contract = loadContract()
  const hiddenOf = (kind) => { const h = settings && settings.hidden; return Array.isArray(h && h[kind]) ? h[kind] : [] }
  const out = { contractVersion: contract.contractVersion, manifestVersion: contract.manifestVersion, packApi: contract.packApi, pluginVersion: pluginVersion(), characters: [], furniture: [], packs: [], registryError: null }
  const { reg, error } = readRegistryLenient(dataDir)
  out.registryError = error
  out.generation = reg.generation
  const fcfg = (settings && settings.furniture) || {}
  for (const [pid, entry] of Object.entries(reg.packs || {})) {
    const e = entry && typeof entry === 'object' ? entry : {}
    const a = e.active && typeof e.active === 'object' ? e.active : null
    const lp = loadPointer(e)
    out.packs.push({
      id: pid,
      version: a ? a.version : null,
      state: typeof e.state === 'string' ? e.state : 'unknown',
      wantEnabled: e.wantEnabled === true,
      loading: lp ? lp.version : null,
      sha256: a ? a.sha256 : null,
      permissions: a && Array.isArray(a.permissions) ? a.permissions : [],
      grantedPermissions: Array.isArray(e.grantedPermissions) ? e.grantedPermissions : [],
      pendingPermissions: Array.isArray(e.pendingPermissions) ? e.pendingPermissions : [],
      characterIds: a && Array.isArray(a.characterIds) ? a.characterIds : [],
      furnitureIds: a && Array.isArray(a.furnitureIds) ? a.furnitureIds : [],
      receipt: e.receipt && typeof e.receipt === 'object' ? e.receipt : null,
      hasPrevious: !!e.previous,
    })
  }
  const characterDirs = packedCharacters(dataDir, reg)
  const furnitureDirs = packedResources(dataDir, reg, 'furniture')
  for (const kind of ['character', 'furniture']) {
    const builtins = enumeratePacks(pluginRoot, kind)
    const users = dataDir ? enumeratePacks(dataDir, kind) : []
    const ids = [...new Set([...builtins, ...users, ...(kind === 'character' ? characterDirs : furnitureDirs).keys()])]
    const hidden = hiddenOf(kind)
    const list = ids.map((id) => {
      const pk = resolveOne({ pluginRoot, dataDir, kind, id, characterDirs, furnitureDirs })
      if (!pk) return null
      const d = pk.data || {}
      const entry = {
        id, kind,
        name: typeof d.name === 'string' && d.name ? d.name : id,
        demo: d.demo === true, draft: pk.draft, defaultEnabled: d.defaultEnabled === true,
        dir: pk.dir, base: pk.base, valid: pk.valid, errors: pk.errors, userErrors: pk.userErrors, userDraft: pk.userDraft,
        user: pk.user, overlay: pk.overlay, builtin: pk.builtin,
        ...(pk.pack ? { pack: pk.pack } : {}),
        hidden: pk.base === 'builtin' && hidden.includes(id),
      }
      if (kind === 'furniture') entry.enabled = fcfg[id] && typeof fcfg[id].enabled === 'boolean' ? fcfg[id].enabled : entry.defaultEnabled
      if (kind === 'furniture' && typeof d.feature === 'string') entry.feature = d.feature // e.g. reading: 书架只在「一起看书」开着时列出
      return entry
    }).filter(Boolean)
    out[kind === 'character' ? 'characters' : 'furniture'] = list
  }
  return out
}

// --------------------------------------------------------------------------- 拓展包 manifest v1

const ENGINE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
const DIR_SEG_RE = /^[^\\/:*?"<>|\x00-\x1f]+$/

/**
 * 拓展包 manifest v1 校验。未支持的 manifestVersion / packApi 显式报错，绝不按旧格式猜。
 * 顶层未知键容忍并保留；requires 这类协议载体里的未知键一律 E_FIELD_INVALID。
 */
export function checkPackManifest (manifest) {
  const C = loadContract()
  const PM = C.packManifest
  const errors = []
  const push = (code, path, message) => errors.push(err(code, path, message))
  if (!_obj(manifest)) return { ok: false, errors: [err('E_MANIFEST_JSON_INVALID', '', '顶层必须是对象 {...}')] }
  const mv = manifest.manifestVersion
  if (typeof mv !== 'number' || !Number.isInteger(mv)) push('E_FIELD_INVALID', 'manifestVersion', 'manifestVersion 必须是整数')
  else if (mv !== C.manifestVersion) return { ok: false, errors: [err('E_MANIFEST_VERSION_UNSUPPORTED', 'manifestVersion', '清单格式版本不支持：' + mv + '（本插件支持 ' + C.manifestVersion + '）')] }
  const pa = manifest.packApi
  if (typeof pa !== 'number' || !Number.isInteger(pa)) push('E_FIELD_INVALID', 'packApi', 'packApi 必须是整数')
  else if (pa !== C.packApi) return { ok: false, errors: [err('E_PACK_API_UNSUPPORTED', 'packApi', '包协议版本不支持：' + pa + '（本插件支持 ' + C.packApi + '）')] }

  if (!(_str(manifest.id) && re(PM.id.re).test(manifest.id))) push('E_ID_INVALID', 'id', 'id 要是 命名空间.包名（各自 1–32 / 1–40 位小写字母、数字、-）')
  try { parseVersion(manifest.version) } catch { push('E_VERSION_MALFORMED', 'version', 'version 要是合法 SemVer') }
  if (!_str(manifest.name)) push('E_REQUIRED_MISSING', 'name', '缺展示名')
  if (!_str(manifest.license)) push('E_REQUIRED_MISSING', 'license', '缺 license')

  if ('requires' in manifest) {
    const rq = manifest.requires
    if (!_obj(rq)) push('E_FIELD_INVALID', 'requires', '必须是对象')
    else {
      for (const k of Object.keys(rq)) {
        if (!PM.requiresAllowedKeys.includes(k)) { push('E_FIELD_INVALID', 'requires.' + k, 'requires 不支持这个键（禁止声明 ' + PM.requiresForbiddenKeys.join('/') + '）'); continue }
        if (k === 'core') { try { parseRange(rq.core) } catch (e) { push(e.code, 'requires.core', e.message) } }
        if (k === 'engines') {
          if (!_obj(rq.engines)) push('E_FIELD_INVALID', 'requires.engines', '必须是 {引擎id: 版本范围}')
          else for (const [eid, range] of Object.entries(rq.engines)) {
            if (!ENGINE_ID_RE.test(eid)) push('E_FIELD_INVALID', 'requires.engines.' + eid, '引擎 id 不合法')
            else { try { parseRange(range) } catch (e) { push(e.code, 'requires.engines.' + eid, e.message) } }
          }
        }
        if (k === 'capabilities') {
          if (!Array.isArray(rq.capabilities)) push('E_FIELD_INVALID', 'requires.capabilities', '必须是数组')
          else rq.capabilities.forEach((cap, i) => { try { describeCapability(cap) } catch { push('E_CAPABILITY_UNKNOWN', 'requires.capabilities[' + i + ']', '未知能力：' + String(cap).slice(0, 40)) } })
        }
      }
    }
  }
  if ('platforms' in manifest && !(Array.isArray(manifest.platforms) && manifest.platforms.every((p) => _str(p)))) push('E_FIELD_INVALID', 'platforms', 'platforms 必须是非空字符串数组')
  if ('permissions' in manifest) {
    if (!Array.isArray(manifest.permissions)) push('E_FIELD_INVALID', 'permissions', '必须是数组')
    else manifest.permissions.forEach((p, i) => { try { describePermission(p) } catch { push('E_PERMISSION_UNKNOWN', 'permissions[' + i + ']', '未知权限：' + String(p).slice(0, 40)) } })
  }
  if ('entryFurniture' in manifest && manifest.entryFurniture !== null) {
    const ef = manifest.entryFurniture
    if (!_obj(ef) || !(_str(ef.id) && re(C.packId.re).test(ef.id))) push('E_FIELD_INVALID', 'entryFurniture', 'entryFurniture 要是 {id, dir?}')
    else if ('dir' in ef && !(_str(ef.dir) && !ef.dir.split('/').includes('..') && !isAbsolute(ef.dir) && ef.dir.split('/').every((s) => DIR_SEG_RE.test(s)))) push('E_FIELD_INVALID', 'entryFurniture.dir', 'dir 要是安全的相对目录')
  }
  if ('resources' in manifest && manifest.resources !== null) {
    const rs = manifest.resources
    if (!_obj(rs)) push('E_FIELD_INVALID', 'resources', 'resources 要是 {名称: 相对路径}')
    else for (const [k, v] of Object.entries(rs)) {
      if (!(_str(k) && _str(v) && !v.split('/').includes('..') && !isAbsolute(v) && v.split('/').every((s) => DIR_SEG_RE.test(s)))) push('E_FIELD_INVALID', 'resources.' + k, '资源路径要是不越界的相对路径')
    }
  }
  if ('characters' in manifest) {
    const ids = new Set()
    const chars = manifest.characters
    if (!Array.isArray(chars)) push('E_FIELD_INVALID', 'characters', '必须是数组')
    else chars.forEach((ch, i) => {
      const path = 'characters[' + i + ']'
      if (!_obj(ch) || !PACK_ID_RE.test(typeof ch.id === 'string' ? ch.id : '') || ids.has(ch.id)
        || Object.keys(ch).some((k) => !PM.charactersAllowedKeys.includes(k))
        || ('dir' in ch && !validCharacterDir(ch.id, ch.dir))) {
        push('E_FIELD_INVALID', path, '角色须有唯一 id 与安全目录，且只支持 id / dir')
      }
      if (_obj(ch)) ids.add(ch.id)
    })
  }

  if ('characterAdapters' in manifest && manifest.characterAdapters !== null) {
    const cas = manifest.characterAdapters
    if (!Array.isArray(cas)) push('E_FIELD_INVALID', 'characterAdapters', '必须是数组')
    else cas.forEach((ca, i) => {
      const p = 'characterAdapters[' + i + ']'
      if (!_obj(ca) || !(_str(ca.character) && re(C.packId.re).test(ca.character))) { push('E_FIELD_INVALID', p, '要指明适配的角色 id'); return }
      for (const k of ['required', 'optional']) {
        if (!(k in ca)) continue
        if (!Array.isArray(ca[k])) push('E_FIELD_INVALID', p + '.' + k, '必须是动作 id 数组')
        else ca[k].forEach((a, j) => { if (!(typeof a === 'string' && re(C.character.stateIdRe).test(a))) push('E_FIELD_INVALID', p + '.' + k + '[' + j + ']', '动作 id 不合法') })
      }
    })
  }
  if ('dependencies' in manifest && manifest.dependencies !== null) {
    const deps = manifest.dependencies
    if (!Array.isArray(deps)) push('E_FIELD_INVALID', 'dependencies', '必须是数组')
    else deps.forEach((d, i) => {
      const p = 'dependencies[' + i + ']'
      if (!_obj(d)) { push('E_FIELD_INVALID', p, '必须是对象 {id, version}'); return }
      if (!(_str(d.id) && re(PM.id.re).test(d.id))) push('E_FIELD_INVALID', p + '.id', '依赖 id 要是命名空间 id')
      else if (_str(manifest.id) && d.id === manifest.id) push('E_FIELD_INVALID', p + '.id', '不能依赖自己')
      try { parseRange(d.version) } catch (e) { push(e.code, p + '.version', e.message) }
    })
  }
  for (const k of ['credits', 'publisher']) {
    if (k in manifest && typeof manifest[k] !== 'string') push('E_FIELD_INVALID', k, k + ' 必须是字符串')
  }
  return { ok: !errors.length, errors }
}

/**
 * requires.core 对主插件版号（plugin 域）的满足性。dsh 域在这里不存在 —— 拓展包不声明 DSH 版本。
 */
export function checkRequires (manifest, { pluginVersion: pv } = {}) {
  const C = loadContract()
  const errors = []
  const rq = manifest && manifest.requires
  if (_obj(rq) && 'core' in rq) {
    const core = pv !== undefined ? pv : pluginVersion()
    let ok = false
    try { ok = core ? satisfiesRange(core, rq.core) : false } catch (e) { errors.push(err(e.code, 'requires.core', e.message)); return { ok: false, errors } }
    if (!ok) errors.push(err('E_RANGE_NOT_SATISFIED', 'requires.core', '需要主插件 ' + rq.core + '，当前 ' + (core || '未知')))
  }
  return { ok: !errors.length, errors }
}

// --------------------------------------------------------------------------- 引擎注册表（接口冻结，无引擎实现）

/**
 * 玩法引擎注册表：随主插件发行的受审计引擎在此登记 {id, version, capabilities, activate}。
 * packkit 只管登记与解析，生命周期所有权归引擎（见 docs/ENGINE_SPEC.md）。
 */
export function createEngineRegistry () {
  const byId = new Map()
  return {
    register (def) {
      const C = loadContract()
      if (!_obj(def) || !(typeof def.id === 'string' && ENGINE_ID_RE.test(def.id))) throw new PackError('E_ID_INVALID', '引擎 id 要是 1–32 位小写字母/数字/-')
      const version = parseVersion(def.version)
      const caps = def.capabilities || []
      if (!Array.isArray(caps)) throw new PackError('E_FIELD_INVALID', 'capabilities 必须是数组')
      for (const c of caps) describeCapability(c)
      const list = byId.get(def.id) || []
      if (list.some((d) => d.version.raw === version.raw)) throw new PackError('E_FIELD_INVALID', '引擎重复注册：' + def.id + '@' + version.raw)
      const entry = { id: def.id, version, capabilities: [...caps], activate: def.activate }
      list.push(entry)
      list.sort((a, b) => compareVersions(b.version, a.version))
      byId.set(def.id, list)
      let off = false
      return () => {
        if (off) return; off = true
        const left = (byId.get(def.id) || []).filter((d) => d !== entry)
        if (left.length) byId.set(def.id, left); else byId.delete(def.id)
      }
    },
    resolve (id, range) {
      const list = byId.get(String(id || ''))
      if (!list || !list.length) throw new PackError('E_ENGINE_UNKNOWN', '未注册的引擎：' + String(id).slice(0, 40))
      if (range === undefined || range === null) return list[0]
      const hit = list.filter((d) => { try { return satisfiesRange(d.version, range) } catch { return false } })
      if (!hit.length) throw new PackError('E_ENGINE_VERSION_UNSUPPORTED', '引擎 ' + id + ' 没有满足 ' + range + ' 的已注册版本')
      return hit[0]
    },
    list () { return [...byId.values()].flat().map(({ activate, ...rest }) => rest) },
  }
}

// --------------------------------------------------------------------------- 安装状态机

/**
 * 安装状态机迁移。不接受 (状态, 事件) 组合 → E_STATE_INVALID；enable-request 是意图事件，
 * 不迁移（见契约 enableRequestNote）。
 */
export function transition (state, event) {
  const table = loadContract().stateTransitions[String(state || '')]
  const to = table && table[String(event || '')]
  if (!to) throw new PackError('E_STATE_INVALID', '状态机不接受：' + String(state) + ' × ' + String(event))
  return to
}

export const installStates = () => [...loadContract().installStates]
