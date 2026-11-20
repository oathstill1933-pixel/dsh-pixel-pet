/**
 * AI-side pet tools (pixelpet_*). Each tool turns its arguments into one control command and POSTs it
 * to the running pet: <data dir>/control.json -> http://127.0.0.1:<port>/cmd, Bearer <token>.
 * The token is read per call, used only in the request header, never logged or returned.
 *
 * Mail tools (pixelpet_mail_*) do not talk to the pet: they go through the host's MailService
 * (local InboxStore; the pet raises its flag from the store's state file).
 */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeScreenTool } from './screen.js'
import { REACTIONS } from './inbox.js'

/** 表情反应的中文名（回执里说人话，2026-11-15） */
const REACT_LABEL = { heart: '红心', happy: '开心', hug: '抱抱', sad: '难过', shock: '震惊', angry: '生气', dislike: '差评' }

export const TOOL_PREFIX = 'pixelpet_'
const CMD_TIMEOUT_MS = 35_000
const NOT_RUNNING = '桌宠没在运行（可在设置页点「启动」）。'
const ANCHORS = ['taskbar', 'active-window', 'home', 'cursor']
const DIRECTIONS = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left']

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** control.json -> { port, token } | null (never throws). */
export function readControl (dataDir) {
  try {
    const c = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'))
    const port = Number(c && c.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof c.token !== 'string' || !c.token) return null
    return { port, token: c.token }
  } catch { return null }
}

/** One command -> { ok, message, data?, running? }. Offline / errors become readable results, never throws. */
export function sendCommand (dataDir, body, timeoutMs = CMD_TIMEOUT_MS) {
  const c = readControl(dataDir)
  if (!c) return Promise.resolve({ ok: false, running: false, message: NOT_RUNNING })
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((done) => {
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; done(r) } }
    let req
    try {
      req = request({
        host: '127.0.0.1', port: c.port, path: '/cmd', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: 'Bearer ' + c.token },
      }, (res) => {
        const chunks = []
        res.on('data', (b) => chunks.push(b))
        res.on('end', () => {
          let j = null
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
          if (res.statusCode === 401) return finish({ ok: false, running: false, message: NOT_RUNNING })
          if (!j || typeof j !== 'object') return finish({ ok: false, message: '桌宠回了看不懂的内容。' })
          const out = { ok: j.ok === true, message: String(j.message || (j.ok ? 'ok' : '失败')).slice(0, 300) }
          if (j.data !== undefined) out.data = j.data
          finish(out)
        })
        res.on('error', () => finish({ ok: false, message: '桌宠连接中断。' }))
      })
    } catch { return finish({ ok: false, running: false, message: NOT_RUNNING }) }
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ ok: false, message: '桌宠没响应。' }) })
    req.on('error', (e) => {
      const refused = e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EHOSTUNREACH')
      finish(refused ? { ok: false, running: false, message: NOT_RUNNING } : { ok: false, message: '桌宠没响应。' })
    })
    req.end(payload)
  })
}

const output = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, v) => [{ type: 'text', text: !v || typeof v !== 'object' ? String(v)
    : v.data === undefined ? String(v.message) : String(v.message) + '\n' + JSON.stringify(v.data, null, 2) }],
}

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false })

/** Tool specs: { name, description, parameters, build(args) -> body | string (refusal) }. */
/**
 * Hidden note for the AI only: rides on the mail_send tool description, never rendered in any window.
 */
export const MAIL_GIFT_HINT = '偶尔——有心意的时候——也可以用这个信箱给对方送一张贺卡，形式随你：HTML、图片、PDF、PPT 都行。' +
  '不必常送，也不用找理由，想到了再送就好。节日或对方生日前后，想送就送。'
export const TOOL_SPECS = [
  {
    name: 'pixelpet_move',
    description: '让桌宠走动。三选一：to 走到固定位置；x+y 走到屏幕坐标（脚落点，像素）；dx 原地左右走（负数向左）。' +
      '可选 pose：到了以后摆的姿势。一分钟内次数有限，被拒时歇一会儿。',
    parameters: obj({
      to: { type: 'string', enum: ANCHORS, description: 'taskbar=任务栏上 / active-window=当前窗口旁 / home=原位 / cursor=鼠标旁' },
      x: { type: 'number', description: '屏幕横坐标（和 y 一起给）' },
      y: { type: 'number', description: '屏幕纵坐标（和 x 一起给）' },
      dx: { type: 'number', description: '水平走多少像素，负数向左' },
      pose: { type: 'string', description: '到了以后的姿势，同 pixelpet_pose 的 name' },
      wait: { type: 'boolean', description: '是否等走到再返回，默认 true' },
    }),
    build (a) {
      const extra = {}
      if (str(a.pose, 40)) extra.pose = str(a.pose, 40)
      if (typeof a.wait === 'boolean') extra.wait = a.wait
      if (num(a.dx) !== undefined) return { cmd: 'walk', dx: a.dx, ...extra }
      if (ANCHORS.includes(a.to)) return { cmd: 'move_to', anchor: a.to, ...extra }
      if (num(a.x) !== undefined && num(a.y) !== undefined) return { cmd: 'move_to', x: a.x, y: a.y, ...extra }
      return '要给 to，或 x 和 y，或 dx。'
    },
  },
  {
    name: 'pixelpet_pose',
    description: '让桌宠摆姿势。name 常用 sit（坐/恢复默认）、lie（躺）、wave（挥手）、jump（跳）、work（工作中）、wait（等待）、done（收工检查）、failed（出错）、listen（认真听），也可以填角色自带的心情名；' +
      '填错会返回可用列表。holdMs 保持多久（毫秒，默认 6000；lie 不给就一直躺）。',
    parameters: obj({
      name: { type: 'string', description: '姿势名' },
      holdMs: { type: 'number', description: '保持毫秒数，500–600000' },
    }, ['name']),
    build (a) {
      const name = str(a.name, 40)
      if (!name) return '要给 name。'
      return { cmd: 'pose', name, ...(num(a.holdMs) !== undefined ? { holdMs: Math.round(a.holdMs) } : {}) }
    },
  },
  {
    name: 'pixelpet_look',
    description: '让桌宠看向某处：target 填 cursor（鼠标）或八个方向之一；或给 x+y 看向屏幕上的点。holdMs 看多久（默认 3000）。',
    parameters: obj({
      target: { type: 'string', enum: ['cursor', ...DIRECTIONS], description: '看哪里；给了 x、y 时可不填' },
      x: { type: 'number', description: '屏幕横坐标' },
      y: { type: 'number', description: '屏幕纵坐标' },
      holdMs: { type: 'number', description: '500–10000 毫秒' },
    }),
    build (a) {
      const hold = num(a.holdMs) !== undefined ? { holdMs: Math.round(a.holdMs) } : {}
      if (num(a.x) !== undefined && num(a.y) !== undefined) return { cmd: 'look', target: { x: a.x, y: a.y }, ...hold }
      const target = a.target === undefined ? 'cursor' : a.target
      if (target !== 'cursor' && !DIRECTIONS.includes(target)) return 'target 用 cursor 或方向（up / up-right / right …）。'
      return { cmd: 'look', target, ...hold }
    },
  },
  {
    name: 'pixelpet_mood',
    description: '给桌宠一个短暂的心情表情，回应聊天里的情绪时用。tag 是角色定义的心情标签（如「开心」）；' +
      '填错会返回可用标签。seconds 持续秒数（1–30，默认 6）。',
    parameters: obj({
      tag: { type: 'string', description: '心情标签' },
      seconds: { type: 'number', description: '1–30' },
    }, ['tag']),
    build (a) {
      const tag = str(a.tag, 40)
      if (!tag) return '要给 tag。'
      return { cmd: 'mood', tag, ...(num(a.seconds) !== undefined ? { seconds: a.seconds } : {}) }
    },
  },
  {
    name: 'pixelpet_say',
    description: '在桌宠头顶冒一个说话气泡。text 要短（一两句，200 字内）；seconds 显示秒数（默认 8）；' +
      'speak=true 时桌宠用当前音色把这句话念出来（本机合成）。',
    parameters: obj({
      text: { type: 'string', description: '气泡里的话' },
      seconds: { type: 'number', description: '显示秒数' },
      speak: { type: 'boolean', description: '是否念出来，默认 false' },
    }, ['text']),
    build (a) {
      const text = str(a.text, 200)
      if (!text) return '要给 text。'
      return { cmd: 'say', text, ...(num(a.seconds) !== undefined ? { seconds: Math.max(1, Math.min(60, a.seconds)) } : {}), ...(a.speak === true ? { speak: true } : {}) }
    },
  },
  {
    name: 'pixelpet_furniture',
    description: '桌面家具。action=list 列出已摆出的家具（id、名字、可用 verb）；action=use 配 id 和 verb 让桌宠走过去互动' +
      '（例如床的 sleep 钻进去睡、wake 出来）。不知道 id 和 verb 时先 list。',
    parameters: obj({
      action: { type: 'string', enum: ['list', 'use'] },
      id: { type: 'string', description: 'use 时必填：家具 id' },
      verb: { type: 'string', description: 'use 时必填：互动名' },
      wait: { type: 'boolean', description: '是否等走到再返回，默认 true' },
    }, ['action']),
    build (a) {
      if (a.action === 'list') return { cmd: 'furniture' }
      if (a.action !== 'use') return 'action 用 list 或 use。'
      const id = str(a.id, 40); const verb = str(a.verb, 40)
      if (!id || !verb) return 'use 要给 id 和 verb，先用 action=list 看。'
      return { cmd: 'use', id, verb, ...(typeof a.wait === 'boolean' ? { wait: a.wait } : {}) }
    },
  },
  {
    name: 'pixelpet_stop',
    description: '让桌宠立刻停下：中断走路、姿势和注视，回到待机。',
    parameters: obj({}),
    build: () => ({ cmd: 'stop' }),
  },
  {
    name: 'pixelpet_mail_send',
    description: '桌宠给用户写一封信：放进桌面信箱，邮筒竖起小旗。body 支持 Markdown。做了图片、网页贺卡、PDF 这类' +
      '送给用户的东西，就用 attachments 一起寄过去（本机文件路径，png/jpg/gif/webp/svg/html/pdf/pptx，单个 10 MB 内，最多 6 个）。' +
      '用户开了 Agently Mail 时，同一封信也会发到用户填的邮箱。别写进涉密或敏感内容。' + MAIL_GIFT_HINT,
    parameters: obj({
      subject: { type: 'string', description: '主题，一句话（200 字内）' },
      body: { type: 'string', description: '正文，Markdown' },
      key: { type: 'string', description: '可选：去重键，同一个 key 只投一次' },
      attachments: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', maxLength: 4096 },
        description: '可选：本机文件路径列表（最多 6 个，推荐绝对路径；相对路径按宿主工作目录解析）。图片显示在信里，HTML 当贺卡打开，PDF 是附件卡片。源文件不移动或删除。',
      },
    }, ['body']),
    async run (a, mail) {
      const body = str(a.body, 20000)
      if (!body) return { ok: false, message: '要给 body。（附件是额外的东西，信也要写一句话）' }
      if (a.attachments !== undefined && (!Array.isArray(a.attachments) || a.attachments.length > 6 || a.attachments.some((x) => typeof x !== 'string' || !x.trim() || x.length > 4096))) {
        return { ok: false, message: '附件应为最多 6 个本机文件路径，不能静默丢弃或截断。' }
      }
      const atts = a.attachments || []
      const r = await mail.sendOut({ subject: str(a.subject, 200) || '', body, key: str(a.key, 120), attachments: atts })
      if (r.archived || r.item?.archived) return { ok: true, message: '这封信以前寄过并已归档或删除，没有重复寄送。', data: { duplicate: true, archived: true } }
      if (r.errors && r.errors.length) {
        return { ok: false, message: '信没寄出：' + r.errors[0] + (r.errors.length > 1 ? '（另有 ' + (r.errors.length - 1) + ' 个问题）' : '') }
      }
      const ext = r.ext
      const tail = !ext ? '' : ext.ok ? '，也发到了用户邮箱' + (ext.screenshot ? '（贺卡附了截图）' : '')
        : '；外发没成功（' + (ext.code || 'failed') + '），信已留在本地信箱'
      const files = (r.item && r.item.attachments) || []
      return {
        ok: true,
        message: '信放进信箱了' + (files.length ? '，带 ' + files.length + ' 个附件' : '') + tail + '。',
        data: {
          id: r.item && r.item.id, unread: mail.store.stats().unread, ...(r.duplicate ? { duplicate: true } : {}),
          ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, kind: f.kind, size: f.size })) } : {}),
          ...(ext ? { external: { ok: ext.ok, code: ext.code } } : {}),
        },
      }
    },
  },
  {
    name: 'pixelpet_mail_list',
    description: '看信箱：用户写给桌宠的信（最新在前，含投递状态 queued / delivered / replied / failed），' +
      '以及桌宠的信用户还有几封没读。unseenOnly=true 只看你还没看过的。看过的会记为已看。',
    parameters: obj({
      limit: { type: 'number', description: '最多几封，1–50，默认 10' },
      unseenOnly: { type: 'boolean', description: '只看没看过的' },
    }),
    async run (a, mail) {
      const lim = Math.max(1, Math.min(50, Math.round(num(a.limit) ?? 10)))
      let items = mail.store.list({ dir: 'in', limit: 400 })
      if (a.unseenOnly === true) items = items.filter((x) => !x.aiSeen)
      items = items.slice(0, lim)
      const st = mail.store.stats()
      const data = {
        unreadByUser: st.unread, newForPet: st.newForPet,
        messages: items.map((x) => ({ id: x.id, createdAt: x.createdAt, via: x.via, status: x.status, ...(x.subject ? { subject: x.subject } : {}),
          body: x.body.slice(0, 2000), ...(x.liked ? { liked: true } : {}), ...(x.reaction ? { reaction: x.reaction } : {}), ...(x.attachments ? { attachments: x.attachments.map((f) => f.filename) } : {}) })),
      }
      mail.store.markSeen(items.map((x) => x.id))
      return { ok: true, message: items.length ? '共 ' + items.length + ' 封。' : '没有信。', data }
    },
  },
  {
    name: 'pixelpet_mail_like',
    description: '给信箱里的一封信留下你的反应（或取消）：用户写给你的、你自己寄出的都行，信上会出现对应的小图标。' +
      'reaction 不填就是一颗小红心；也能表达开心、抱抱、难过、震惊、生气、差评。id 从 pixelpet_mail_list 拿。只是你自己的心意记号，不会通知谁。',
    parameters: obj({
      id: { type: 'string', description: '信的 id' },
      on: { type: 'boolean', description: '默认 true；false 取消' },
      reaction: { type: 'string', enum: REACTIONS, description: '想要的情绪：heart 红心（默认）/ happy 开心 / hug 抱抱 / sad 难过 / shock 震惊 / angry 生气 / dislike 差评' },
    }, ['id']),
    async run (a, mail) {
      const id = str(a.id, 80)
      if (!id) return { ok: false, message: '要给 id，先用 pixelpet_mail_list 看。' }
      const it = mail.store.like(id, a.on !== false, str(a.reaction, 20) || 'heart')
      if (!it) return { ok: false, message: '没找到这封信。' }
      const label = REACT_LABEL[it.reaction || 'heart'] || ''
      return { ok: true, message: it.liked ? '记下了：' + label + '。' : '取消了。', data: { id: it.id, liked: !!it.liked, ...(it.reaction ? { reaction: it.reaction } : {}) } }
    },
  },
  {
    name: 'pixelpet_notice',
    description: '让桌宠跑到某个窗口旁边站一会儿，再自己走回去（「顺路过去看一眼」）。' +
      '用户说「检查一下 X」「看下那个 Y」时用它：match 填 X/Y 里能对上窗口的关键词。' +
      '可以直接填**文件或文件夹的绝对路径**（如 D:\\Projects\\app\\src\\main.js）—— 桌宠会把路径拆成文件名/文件夹名逐个去对窗口标题（编辑器窗口常带文件名、资源管理器窗口带文件夹名）；' +
      '也可以填进程名或窗口标题的一部分（Code、Chrome、报告.docx）。要看的窗口缩在任务栏里时它会去任务栏守着；' +
      '不填 match 就靠到当前前台窗口旁。它自己会判断：开着「别乱走」、前台全屏、正被拖着、一分钟走太多次时会安静不动，回执里说明原因，这不算失败。',
    parameters: obj({
      match: { type: 'string', description: '窗口关键词，可以直接给文件/文件夹的绝对路径；不填=当前前台窗口' },
      anchor: { type: 'string', enum: ['active-window', 'taskbar', 'cursor', 'edge'], description: '没有 match 时靠到哪：active-window 当前窗口（默认）/ taskbar 任务栏 / cursor 鼠标旁 / edge 屏幕右边缘（侧栏那侧）' },
      holdMs: { type: 'number', description: '到了以后站多久（毫秒，600–8000，默认 2500）' },
    }),
    build: (a) => {
      const body = { cmd: 'notice' }
      const m = str(a.match, 60)
      if (m) body.match = m
      if (['active-window', 'taskbar', 'cursor', 'edge'].includes(a.anchor)) body.anchor = a.anchor
      if (num(a.holdMs) !== undefined) body.holdMs = num(a.holdMs)
      return body
    },
  },
  {
    name: 'pixelpet_status',
    description: '查看桌宠现在的状态：是否在运行、角色、当前动作、是否在走、在哪件家具里；另附只读的 DeepSeek API 余额（deepseekBalance）。用户开了「允许感知在做什么」时还附今天的活动摘要（activityToday：各类活动分钟数、常用程序名、现在在干什么；没有窗口标题），用户问「今天干嘛了」时用它。',
    parameters: obj({}),
    build: () => ({ cmd: 'status' }),
  },
]

/**
 * Build DSH tool definitions.
 * @param {{ dataDir: string, enabled: () => boolean, send?: typeof sendCommand, mail?: import('./mail.js').MailService }} o
 */
export function makeTools ({ dataDir, enabled, send = sendCommand, mail = null, furnitureLine = '', screen = null, balance = null, activity = null, care = null }) {
  return TOOL_SPECS.filter((spec) => !spec.run || mail).map((spec) => ({
    name: spec.name,
    // 家具工具的说明后缀「现在摆着：…」，让模型不用先 list 就知道有哪些家具和 verb
    description: spec.name === 'pixelpet_furniture' && furnitureLine
      ? spec.description + '现在摆着：' + furnitureLine + '。'
      : spec.description,
    parameters: spec.parameters,
    output,
    timeoutMs: 45_000,
    async execute (args, exec) {
      if (!enabled()) return { ok: false, message: '设置页已关闭「让 AI 指挥桌宠」。' }
      if (spec.run) {
        try { return await spec.run(args && typeof args === 'object' ? args : {}, mail) } catch (e) {
          return { ok: false, message: '信箱出错：' + String(e && e.message || e).slice(0, 160) }
        }
      }
      const body = spec.build(args && typeof args === 'object' ? args : {})
      if (typeof body === 'string') return { ok: false, message: body }
      const r = await send(dataDir, body)
      if (spec.name === 'pixelpet_status') {
        // 只读 DeepSeek 余额数字（lib/balance.js status()；不含 key），桌宠没开也照样给
        let bal = null
        try { bal = balance ? balance() : null } catch {}
        // 今天的活动摘要（lib/awareness.js；「允许感知在做什么」关着时为 null，不附）
        let today = null
        try { today = activity ? activity() : null } catch {}
        // 主动关心只读状态（lib/proactive.js view()）：被问到「你怎么老提醒我」时能解释
        let careV = null
        try { careV = care ? care() : null } catch {}
        const add = (x, k, v) => (v ? { ...x, data: { ...(x.data && typeof x.data === 'object' ? x.data : {}), [k]: v } } : x)
        return add(add(add(r.running !== false ? { ...r, running: true } : r, 'deepseekBalance', bal), 'activityToday', today), 'care', careV)
      }
      return r
    },
  })).concat(screen ? [{ ...makeScreenTool({ dataDir, enabled, send, ...screen }), when: (s) => s.screen === true }] : []) // pixelpet_screen: lib/screen.js；屏幕感知关着时不注册（不占 token）
}

