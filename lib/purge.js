/**
 * 真正的删除：所有「清除 / 腾空间」入口共用这一个工具。
 *
 *   measure(target)          字节数 + 文件数（只统计，不跟随符号链接 / junction）
 *   purge(target, { roots }) 删之前依次核对：
 *                              1. realpath（目标的父目录取真实路径，目标本身若是链接则不跟）
 *                              2. 必须严格落在 roots 之一的「里面」，不能等于根本身
 *                              3. 拒绝盘符根、<盘>:\Users、<盘>:\Users\<任何人>、用户主目录、.dsh、插件目录
 *                              4. 目标或其中任何一层是符号链接 / junction -> 只删链接本身，不进去
 *                            文件被占用 -> { ok:false, code:'busy' }，不报半成功
 *
 * 允许的根只有两类（allowedRoots）：<数据目录>，以及 pye-music/models/clap（只给「听得更细」用）。
 */
import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, existsSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'])
const sameFs = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b)

/** 允许删的根：<数据目录>，以及 CLAP 模型目录（可经 PIXELPET_CLAP_DIR 指到别处，测试用） */
export function clapDirOf (env = process.env) {
  return env.PIXELPET_CLAP_DIR || join(env.LOCALAPPDATA || env.HOME || '.', 'pye-music', 'models', 'clap')
}
export function allowedRoots ({ dataDir, clapDir = clapDirOf() } = {}) {
  return [dataDir, clapDir].filter((x) => typeof x === 'string' && x)
}

/** 路径里每一段都真实化：存在的前缀走 realpath，不存在的尾巴原样接上 */
export function realish (p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail.reverse()) } catch {}
    const up = dirname(cur)
    if (up === cur) return resolve(p)
    tail.push(basename(cur))
    cur = up
  }
}

function inside (root, target) {
  const rel = relative(root, target)
  return !!rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 不许当删除目标（或删除根）的位置。返回原因字符串，可以删返回 '' */
export function forbiddenReason (p, { pluginDir = PLUGIN_DIR, home = homedir() } = {}) {
  const full = resolve(p)
  const { root } = parse(full)
  if (sameFs(full, root)) return '盘符根'
  const segs = full.slice(root.length).split(sep).filter(Boolean)
  if (segs.length && sameFs(segs[0], 'Users') && segs.length <= 2) return '用户目录'
  if (home && sameFs(full, resolve(home))) return '用户主目录'
  if (segs.some((s) => sameFs(s, '.dsh'))) return '.dsh'
  const plugin = realish(pluginDir)
  const real = realish(full)
  if (sameFs(real, plugin) || inside(real, plugin)) return '插件目录'   // 目标就是插件目录，或是它的上级
  return ''
}

/** 只统计：不跟随符号链接 / junction（链接本身不计大小） */
export function measure (target) {
  const out = { exists: false, bytes: 0, files: 0 }
  let st
  try { st = lstatSync(target) } catch { return out }
  out.exists = true
  if (st.isSymbolicLink()) return out
  if (!st.isDirectory()) { out.bytes = st.size; out.files = 1; return out }
  const walk = (dir) => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { walk(p); continue }
      try { out.bytes += lstatSync(p).size; out.files++ } catch {}
    }
  }
  walk(target)
  return out
}

/** measure 的异步版：设置页打开时算大小用，不卡住宿主的事件循环 */
export async function measureAsync (target) {
  const out = { exists: false, bytes: 0, files: 0 }
  let st
  try { st = await lstat(target) } catch { return out }
  out.exists = true
  if (st.isSymbolicLink()) return out
  if (!st.isDirectory()) { out.bytes = st.size; out.files = 1; return out }
  const stack = [target]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(p); continue }
      try { out.bytes += (await lstat(p)).size; out.files++ } catch {}
    }
  }
  return out
}

/** 删掉 dir 里（任意深度）的符号链接 / junction——只删链接本身，不进去 */
function dropLinks (dir) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) {
      try { unlinkSync(p) } catch { try { rmdirSync(p) } catch {} }
    } else if (e.isDirectory()) dropLinks(p)
  }
}

/**
 * 删 target（文件或目录）。
 * -> { ok:true, path, bytes, files } | { ok:false, code:'refused'|'busy'|'error', message, path }
 * opts: { roots, log?, rm?（测试注入）, pluginDir?, home? }
 */
export function purge (target, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const rm = typeof opts.rm === 'function' ? opts.rm : rmSync
  const roots = (opts.roots || []).filter((r) => typeof r === 'string' && r)
  const refuse = (message, path = '') => { log('[purge] 拒绝：' + message + (path ? ' ' + path : '')); return { ok: false, code: 'refused', message, path } }
  if (typeof target !== 'string' || !target) return refuse('目标为空')
  if (/\0/.test(target)) return refuse('目标路径无效')
  if (!roots.length) return refuse('没有允许的根')
  const abs = resolve(target)
  // 根本身也得是「可以当根」的地方，否则整个检查没意义
  const realRoots = []
  for (const r of roots) {
    const why = forbiddenReason(r, opts)
    if (why) return refuse('删除根不允许是' + why, r)
    realRoots.push(realish(r))
  }
  // 目标的父目录取真实路径；目标本身若是链接不跟（只删链接）
  const real = join(realish(dirname(abs)), basename(abs))
  log('[purge] 目标 ' + abs + ' -> ' + real)
  const hit = realRoots.find((r) => inside(r, real))
  if (!hit) return refuse(realRoots.some((r) => sameFs(r, real)) ? '不能删根目录本身' : '不在允许的目录里', real)
  const why = forbiddenReason(real, opts)
  if (why) return refuse('不允许删' + why, real)
  let st
  try { st = lstatSync(real) } catch { return { ok: true, path: real, bytes: 0, files: 0 } }   // 本来就不在
  const before = measure(real)
  try {
    if (st.isSymbolicLink()) {
      try { unlinkSync(real) } catch { rmdirSync(real) }
    } else {
      if (st.isDirectory()) dropLinks(real)
      rm(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  } catch (e) {
    const code = e && e.code
    log('[purge] 没删干净 ' + real + ' ' + String(code || e && e.message))
    return { ok: false, code: BUSY_CODES.has(code) ? 'busy' : 'error', message: BUSY_CODES.has(code) ? '有程序还在用，关掉桌宠再试' : String((e && e.message) || e).slice(0, 160), path: real }
  }
  // 返回成功前核对：没了才算成功（有些占用只让 rm 悄悄跳过）
  if (existsSync(real) && lstatLeft(real)) {
    return { ok: false, code: 'busy', message: '有程序还在用，关掉桌宠再试', path: real }
  }
  log('[purge] 已删 ' + real + ' ' + before.bytes + ' 字节 ' + before.files + ' 个文件')
  return { ok: true, path: real, bytes: before.bytes, files: before.files }
}

function lstatLeft (p) { try { lstatSync(p); return true } catch { return false } }

/** 一批目标顺序删；任何一个 busy 就停，返回已删的和没删的 */
export function purgeAll (targets, opts = {}) {
  const done = []
  let bytes = 0
  let files = 0
  for (const t of targets) {
    const r = purge(t, opts)
    if (!r.ok) return { ok: false, code: r.code, message: r.message, path: r.path, done, bytes, files }
    done.push(r.path); bytes += r.bytes; files += r.files
  }
  return { ok: true, done, bytes, files }
}
