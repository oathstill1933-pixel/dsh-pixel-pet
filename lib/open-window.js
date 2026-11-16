/**
 * Open a plugin page as a small chromeless app window from the host side.
 * The settings page lives in an iframe inside DSH, whose window.open is denied for http URLs,
 * so pages (create, furniture, mailbox, listen) are opened here instead. Same browser search as runtime mailbox.py.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 首次打开的大小。Edge 的 --app 窗口按页面地址记住用户拖过的位置和大小（Preferences 的
// app_window_placement），之后就以它为准，这里只决定第一次。日历窗 930×735 是 X 用顺手的大小。
export const PAGES = { create: [980, 820], mailbox: [460, 720], calendar: [930, 735] }

/** whitelisted page path relative to the plugin prefix, or null */
export function pagePath (page) {
  if (typeof page !== 'string' || page.length > 120) return null
  const m = /^(create|mailbox)(\?(kind=furniture|id=[A-Za-z0-9_-]{1,64}))?$/.exec(page)
  return m ? { path: page, size: PAGES[m[1]] } : null
}

function browser () {
  const names = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']]
  for (const env of ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']) {
    const root = process.env[env]
    if (!root) continue
    for (const parts of names) { const p = join(root, ...parts); if (existsSync(p)) return p }
  }
  return null
}

export function openWindow (url, size = [980, 820], spawnFn = spawn) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return false
  const opts = { detached: true, stdio: 'ignore', windowsHide: false }
  try {
    const exe = process.platform === 'win32' ? browser() : null
    const child = exe
      ? spawnFn(exe, ['--app=' + url, '--window-size=' + size[0] + ',' + size[1]], opts)
      : process.platform === 'win32' ? spawnFn('cmd', ['/c', 'start', '', url], { ...opts, windowsHide: true })
        : spawnFn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts)
    if (child && typeof child.unref === 'function') { child.on && child.on('error', () => {}); child.unref() }
    return true
  } catch { return false }
}
