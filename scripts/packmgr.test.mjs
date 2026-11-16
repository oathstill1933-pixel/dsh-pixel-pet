// node scripts/packmgr.test.mjs — 拓展包管理器（M1）：单飞行、回执流（含否决回滚 / 宠物未运行）、
// 幂等与冲突透传、catalog 校验、host /api/packs/* 路由与导入大小上限。
// spawn / send 全部注入假件；真实 CLI 行为在 tests/test_pack_store.py 里用真 Python 验证。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackManager, PACK_LIMIT, validateCatalog } from '../lib/packmgr.js'
import { permissionIds } from '../lib/packkit.js'

const made = []
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), 'pp-packmgr-' + p + '-')); made.push(d); return d }
process.on('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

let pass = 0; let fail = 0
async function t (name, fn) {
  try { await fn(); pass++; console.log('ok  ', name) } catch (e) { fail++; console.log('FAIL', name, '\n ', e && e.stack || e) }
}

/** 可编程假 spawn：按队列吐最后一行 JSON 判决；记录每次 argv 与 env。 */
function fakeSpawn (queue) {
  const kids = []
  const fn = (py, args, opts) => {
    const kid = new EventEmitter()
    kid.stdout = new EventEmitter()
    kid.stderr = new EventEmitter()
    const v = queue.length ? queue.shift() : { ok: false, code: 'INTERNAL', message: 'queue empty' }
    kids.push({ py, args, opts, v })
    setTimeout(() => {
      kid.stdout.emit('data', Buffer.from(JSON.stringify(v) + '\n'))
      kid.emit('close', v.ok ? 0 : 1)
    }, 5)
    return kid
  }
  fn.kids = kids
  return fn
}

function fakeCtx () {
  const root = tmp('root')
  mkdirSync(join(root, 'contracts'), { recursive: true })
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'pack_cli.py'), '# fake\n')
  return root
}

const CAT_ENTRY = { id: 'petdev.demo', version: '1.0.0', name: '演示包', summary: '', url: 'https://example.invalid/a.petpack', size: 1234, sha256: 'a'.repeat(64), permissions: [] }
const OK_INSTALL = { ok: true, id: 'petdev.demo', version: '1.0.0', generation: 1, furnitureIds: ['demo-lamp'], load: true, state: 'installed-disabled', pendingPermissions: [] }
const OK_UNINSTALL = { ok: true, id: 'petdev.demo', generation: 2, furnitureIds: ['demo-lamp'] }

// --------------------------------------------------------------------------- 回执流

await t('install: happy path — CLI 判决 + 回执确认（loaded 覆盖全部家具）', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }]) // install + receipt
  const sent = []
  const m = createPackManager({ root, dataDir: tmp('d1'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async (body) => { sent.push(body); return { ok: true, data: { ok: true, generation: 1, loaded: ['demo-lamp'] } } } })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, true)
  assert.deepEqual(r.receipt, { petRunning: true, ok: true, loaded: { furniture: ['demo-lamp'], characters: [] }, overridden: {} })
  const inst = sp.kids[0]
  assert.equal(inst.py, 'py-x')
  assert.deepEqual(inst.args.slice(0, 2), ['-X', 'utf8'])
  assert.ok(inst.args.some((a) => a === 'install'))
  assert.deepEqual(inst.args.slice(-8), ['--url', CAT_ENTRY.url, '--sha256', CAT_ENTRY.sha256, '--size', '1234', '--pack-id', 'petdev.demo'])
  assert.equal(inst.opts.env.PYTHONUTF8, '1')
  assert.equal(inst.opts.windowsHide, true)
  assert.equal(sent[0].cmd, 'packs'); assert.equal(sent[0].action, 'reload'); assert.equal(sent[0].generation, 1)
  const rec = sp.kids[1]
  assert.ok(rec.args.includes('receipt'))
  const at = (k) => rec.args[rec.args.indexOf(k) + 1]
  assert.equal(at('--pet-running'), '1')
  assert.equal(at('--ok-flag'), '1') // 修复：成功分支 receipt.ok 不再恒 false
  assert.deepEqual(JSON.parse(at('--loaded')), { furniture: ['demo-lamp'], characters: [] })
})

await t('install: 宠物没运行 → 不发 reload 语义上收不到回执，登记待启动加载，绝不偷偷启动', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }])
  let reloadSent = 0
  const m = createPackManager({ root, dataDir: tmp('d2'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async (body) => { reloadSent++; return { ok: false, running: false, message: '桌宠没在运行' } } })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, true)
  assert.equal(r.receipt.petRunning, false)
  assert.equal(reloadSent, 1) // 发了一次但得到 running:false —— 不重试、不启动
  assert.ok(sp.kids[1].args.includes('--pet-running') && sp.kids[1].args.includes('0'))
})

await t('install: 回执否定 → rollback + 再 reload，最终 E_RECEIPT_FAILED', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }, { ok: true, id: 'petdev.demo' }])
  const sent = []
  const m = createPackManager({ root, dataDir: tmp('d3'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async (body) => { sent.push(body); return body.generation === 1 ? { ok: true, data: { ok: false, message: '重载失败' } } : { ok: true, data: { ok: true, generation: 0, loaded: [] } } } })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_RECEIPT_FAILED')
  assert.ok(sp.kids[1].args.includes('receipt') && sp.kids[1].args.includes('--ok-flag'))
  assert.equal(sp.kids[1].args[sp.kids[1].args.indexOf('--ok-flag') + 1], '0')
  assert.ok(sp.kids[2].args.includes('rollback'))
  assert.equal(sent[1].generation, undefined) // 回退后的恢复 reload 不带代次
})

await t('install: 回执 loaded 缺家具（store 被外部破坏）→ 回滚', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }, { ok: true, id: 'petdev.demo' }])
  const m = createPackManager({ root, dataDir: tmp('d4'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 1, loaded: [] } }) })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_RECEIPT_FAILED')
  assert.ok(r.message.includes('demo-lamp'))
  assert.ok(sp.kids[2].args.includes('rollback'))
})

await t('install: 宠物代次落后（< wantGen）→ E_RECEIPT_FAILED', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }, { ok: true, id: 'petdev.demo' }])
  const m = createPackManager({ root, dataDir: tmp('d5'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 0, loaded: ['demo-lamp'] } }) })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_RECEIPT_FAILED')
  assert.ok(sp.kids[2].args.includes('rollback'))
})

await t('install: CLI 失败（冲突/坏包）原样透传，不碰回执', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([{ ok: false, code: 'E_ID_CONFLICT', message: '家具 id 撞名' }])
  let sent = 0
  const m = createPackManager({ root, dataDir: tmp('d6'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => { sent++; return { ok: true, data: { ok: true, generation: 1, loaded: [] } } } })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_ID_CONFLICT')
  assert.equal(sent, 0)
  assert.equal(sp.kids.length, 1)
})

await t('单飞行：安装中再来的请求直接拒绝', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const kid = new EventEmitter()
  kid.stdout = new EventEmitter()
  kid.stderr = new EventEmitter()
  let n = 0
  const sp = (py, args, opts) => {
    n++
    if (n === 1) return kid // install 这一次挂住，制造"进行中"窗口
    return fakeSpawn([{ ok: true, id: 'petdev.demo' }])(py, args, opts) // 后续 receipt 正常收尾
  }
  const m = createPackManager({ root, dataDir: tmp('d7'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 1, loaded: ['demo-lamp'] } }) })
  const first = m.installFromCatalog('petdev.demo')
  const second = await m.installFromCatalog('petdev.demo')
  assert.equal(second.ok, false)
  assert.ok(second.message.includes('已有拓展包操作'))
  kid.stdout.emit('data', Buffer.from(JSON.stringify(OK_INSTALL) + '\n'))
  kid.emit('close', 0)
  const r = await first
  assert.equal(r.ok, true)
  assert.equal(m.running, false)
})

await t('uninstall: CLI 判决 + 通知宠物 reload；失败透传', async () => {
  const root = fakeCtx()
  const sp = fakeSpawn([OK_UNINSTALL])
  const sent = []
  const m = createPackManager({ root, dataDir: tmp('d8'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async (b) => { sent.push(b); return { ok: true, data: { ok: true, generation: 2, loaded: [] } } } })
  const r = await m.uninstall('petdev.demo')
  assert.equal(r.ok, true)
  assert.equal(sent[0].action, 'reload')
})

// --------------------------------------------------------------------------- M1 审查修复

await t('回执：宠物代次超前（>= wantGen）也算追上', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }])
  const m = createPackManager({ root, dataDir: tmp('m1'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 42, loaded: ['demo-lamp'] } }) })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, true)
  assert.equal(sp.kids.length, 2)
  assert.ok(!sp.kids.some((k) => k.args.includes('rollback')))
})

await t('回执：家具被用户层同名覆盖 → 报告覆盖者，不判失败不回滚', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }])
  const m = createPackManager({ root, dataDir: tmp('m2'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 1, loaded: [], all: { 'demo-lamp': 'user' } } }) })
  const r = await m.installFromCatalog('petdev.demo')
  assert.equal(r.ok, true)
  assert.deepEqual(r.receipt.overridden, { 'demo-lamp': 'user' })
  const rec = sp.kids[1].args
  assert.equal(rec[rec.indexOf('--ok-flag') + 1], '1')
  assert.equal(rec[rec.indexOf('--overridden') + 1], '{"demo-lamp":"user"}')
  assert.ok(!sp.kids.some((k) => k.args.includes('rollback')))
})

await t('权限门：CLI 判 load=false（待授权）→ 不收回执，返回 needsAuthorization；grant 后才走回执', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const waiting = { ...OK_INSTALL, load: false, state: 'waiting-authorization', furnitureIds: [], pendingPermissions: ['docs.read'] }
  const granted = { ok: true, id: 'petdev.demo', generation: 2, load: true, state: 'installed-disabled', furnitureIds: ['demo-lamp'] }
  const sp = fakeSpawn([waiting, granted, { ok: true, id: 'petdev.demo' }])
  const sent = []
  const m = createPackManager({ root, dataDir: tmp('m3'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async (b) => { sent.push(b); return { ok: true, data: { ok: true, generation: b.generation ?? 1, loaded: b.generation === 2 ? ['demo-lamp'] : [] } } } })
  const r = await m.installFromCatalog('petdev.demo', { enable: true })
  assert.equal(r.ok, true)
  assert.equal(r.needsAuthorization, true)
  assert.ok(sp.kids[0].args.includes('--enable'))
  assert.equal(sp.kids.length, 1) // 没有 receipt
  const g = await m.grant('petdev.demo')
  assert.equal(g.ok, true)
  assert.ok(sp.kids[1].args.includes('grant'))
  assert.ok(sp.kids[2].args.includes('receipt'))
  assert.equal(g.receipt.ok, true)
})

await t('busy 锁覆盖回执等待期：reload 挂起时第二个请求（含卸载）被拒', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const sp = fakeSpawn([OK_INSTALL, { ok: true, id: 'petdev.demo' }])
  let releaseSend
  const gate = new Promise((resolve) => { releaseSend = resolve })
  const m = createPackManager({ root, dataDir: tmp('m4'), python: () => 'py-x', spawn: sp, permissionIds: permissionIds(),
    send: async () => { await gate; return { ok: true, data: { ok: true, generation: 1, loaded: ['demo-lamp'] } } } })
  const first = m.installFromCatalog('petdev.demo')
  while (sp.kids.length < 1) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 30)) // install CLI 已结束，正在等回执
  assert.equal(m.running, true)
  const u = await m.uninstall('petdev.demo')
  assert.equal(u.ok, false)
  assert.ok(u.message.includes('已有拓展包操作'))
  assert.equal(sp.kids.length, 1) // 卸载 CLI 根本没被拉起
  releaseSend()
  assert.equal((await first).ok, true)
  assert.equal(m.running, false)
})

// --------------------------------------------------------------------------- catalog

await t('catalog: 合法条目通过；任一不合法 = 整目录 E_CATALOG_INVALID', () => {
  const perms = permissionIds()
  const good = validateCatalog({ v: 1, entries: [CAT_ENTRY] }, perms)
  assert.equal(good.error, undefined)
  assert.equal(good.entries.length, 1)
  for (const bad of [
    { v: 1, entries: [{ ...CAT_ENTRY, url: 'http://intranet/x' }] },                       // 非回环 http 拒
    { v: 1, entries: [{ ...CAT_ENTRY, sha256: 'zz' }] },
    { v: 1, entries: [{ ...CAT_ENTRY, size: -1 }] },
    { v: 1, entries: [{ ...CAT_ENTRY, id: 'nodot' }] },
    { v: 1, entries: [{ ...CAT_ENTRY, permissions: ['magic'] }] },
    { v: 2, entries: [] },
  ]) {
    assert.equal(validateCatalog(bad, perms).error, 'E_CATALOG_INVALID', JSON.stringify(bad).slice(0, 60))
  }
  // 回环 http 是测试例外，允许
  assert.equal(validateCatalog({ v: 1, entries: [{ ...CAT_ENTRY, url: 'http://127.0.0.1:9/x' }] }, perms).error, undefined)
})

await t('installFromCatalog: 目录里没有该包 → E_CATALOG_INVALID 语义的拒绝', async () => {
  const root = fakeCtx()
  writeFileSync(join(root, 'contracts', 'catalog.json'), JSON.stringify({ v: 1, entries: [CAT_ENTRY] }))
  const m = createPackManager({ root, dataDir: tmp('d9'), python: () => 'py-x', spawn: fakeSpawn([]), permissionIds: permissionIds(),
    send: async () => ({ ok: true, data: { ok: true, generation: 1, loaded: [] } }) })
  const r = await m.installFromCatalog('petdev.nope')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_CATALOG_INVALID')
})

// --------------------------------------------------------------------------- host 路由

const { PassThrough } = await import('node:stream')

function routeHarness (packmgr) {
  return import('../lib/host.js').then(async (H) => {
    const routes = []
    const ctx = {
      logger: { warn () {}, info () {} },
      get: (n) => ({ webServer: { register (r) { routes.push(r); return () => {} } }, sessions: { list: async () => [] }, sessionTitle: null, tools: null })[n],
      agents: { get: () => null },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      _emit () {},
    }
    H.apply(ctx, { dataDir: tmp('host-d'), autoInstall: false, packManager: packmgr, pythonManager: { path: 'py-x', quick: () => '', detect: async () => ({}), snapshot: () => ({}) } })
    const route = routes[0].handler
    const call = async (method, path, { body, headers, raw } = {}) => {
      const req = new PassThrough()
      req.url = '/dsh-pixel-pet' + path
      req.method = method
      req.headers = { host: '127.0.0.1', ...(headers || {}) }
      const res = { statusCode: 0, headers: null, body: null, writeHead (c, h) { this.statusCode = c; this.headers = h }, end (b) { this.body = b } }
      if (raw && !('content-type' in req.headers)) req.headers['content-type'] = 'application/octet-stream'
      if (raw) req.headers['content-length'] = String(raw.length)
      const done = route(req, res)
      if (raw) { req.headers['content-length'] = String(raw.length); if (!('content-type' in req.headers)) req.headers['content-type'] = 'application/octet-stream'; req.end(raw) } else if (body !== undefined) { req.headers['content-length'] = String(Buffer.byteLength(JSON.stringify(body))); req.headers['content-type'] = 'application/json'; req.end(JSON.stringify(body)) } else { req.end() }
      await done
      let json = null
      try { json = JSON.parse(res.body?.toString?.() || res.body) } catch { /* binary */ }
      return { status: res.statusCode, json, raw: res.body }
    }
    return { call, route }
  })
}

await t('host 路由：/api/packs/install → 管理器；/api/packs/status；/api/state 带 packs', async () => {
  const calls = []
  const fake = {
    catalog: () => ({ v: 1, entries: [CAT_ENTRY] }),
    status: () => ({ running: false, registry: { v: 1, generation: 3, packs: {} }, progress: null }),
    installFromCatalog: async (id) => { calls.push(['install', id]); return { ok: true, id, receipt: { petRunning: true, loaded: [] } } },
    uninstall: async (id) => { calls.push(['uninstall', id]); return { ok: true, id, furnitureIds: ['demo-lamp'] } },
    installFromFile: async (p) => { calls.push(['file', p]); return { ok: true, receipt: { petRunning: false } } },
  }
  const { call } = await routeHarness(fake)
  const r1 = await call('POST', '/api/packs/install', { body: { packId: 'petdev.demo' } })
  assert.equal(r1.status, 200); assert.equal(r1.json.ok, true)
  assert.deepEqual(calls[0], ['install', 'petdev.demo'])
  const r2 = await call('GET', '/api/packs/status')
  assert.equal(r2.json.catalog.entries[0].id, 'petdev.demo')
  const r3 = await call('GET', '/api/state')
  assert.ok(r3.json.packs && r3.json.packs.catalog)
  const r4 = await call('POST', '/api/packs/uninstall', { body: { packId: 'petdev.demo' } })
  assert.equal(r4.status, 200)
  assert.deepEqual(calls[1], ['uninstall', 'petdev.demo'])
})

await t('host 路由：导入 .petpack 落 .incoming 再交给管理器；超限 413；非 ZIP 400', async () => {
  const files = []
  const fake = {
    catalog: () => ({ v: 1, entries: [] }),
    status: () => ({ running: false, registry: null, progress: null }),
    installFromCatalog: async () => ({ ok: false }),
    uninstall: async () => ({ ok: false }),
    installFromFile: async (p) => { files.push(readFileSync(p)); return { ok: true } },
  }
  const { call, route } = await routeHarness(fake)
  const zipBytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3])
  const r1 = await call('POST', '/api/packs/import?name=demo.petpack', { raw: zipBytes })
  assert.equal(r1.status, 200)
  assert.equal(files.length, 1)
  assert.equal(files[0].toString(), zipBytes.toString())
  const r2 = await call('POST', '/api/packs/import', { raw: Buffer.alloc(10, 7) })
  assert.equal(r2.status, 400) // 没有 PK 魔数
  // content-length 超限：宿主在读 body 之前就得拒绝
  const longReq = new PassThrough()
  longReq.url = '/dsh-pixel-pet/api/packs/import'
  longReq.method = 'POST'
  longReq.headers = { host: '127.0.0.1', 'content-type': 'application/octet-stream', 'content-length': String(PACK_LIMIT + 1) }
  const res = { statusCode: 0, writeHead (c) { this.statusCode = c }, end () {} }
  const done = route(longReq, res)
  longReq.end(Buffer.alloc(16))
  await done
  assert.equal(res.statusCode, 413)
})

await t('host 路由：/api/packs/import CSRF —— 跨域 Origin / cross-site / 非 octet-stream 一律拒，管理器不被调用', async () => {
  const files = []
  const fake = {
    catalog: () => ({ v: 1, entries: [] }),
    status: () => ({ running: false, registry: null, progress: null }),
    installFromFile: async (p, o) => { files.push(o); return { ok: true } },
    grant: async (id) => ({ ok: true, id, granted: true }),
    disable: async (id) => ({ ok: true, id }),
  }
  const { call } = await routeHarness(fake)
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 1])
  assert.equal((await call('POST', '/api/packs/import', { raw: zip, headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await call('POST', '/api/packs/import', { raw: zip, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call('POST', '/api/packs/import', { raw: zip, headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await call('POST', '/api/packs/import', { raw: zip, headers: { 'content-type': 'application/zip' } })).status, 415)
  assert.equal(files.length, 0)
  const ok = await call('POST', '/api/packs/import?enable=1', { raw: zip, headers: { origin: 'http://127.0.0.1' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(files[0], { enable: true })
  const g = await call('POST', '/api/packs/grant', { body: { packId: 'petdev.demo' } })
  assert.equal(g.status, 200); assert.equal(g.json.granted, true)
  assert.equal((await call('POST', '/api/packs/grant', { body: { packId: 'petdev.demo' }, headers: { origin: 'http://evil.example' } })).status, 403)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
