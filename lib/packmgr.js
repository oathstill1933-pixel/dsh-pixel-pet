/**
 * packmgr — 拓展包管理器（M1）：宿主侧的单飞行安装/卸载编排。
 *
 * 分工（方案 §七，house pattern 同 voice installer）：
 *   - runtime/pack_cli.py 是注册表的唯一写者：下载/校验/安全解包/深度校验/版本库/registry 原子替换，
 *     单行 JSON 判决，进度写 <data>/packs/progress.json（本模块只读）。
 *   - 本模块 spawn 它（PYTHONUTF8 env、最后 JSON 行判决），成功后向运行中的桌宠发
 *     `packs reload` 控制命令收回执（send = tools.js sendCommand 注入）；桌宠没运行就登记待启动加载，
 *     绝不偷偷启动（方案 M1 通过条件②）。回执被否定 → receipt(ok=0) + rollback 回退旧指针。
 *   - 单飞行：busy Promise 锁覆盖 CLI + reload + 回执 + 回滚全流程（pack_cli 另有 packs/.lock 进程锁）。
 *   - 权限门：只有 CLI 判定 load=true（已授权且有启用意图）才收回执；待授权的包走 grant()。
 *   - 快照/页面/运行时读同一份 registry（packkit 双侧），本模块不直接写它。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadPointer, readRegistryLenient } from './packkit.js'

export const PACK_LIMIT = 64 * 1024 * 1024
const CLI_TIMEOUT_MS = 15 * 60_000

const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }

/** 导入用的一次性暂存相对路径：<data>/packs/.incoming/<rand>.petpack */
export const incomingName = () => '.incoming/' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex') + '.petpack'

/**
 * catalog 条目校验：id/URL（https-only，回环 http 仅限本机测试）/大小/哈希/权限 id。
 * permissionIds 是契约 permissions 的 id 列表（host 从 packkit 传入）。一条不合法 = 整个目录拒用。
 */
const safeBundled = (path) => typeof path === 'string' && /^packs-bundled\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.petpack$/.test(path)

export function validateCatalog (catalog, permissionIds) {
  const okPerm = (p) => Array.isArray(permissionIds) && permissionIds.includes(p)
  if (!catalog || catalog.v !== 1 || !Array.isArray(catalog.entries)) return { v: 1, entries: [], error: 'E_CATALOG_INVALID' }
  const entries = []
  for (const e of catalog.entries) {
    const id = typeof e?.id === 'string' ? e.id : ''
    const urlOk = typeof e?.url === 'string' && (/^https:\/\//.test(e.url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(e.url))
    const bundledOk = safeBundled(e?.bundled)
    const sourceOk = bundledOk ? !Object.hasOwn(e, 'url') : urlOk && !Object.hasOwn(e, 'bundled')
    if (!/^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,39}$/.test(id) || !sourceOk
      || !Number.isInteger(e?.size) || e.size <= 0
      || typeof e?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)
      || (e?.permissions !== undefined && !(Array.isArray(e.permissions) && e.permissions.every(okPerm)))) {
      return { v: 1, entries: [], error: 'E_CATALOG_INVALID' }
    }
    entries.push({ id, version: String(e.version || ''), name: String(e.name || id), summary: String(e.summary || ''), ...(bundledOk ? { bundled: e.bundled } : { url: e.url }), size: e.size, sha256: e.sha256, permissions: e.permissions || [] })
  }
  return { v: 1, entries }
}

/**
 * createPackManager({ root, dataDir, python, logger, spawn, send, env, permissionIds })
 *   python: () => 解释器路径（host.pyPath）；spawn/send 可注入供测试。
 */
export function createPackManager ({ root, dataDir, python, logger, spawn = nodeSpawn, send, env = process.env, permissionIds = [] }) {
  if (typeof python !== 'function') throw new Error('packmgr needs python()')
  if (typeof send !== 'function') throw new Error('packmgr needs send()')
  const cliPath = join(root, 'runtime', 'pack_cli.py')
  const progressPath = join(dataDir, 'packs', 'progress.json')
  let child = null
  let catalogCache

  const readProgress = () => readJson(progressPath, null)
  // 页面读的注册表与快照同一套宽容读取（v1 就地迁移成 v2 视图）
  const readRegistry = () => { const { reg, error } = readRegistryLenient(dataDir); return error ? { ...reg, error } : reg }

  /** 跑一次 pack_cli 子命令，收最后一行 JSON 判决（voice installer 同约定）。 */
  function runCli (args, timeoutMs = CLI_TIMEOUT_MS) {
    const py = python()
    if (!py) return Promise.resolve({ ok: false, code: 'INTERNAL', message: '找不到 Python，装不了拓展包' })
    return new Promise((done) => {
      let out = ''
      let kid
      try {
        kid = spawn(py, ['-X', 'utf8', cliPath, ...args], { windowsHide: true, env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
      } catch (e) {
        return done({ ok: false, code: 'INTERNAL', message: '启动 Python 失败：' + String(e && e.message || e).slice(0, 120) })
      }
      child = kid
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; try { kid.kill() } catch {} }, timeoutMs)
      kid.stdout?.on('data', (b) => { out += b; if (out.length > 100_000) out = out.slice(-100_000) })
      kid.stderr?.on('data', () => {})
      kid.on('error', (e) => { clearTimeout(timer); child = null; done({ ok: false, code: 'INTERNAL', message: '找不到 Python：' + String(e && e.message || e).slice(0, 120) }) })
      kid.on('close', (code) => {
        clearTimeout(timer)
        child = null
        if (timedOut) {
          logger?.warn?.('[dsh-pixel-pet] 拓展包操作超时，已中止')
          return done({ ok: false, code: 'E_TIMEOUT', message: '下载超时（' + Math.round(timeoutMs / 1000) + ' 秒），已中止' })
        }
        const line = out.trim().split('\n').pop() || ''
        let v
        try { v = JSON.parse(line) } catch { v = null }
        if (!v || typeof v.ok !== 'boolean') {
          return done({ ok: false, code: 'INTERNAL', message: '安装器没有有效输出（exit ' + code + '）' })
        }
        if (!v.ok && code !== 0 && !v.message) v.message = '安装器退出码 ' + code
        if (!v.ok) logger?.warn?.('[dsh-pixel-pet] 拓展包操作没完成：' + String(v.message || v.code).slice(0, 160))
        done(v)
      })
    })
  }

  const cliArgs = (cmd, extra) => ['--data-dir', dataDir, ...((cmd === 'install' || cmd === 'uninstall') ? ['--plugin-root', root] : []), ...extra]
  const cli = (cmd, extra, timeoutMs) => runCli([cmd, ...cliArgs(cmd, extra)], timeoutMs)

  /**
   * 单飞行锁：一把 busy Promise 覆盖 install/grant/disable/uninstall 的 CLI + reload + 回执 + 回滚全流程；
   * 期间来的第二个请求直接拒（不排队，页面会刷新状态）。pack_cli 自己另有 packs/.lock 进程锁兜底。
   */
  let busy = null
  async function exclusive (fn) {
    if (busy) return { ok: false, code: 'INTERNAL', message: '已有拓展包操作在进行' }
    let release
    busy = new Promise((resolve) => { release = resolve })
    try { return await fn() } finally { busy = null; release() }
  }

  /**
   * 回执流（只对 CLI 判定 load=true 的包跑）：桌宠在运行就发 packs reload 收回执；没运行就登记"待启动加载"，
   * 绝不偷偷启动（M1 通过条件②）。回执判定：data.ok 且 data.generation >= wantGen，且该包每件家具
   * 被某层加载——包层加载算成功；被用户层同名覆盖时报告覆盖者（不判失败）；都没有才算缺失 → 回滚。
   */
  async function receiptFlow (v) {
    const wantGen = Number(v.generation)
    const rec = (extra) => cli('receipt', ['--pack-id', v.id, '--generation', String(wantGen), ...extra])
    let r = null
    try { r = await send({ cmd: 'packs', action: 'reload', generation: wantGen }) } catch { r = null }
    const data = r && typeof r === 'object' ? r.data : null
    const petRunning = !!(r && r.running !== false)
    if (!petRunning) {
      await rec(['--pet-running', '0', '--ok-flag', '0', '--loaded', '{"furniture":[],"characters":[]}'])
      return { ...v, receipt: { petRunning: false, message: '桌宠没在运行，下次启动自动加载' } }
    }
    const genOk = data && Number.isFinite(Number(data.generation)) && Number(data.generation) >= wantGen
    let reason = null
    let loaded = { furniture: [], characters: [] }
    const overridden = {}
    if (data && data.ok === true && genOk) {
      loaded = {
        furniture: Array.isArray(data.loaded) ? data.loaded : data.loaded?.furniture || [],
        characters: data.loaded?.characters || [],
      }
      const missing = []
      for (const kind of ['furniture', 'characters']) {
        const layers = kind === 'furniture' && Array.isArray(data.loaded) ? data.all : data.all?.[kind]
        const ids = kind === 'furniture' ? v.furnitureIds : v.characterIds
        for (const id of ids || []) {
          if (loaded[kind].includes(id)) continue
          if (layers?.[id] === 'user') overridden[id] = 'user'
          else missing.push(id)
        }
      }
      if (!missing.length) {
        await rec(['--pet-running', '1', '--ok-flag', '1', '--loaded', JSON.stringify(loaded), '--overridden', JSON.stringify(overridden)])
        return { ...v, receipt: { petRunning: true, ok: true, loaded, overridden } }
      }
      reason = '桌宠没加载到：' + missing.join('、')
    } else if (data && data.ok === true) {
      reason = '激活代次不一致'
    } else {
      reason = data && data.reason === 'generation-mismatch' ? '激活代次不一致' : (data && data.message || r && r.message || '桌宠重载失败')
    }
    await rec(['--pet-running', '1', '--ok-flag', '0', '--loaded', JSON.stringify(loaded), '--errors', JSON.stringify(data && data.errors || {})])
    const rb = await cli('rollback', ['--pack-id', v.id])
    await send({ cmd: 'packs', action: 'reload', ...(rb.ok ? { generation: rb.generation } : {}) }).catch(() => null)
    const tail = rb.ok && rb.rolledBack ? '，已回退到 ' + rb.active : '，没有旧版可退，已停用'
    return { ok: false, code: 'E_RECEIPT_FAILED', message: reason + tail, id: v.id, rollback: rb }
  }

  /** CLI 成功后的统一收尾：该加载 → 回执流；不加载（未启用 / 待授权）→ 只让在跑的桌宠对齐，不收回执。 */
  async function afterCli (v) {
    if (!v.ok) return v
    if (v.load) return receiptFlow(v)
    try { await send({ cmd: 'packs', action: 'reload', generation: v.generation }) } catch {}
    return { ...v, needsAuthorization: Array.isArray(v.pendingPermissions) && v.pendingPermissions.length > 0 }
  }

  return {
    /** catalog（读取 + 条目校验 + 缓存；一条不合法 = 整目录拒用并标 E_CATALOG_INVALID）。 */
    catalog () {
      if (!catalogCache) {
        let c = null
        try { c = readJson(join(root, 'contracts', 'catalog.json'), null) } catch { c = null }
        catalogCache = validateCatalog(c, permissionIds)
      }
      return catalogCache
    },
    /** 从目录条目下载安装（只手动触发，没有后台自动更新）。enable：用户点的是「安装并启用」。 */
    installFromCatalog (packId, { enable = false, timeoutMs, retries } = {}) {
      return exclusive(async () => {
        const entry = this.catalog().entries.find((e) => e.id === packId)
        if (!entry) return { ok: false, code: 'E_CATALOG_INVALID', message: '目录里没有这个包：' + String(packId).slice(0, 60) }
        let source = ['--url', entry.url]
        if (entry.bundled) {
          try {
            const base = realpathSync(root)
            const file = realpathSync(join(base, entry.bundled))
            const rel = relative(base, file)
            if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
              return { ok: false, code: 'E_CATALOG_INVALID', message: '附带包路径越出插件目录' }
            }
            source = ['--pack', file, '--pack-version', entry.version]
          } catch {
            return { ok: false, code: 'E_MANIFEST_MISSING', message: '找不到插件附带的拓展包' }
          }
        }
        return afterCli(await cli('install', [...source, '--sha256', entry.sha256,
          '--size', String(entry.size), '--pack-id', entry.id, ...(enable ? ['--enable', '1'] : []),
          ...(Number.isInteger(retries) && retries >= 0 && !entry.bundled ? ['--retries', String(retries)] : [])], timeoutMs))
      })
    },
    /** 本地导入：host 已把上传的 .petpack 落在 .incoming，交给 CLI（与下载同一条安装管线）。 */
    async installFromFile (stagedPath, { enable = false } = {}) {
      const r = await exclusive(async () => {
        const v = await cli('install', ['--pack', stagedPath, ...(enable ? ['--enable', '1'] : [])])
        try { rmSync(stagedPath, { force: true }) } catch {}
        return afterCli(v)
      })
      try { rmSync(stagedPath, { force: true }) } catch {}
      return r
    },
    /** 确认权限并启用：CLI 写授权 + 启用意图，然后走回执流。 */
    grant (packId) {
      return exclusive(async () => afterCli(await cli('grant', ['--pack-id', String(packId || '')])))
    },
    /** 停用：保留下载，只撤加载。 */
    disable (packId) {
      return exclusive(async () => afterCli(await cli('disable', ['--pack-id', String(packId || '')])))
    },
    /** 卸载：移除注册表条目与版本目录；桌宠在运行就发 reload 让窗口撤掉（失败由 mtime 门控自愈）。 */
    uninstall (packId) {
      return exclusive(async () => {
        const v = await cli('uninstall', ['--pack-id', String(packId || '')])
        if (!v.ok) return v
        try { await send({ cmd: 'packs', action: 'reload', generation: v.generation }) } catch {}
        return v
      })
    },
    /**
     * 清旧版本（previous）。默认只清过了保留期的（宿主启动时调一次）；force + packId = 设置页「清理旧版本」。
     * 在役版本不动、不改激活代次，所以桌宠不用重载。
     */
    prunePrevious ({ packId = '', force = false } = {}) {
      return exclusive(async () => cli('prune-previous', [...(packId ? ['--pack-id', String(packId)] : []), ...(force ? ['--force', '1'] : [])]))
    },
    confirmPending () {
      return exclusive(async () => {
        const reg = readRegistry()
        const failures = []
        for (const [id, entry] of Object.entries(reg.packs)) {
          const ptr = loadPointer(entry)
          if (entry.state !== 'installed-disabled' || !ptr) continue
          const r = await receiptFlow({ ok: true, id, generation: reg.generation, furnitureIds: ptr.furnitureIds, characterIds: ptr.characterIds })
          if (r.receipt?.petRunning === false) return { ...r, failures }
          if (!r.ok) failures.push(r)
        }
        return { ok: !failures.length, failures }
      })
    },
    /** 给页面的实况：注册表 + 进度 + 是否在装。 */
    status () {
      return { running: !!busy, registry: readRegistry(), progress: readProgress() }
    },
    get running () { return !!busy },
  }
}
