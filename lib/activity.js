/**
 * Follow the pointed session's own state on the pet: working / done / failed / waiting.
 * Session events (DSH): turn/start, turn/end {reason.kind: completed | error | aborted},
 * approval/asked, approval/decided. Only the session chosen in settings.voice.llm.sessionId counts.
 */
export function activityFor (event) {
  if (!event || typeof event.type !== 'string') return null
  switch (event.type) {
    case 'turn/start': return 'working'
    case 'turn/end': {
      const k = event.data && event.data.reason && event.data.reason.kind
      return k === 'error' ? 'failed' : k === 'aborted' ? 'idle' : 'done'
    }
    case 'approval/asked': return 'waiting'
    case 'approval/decided': return 'working'
    default: return null
  }
}

/** onEvent(session, event) -> sends {cmd:'activity', state} for the target session; never throws */
export function createActivityFollower ({ targetId, send, keyOf }) {
  let last = null
  let lastTarget = null
  return (session, event) => {
    try {
      const want = keyOf(targetId())
      // switching the pointed session starts over: its first state must not be swallowed as a repeat
      if (want !== lastTarget) { lastTarget = want; last = null }
      if (!want || keyOf(session && session.id) !== want) return
      const state = activityFor(event)
      if (!state || (state === last && state !== 'done')) return
      last = state
      Promise.resolve(send({ cmd: 'activity', state })).catch(() => {})
    } catch {}
  }
}
