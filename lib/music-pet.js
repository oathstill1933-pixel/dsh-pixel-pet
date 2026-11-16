/** Relay the music service's current playback state to the active desktop pet. */
export function createPetMusic ({ enabled, petId, live, send, intervalMs = 3000, staleMs = 5000 }) {
  let active
  let sent = 'off'
  let wanted = 'off'
  let reading = false
  let sending = false
  let epoch = 0
  let deadline
  let closed = false

  async function deliver () {
    if (sending || closed || !active || sent === wanted) return
    sending = true
    const id = active
    const state = wanted
    let result
    try { result = await send({ cmd: 'music', state }) } catch {}
    sending = false
    if (id === active && result?.ok === true) sent = state
    if (id !== active || state !== wanted) void deliver()
  }

  const set = (state) => { wanted = state; void deliver() }

  async function sync () {
    const id = petId()
    if (id !== active) {
      active = id
      sent = wanted = 'off'
      epoch++
      clearTimeout(deadline)
      deadline = null
    }
    if (!id || !enabled()) {
      epoch++
      clearTimeout(deadline)
      deadline = null
      set('off')
      return
    }
    if (closed || reading) return
    reading = true
    const ticket = epoch
    try {
      const snap = await live()
      if (closed || ticket !== epoch || id !== petId() || !enabled()) return
      if (snap?.connected === false) {
        clearTimeout(deadline)
        deadline = null
        set('off')
      } else if (snap?.connected === true && ['playing', 'paused', 'off'].includes(snap.playback)) {
        clearTimeout(deadline)
        deadline = setTimeout(() => set('off'), staleMs)
        deadline.unref?.()
        set(snap.playback)
      }
      await deliver()
    } catch {
      // The watchdog expires the last successful sample after staleMs.
      await deliver()
    } finally {
      reading = false
    }
  }

  const timer = setInterval(() => void sync(), intervalMs)
  timer.unref?.()
  return { sync, dispose () { closed = true; clearInterval(timer); clearTimeout(deadline) } }
}
