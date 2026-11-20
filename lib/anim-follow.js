/**
 * 工具级动作跟随：把「正在用哪个工具」演成桌宠的小动作（P0）。
 *
 * 分工：
 * - `activity.js` 管会话级常驻状态（工作中 / 等你 / 收工），由 turn / approval 事件驱动。
 * - 本文件管**瞬时动作**：一次工具调用演 0.5–1.2 秒，播完自动回落常驻状态，不改会话状态。
 *
 * 事件形状按 DSH 的 session/event 走，但不同版本字段名有过差异，所以工具名用「多形状试探」取，
 * 取不到就安静跳过（绝不猜、绝不白播）。只认设置里绑定的那个会话，和 activity.js 同一口径。
 */
import { animForTool, animForEvent, clampMs } from './anim-map.js'

/** 从一个 session 事件里尽量稳地取出工具名（取不到返回空串） */
export function toolNameOf (event) {
  const d = event && event.data
  if (!d || typeof d !== 'object') return ''
  const candidates = [
    d.name, d.toolName,
    d.tool && d.tool.name, d.call && d.call.name,
    d.header && d.header.name, d.request && d.request.name
  ]
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim()
  return ''
}

/**
 * @param {{
 *   targetId: () => string,      // settings.voice.llm.sessionId
 *   keyOf: (id: any) => string,  // sessionKey
 *   send: (body: any) => any,    // petSend
 *   enabled?: () => boolean,     // 总开关（aiControl / 绑定会话存在感）
 *   now?: () => number,
 *   minGapMs?: number            // 连续工具调用之间的最小间隔，默认 350ms
 * }} o
 */
export function createAnimFollower ({ targetId, keyOf, send, enabled = () => true, now = Date.now, minGapMs = 350, log = null }) {
  let lastAt = 0
  return (session, event) => {
    try {
      if (!enabled()) return
      if (!event || typeof event.type !== 'string') return
      const want = keyOf(targetId())
      if (!want) return
      if (keyOf(session && session.id) !== want) return

      // 审批/提问类事件名在不同 DSH 版本变过，先把真实名字记下来（只记类型名）
      if (/approval|question/.test(event.type) && typeof log === 'function') {
        try { log({ kind: 'event', type: event.type }) } catch {}
      }
      let hit = null
      let toolName = ''
      if (event.type === 'tool/call') {
        toolName = toolNameOf(event)
        if (!toolName) return
        hit = animForTool(toolName)
      } else if (event.type === 'tool/result') {
        // data.message.isError 是 DSH 的失败标记（见 tool/result 的折叠逻辑）
        const m = event.data && event.data.message
        if (m && m.isError === true) hit = animForEvent('tool/error')
      } else if (event.type === 'approval/decided') {
        hit = animForEvent('approval/decided')
      }
      if (!hit) return

      const t = now()
      // 审批收牌是「有意义的确认」，不受间隔限制；普通工具动作间留点间隙，免得刷成万花筒
      if (hit.plan !== 'ack' && hit.plan !== 'oops' && t - lastAt < minGapMs) return
      lastAt = t

      const ms = clampMs(hit.ms)
      const body = { cmd: 'activity', state: hit.state, once: true }
      if (ms > 0) body.ms = ms
      if (hit.plan) body.plan = hit.plan
      try { if (typeof log === 'function') log({ kind: 'send', plan: hit.plan, state: hit.state, ms, tool: toolName || event.type }) } catch {}
      Promise.resolve(send(body)).catch(() => {})
    } catch { /* 一次动作失败不能影响会话 */ }
  }
}
