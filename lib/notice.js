/**
 * 位置行为：让桌宠「跑过去看一眼」（P0）。
 *
 * 触发来源（都只在绑定的那个会话上生效）：
 * - 用户消息里带「检查一下 / 看看 / 查一下 / 瞄一眼」→ 跑到当前窗口旁边站一会儿
 * - 审批卡出现 → 跑到窗口旁边（不挡按钮，具体站位由桌宠自己算）
 * - 插件自己的页面被打开（创建 / 信件 / 日历）→ 窗口起来后再过去
 *
 * 所有「动不动」的政策都在桌宠那侧（runtime/pixelpet/app.py 的 move_guard）：
 * 「别乱走」开着、前台全屏、正被拿着、一分钟走太多次 —— 都会安静不动，并且不算失败。
 * 本文件只负责「什么时候想让它过去」，以及去重（同一时间只跑一趟）。
 */

export const CHECK_WORDS = /检查|查看|看一眼|看看|瞄一眼|瞅一眼|查一下|查查|查一次/
/** 只认短句里的「看/查」：长段落里的“检查”多半不是在叫它过去 */
export const CHECK_MAX_CHARS = 60

/** 从 user/message 事件里尽量稳地取出用户文本（不同版本字段略有差异） */
export function userTextOf (event) {
  const d = event && event.data
  if (!d || typeof d !== 'object') return ''
  if (typeof d.text === 'string') return d.text
  const m = d.message
  if (typeof m === 'string') return m
  if (m && typeof m.content === 'string') return m.content
  const parts = (x) => (Array.isArray(x) ? x.map((p) => (p && (p.text || p.content)) || '').join(' ') : '')
  if (m && Array.isArray(m.content)) return parts(m.content)
  if (typeof d.content === 'string') return d.content
  if (Array.isArray(d.content)) return parts(d.content)
  return ''
}

/**
 * @param {{
 *   send: (body: any) => any,
 *   targetId?: () => string,
 *   keyOf?: (id: any) => string,
 *   enabled?: () => boolean,
 *   now?: () => number,
 *   gapMs?: number,          // 两次「跑过去」的最小间隔，默认 8s
 *   setTimer?: (fn: () => void, ms: number) => any
 * }} o
 */
export function createNotifier ({ send, targetId, keyOf, enabled = () => true, now = Date.now, gapMs = 8000, setTimer }) {
  const later = setTimer || ((fn, ms) => setTimeout(fn, ms))
  let last = 0
  let parked = false   // 发过「审批：过去待着」：审批点完才需要叫它回原位

  const bound = (session) => {
    if (typeof targetId !== 'function' || typeof keyOf !== 'function') return true
    let want = ''
    try { want = keyOf(targetId()) } catch { return false }
    if (!want) return false
    try { return keyOf(session && session.id) === want } catch { return false }
  }

  const notice = (opts = {}) => {
    try {
      if (!enabled()) return false
      const t = now()
      if (t - last < gapMs) return false
      last = t
      const body = { cmd: 'notice' }
      if (opts.anchor) body.anchor = opts.anchor
      if (opts.holdMs) body.holdMs = opts.holdMs
      // stay 必须真的发过去：桌宠那侧靠它决定「到了就待着、等审批结束」，漏掉就会 2.5 秒后自己走回去
      if (opts.stay) { body.stay = true; parked = true }
      Promise.resolve(send(body)).catch(() => {})
      return true
    } catch { return false }
  }

  const onUserMessage = (session, text) => {
    if (typeof text !== 'string' || !text.trim()) return false
    if ([...text].length > CHECK_MAX_CHARS) return false
    if (!CHECK_WORDS.test(text)) return false
    return notice({ anchor: 'active-window', holdMs: 3200 })
  }

  const onEvent = (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      if (!bound(session)) return
      // 审批：过去就待着，不再自己跑回来；审批点完再走回原位一次。
      // 审批卡连着弹时不受 8 秒间隔限制：已经待在那儿的话桌宠侧会回「已经在窗口旁边了」。
      if (event.type === 'approval/asked') { last = 0; notice({ anchor: 'active-window', stay: true }); return }
      if (event.type === 'approval/decided') {
        // 只有这一趟真的「过去待着」了才叫它回来；没去成（别乱走 / 全屏 / 正忙）就别凭空把它从原地拽走
        if (!parked) return
        parked = false
        try { Promise.resolve(send({ cmd: 'move_to', anchor: 'home', wait: false })).catch(() => {}) } catch {}
        return
      }
      if (event.type === 'user/message') { onUserMessage(session, userTextOf(event)); return }
    } catch { /* 看一眼失败不能影响会话 */ }
  }

  /** 插件自己的页面刚打开：等窗口真的起来了再过去 */
  const onPageOpen = (delayMs = 800) => {
    try { later(() => notice({ anchor: 'active-window', holdMs: 2800 }), delayMs) } catch {}
  }

  return { notice, onEvent, onUserMessage, onPageOpen }
}
