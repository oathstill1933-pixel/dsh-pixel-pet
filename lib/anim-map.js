/**
 * 工具名 → 桌宠动作 映射（桌宠过程动画扩展 · P0 起）
 *
 * 设计要点：
 * - 只做「映射」，不掺业务流程：activity.js 仍然负责会话级常驻状态，
 *   本文件只回答「这个工具该演什么动作、演多久」。
 * - 先不依赖新素材：`PENDING` 里的状态名是计划中的正式状态，
 *   在对应帧到位之前，`CURRENT` 把它们临时指向已有的状态（不会报错、也不会白屏）。
 * - 未知工具不返回动作（返回 null），保持常驻状态，避免乱跳。
 *
 * 素材到位后，只需把 CURRENT 里对应的别名删掉/改掉，不需要动任何调用点。
 */

/** 只有复用旧素材的状态保留别名；已安装的正式动作直接按计划名发送。
 * Python 端仍保留缺帧回退，其他角色没有新素材时不会白屏。
 */
export const CURRENT = {
  oops: 'mood-oops'
}

/** 精确匹配：工具名 → { state, ms } */
export const EXACT = {
  // 搜索 / 读网页
  web_search: { state: 'searching', ms: 900 },
  web_fetch: { state: 'reading', ms: 900 },
  // 每次播放完整一轮；瞬时动作仍不超过 1.2 秒。
  read: { state: 'reading', ms: 900 },
  glob: { state: 'searching', ms: 900 },
  grep: { state: 'searching', ms: 900 },
  // 写文件
  write: { state: 'writing', ms: 900 },
  edit: { state: 'writing', ms: 900 },
  // 跑命令
  bash: { state: 'typing', ms: 900 },
  pwsh: { state: 'typing', ms: 900 },
  // 子代理 / 编排
  subagent: { state: 'calling', ms: 900 },
  subagent_fork: { state: 'calling', ms: 900 },
  subagent_claude_code: { state: 'calling', ms: 900 },
  workflow: { state: 'calling', ms: 900 },
  // 看图 / 截图
  read_image: { state: 'shooting', ms: 780 },
  screenshot: { state: 'shooting', ms: 780 },
  dsh_browser_screenshot: { state: 'shooting', ms: 780 },
  // 交互卡：提问
  ask_user_question: { state: 'asking', ms: 0 }
}

/** 前缀匹配：一份工具族共用一个动作 */
export const PREFIX = [
  ['pixelpet_', null],       // 桌宠自己的工具不演动作（否则它自己动来动去很怪）
  // 派活儿的另一半：团队任务板与跨代理通信，和 subagent 一样演「招呼帮手」
  ['team_task_', { state: 'calling', ms: 900 }],
  ['send_message', { state: 'calling', ms: 900 }],
  ['list_agents', { state: 'calling', ms: 900 }],
  ['iconsmith_', { state: 'painting', ms: 900 }],
  ['codex_image', { state: 'painting', ms: 900 }],
  ['todo_', { state: 'noting', ms: 900 }],
  ['dtodo_', { state: 'noting', ms: 900 }],
  ['schedule_', { state: 'noting', ms: 900 }],
  ['mcp_connector_', { state: 'reading', ms: 900 }]
]

/** 会话级事件 → 动作（审批/提问这类没有工具名的场景走这里） */
export const EVENTS = {
  'approval/asked': { state: 'pleading', ms: 0 },      // 0 = 保持到事件结束
  'approval/decided': { state: 'ack', ms: 900 },        // 单次动作
  'question/asked': { state: 'asking', ms: 0 },
  'tool/error': { state: 'oops', ms: 700 }              // tool/result 里 isError===true
}

/** 把计划状态翻译成当前可播的状态；没有别名就原样返回 */
export function resolveState (state) {
  return CURRENT[state] || state
}

/**
 * 工具名 → 动作。返回 { state, ms } 或 null。
 * @param {string} name 工具名（大小写不敏感，带不带命名空间都行）
 */
export function animForTool (name) {
  if (typeof name !== 'string' || !name) return null
  const raw = name.trim()
  const key = raw.toLowerCase()
  const hit = EXACT[key] || EXACT[raw]
  if (hit) return { state: resolveState(hit.state), plan: hit.state, ms: hit.ms }
  for (const [prefix, anim] of PREFIX) {
    if (!key.startsWith(prefix)) continue
    if (!anim) return null
    return { state: resolveState(anim.state), plan: anim.state, ms: anim.ms }
  }
  return null
}

/** 会话事件 → 动作。返回 { state, ms } 或 null。 */
export function animForEvent (type) {
  const hit = EVENTS[type]
  if (!hit) return null
  return { state: resolveState(hit.state), plan: hit.state, ms: hit.ms }
}

/** 动作时长上限（单次 ≤1.2s）；0 表示由事件本身决定 */
export const MAX_MS = 1200

export function clampMs (ms) {
  const n = Number(ms) || 0
  if (n <= 0) return 0
  return Math.min(n, MAX_MS)
}
