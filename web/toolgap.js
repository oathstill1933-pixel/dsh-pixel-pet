// 角色窗口旁的小黄点：绑定会话的预设没放行哪些 pixelpet_* 工具（GET api/toolgap，见 lib/session-guard.js）
(() => {
  const $ = (id) => document.getElementById(id)
  const getJson = (p) => fetch(p).then((r) => r.json()).catch(() => null)
  const gap = $('toolGap')
  if (!gap) return
  const dot = gap.querySelector('.toolgap-dot')
  const pop = gap.querySelector('.toolgap-pop')
  const render = (v) => {
    const missing = v && v.ok && v.available && Array.isArray(v.missing) ? v.missing : []
    gap.hidden = !missing.length
    if (!missing.length) { pop.classList.remove('open'); return }
    const p = document.createElement('p')
    p.textContent = '这个会话的预设没放行这些工具' + (v.preset ? '（' + v.preset + '）' : '')
    pop.replaceChildren(p, ...missing.map((n) => { const c = document.createElement('code'); c.textContent = n; return c }))
  }
  const load = () => getJson('api/toolgap').then(render)
  dot.addEventListener('click', () => { const o = pop.classList.toggle('open'); dot.setAttribute('aria-expanded', String(o)) })
  document.addEventListener('click', (e) => { if (!gap.contains(e.target)) pop.classList.remove('open') })
  $('session')?.addEventListener('change', () => setTimeout(load, 300))
  load()
  setInterval(() => { if (!document.hidden && !window.__pixelpetPurged) load() }, 30_000)
})()
