/**
 * dsh-pixel-pet client module: one sidebar row that opens the settings page (/dsh-pixel-pet/) in an overlay.
 * Self-heals when the sidebar re-renders (early exit when the row is already in place).
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixel-pet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const PREFIX = '/dsh-pixel-pet'
    const ROW_ATTR = 'data-dsh-pixelpet-entry'
    const SIDEBAR = '[data-pane="sidebar"], [class*="sidebarCol" i]'
    const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
      '<rect x="3" y="2" width="2" height="2"/><rect x="11" y="2" width="2" height="2"/><rect x="3" y="4" width="10" height="7"/>' +
      '<rect x="2" y="11" width="3" height="3"/><rect x="11" y="11" width="3" height="3"/></svg>'
    let overlay = null

    exports.inject = []

    exports.apply = function apply (ctx) {
      if (typeof document === 'undefined') return
      heal()
      const obs = new MutationObserver(heal)
      obs.observe(document.body, { childList: true, subtree: true })
      const onKey = (e) => { if (e.key === 'Escape' && overlay) close() }
      window.addEventListener('keydown', onKey)
      ctx.effect(() => () => {
        obs.disconnect()
        window.removeEventListener('keydown', onKey)
        document.querySelectorAll('[' + ROW_ATTR + ']').forEach((n) => n.remove())
        close()
      })
    }

    function heal () {
      const col = sidebarRoot()
      if (!col) return
      const have = col.querySelector(':scope > [' + ROW_ATTR + ']')
      if (have) return
      document.querySelectorAll('[' + ROW_ATTR + ']').forEach((n) => n.remove())
      const row = document.createElement('div')
      row.setAttribute(ROW_ATTR, '')
      row.setAttribute('role', 'button')
      row.setAttribute('tabindex', '0')
      row.setAttribute('data-dsh-plugin', 'dsh-pixel-pet')
      row.setAttribute('data-dsh-part', 'sidebar-entry')
      row.style.cssText = 'display:flex;align-items:center;gap:7px;padding:6px 10px;margin:1px 8px;border-radius:6px;font-size:12.5px;cursor:pointer;opacity:.85;user-select:none'
      row.innerHTML = ICON + '<span>像素桌宠</span>'
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(127,127,127,.16)' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', open)
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open() })
      col.insertBefore(row, afterBase(col))
    }

    // 和 DSH 其他插件一致：放在官方「插件」按钮下面；找不到就放在 logo 行下面
    function sidebarRoot () {
      const column = document.querySelector(SIDEBAR)
      if (!column) return null
      const logo = column.querySelector('[class*="logoRow" i]')
      return (logo && logo.parentElement) || column.firstElementChild || null
    }

    function afterBase (root) {
      let base = null
      for (const el of root.children) {
        const t = (el.textContent || '').trim()
        if (t === '插件' || t.startsWith('插件')) { base = el; break }
      }
      if (!base) {
        const logo = root.querySelector('[class*="logoRow" i]')
        base = logo && logo.parentElement === root ? logo : root.firstElementChild
      }
      return base ? base.nextSibling : null
    }

    function open () {
      if (overlay) return
      overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center'
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
      const frame = document.createElement('iframe')
      frame.src = PREFIX + '/'
      frame.style.cssText = 'width:min(760px,94vw);height:min(720px,90vh);border:0;border-radius:12px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25)'
      overlay.appendChild(frame)
      document.body.appendChild(overlay)
    }

    function close () {
      if (overlay) { overlay.remove(); overlay = null }
    }

    return module.exports
  },
})
