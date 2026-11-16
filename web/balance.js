// DeepSeek 余额一行（GET/POST /api/balance*，见 lib/balance.js）。Key 只写不读，页面从不拿到它。
(() => {
  const $ = (id) => document.getElementById(id)
  if (!$('dsBal')) return
  const api = (path, body) => fetch('api/balance' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null)
  const sym = (c) => (c === 'USD' ? '$' : '¥')
  const fmt = (c, n) => (n == null ? '—' : sym(c) + Number(n).toFixed(2))
  const render = (v) => {
    if (!v || !v.ok) return
    const b = v.balance
    $('dsInject').checked = v.inject !== false
    const amt = $('dsAmt')
    amt.textContent = !v.official ? '不可用' : b ? fmt(b.currency, b.total) : '—'
    amt.dataset.s = b && v.official ? (b.isAvailable === false ? 'bad' : b.low ? 'low' : '') : ''
    const tip = []
    if (b && v.official) {
      tip.push('赠送 ' + fmt(b.currency, b.granted) + ' · 充值 ' + fmt(b.currency, b.toppedUp))
      if (b.isAvailable === false) tip.push('余额不足，API 不可用')
      tip.push(new Date(b.at).toLocaleString())
    }
    amt.title = tip.join('\n')
    $('dsRefresh').disabled = !v.configured || !v.official
    if (document.activeElement !== $('dsThr')) $('dsThr').value = v.threshold
    $('dsKey').placeholder = v.configured ? '••••••••' : ''
    $('dsState').dataset.s = !v.configured ? '' : !v.official ? 'bad' : b ? 'ok' : 'degraded'
  }
  const load = () => api('').then(render)
  $('dsRefresh').addEventListener('click', () => {
    const btn = $('dsRefresh'); btn.classList.add('spin')
    api('/refresh', {}).then((v) => { btn.classList.remove('spin'); render(v) })
  })
  $('dsThr').addEventListener('change', (e) => {
    const n = Number(e.target.value)
    if (Number.isFinite(n) && n >= 0) api('/settings', { threshold: n }).then(render)
  })
  $('dsInject').addEventListener('change', (e) => { api('/settings', { inject: e.target.checked }).then(render) })
  $('dsKey').addEventListener('change', (e) => {
    const v = e.target.value.trim(); e.target.value = ''
    if (v) api('/settings', { key: v }).then(render)
  })
  load()
})()
