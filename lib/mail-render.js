/** Real local card screenshots: fresh browser profile, script-free wrapper, sandboxed inner card. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { ATTACH_TYPES, attachmentCsp, readMailFile, regularFileWithin } from './mail-files.js'
import { cardFrameDocument, cardFramePolicy } from './mail-card-frame.js'

function candidates () {
  const dirs = [process.env['ProgramFiles(x86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)
  return [process.env.PIXELPET_BROWSER,
    ...dirs.flatMap((d) => [join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
}
export function findBrowser () {
  for (const p of candidates()) { try { if (p && existsSync(p) && statSync(p).isFile()) return p } catch {} }
  return ''
}
const MIME = (name) => ATTACH_TYPES[extname(name).toLowerCase()]?.mime || 'application/octet-stream'

async function waitForExit (p, ms) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  await new Promise((done) => {
    let timer
    const finish = () => { clearTimeout(timer); p.removeListener('close', finish); p.removeListener('error', finish); done() }
    p.once('close', finish); p.once('error', finish); timer = setTimeout(finish, ms)
  })
}

/** Only processes carrying THIS newly allocated profile marker, never a browser-name/global kill. */
async function stopOwnedBrowser (child, profile, started) {
  if (process.platform === 'win32') {
    const marker = Buffer.from(profile, 'utf8').toString('base64')
    const since = new Date(started).toISOString()
    const script = "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + marker + "'));$s=[datetime]'" + since + "';Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $s.ToUniversalTime() -and $_.CommandLine -and $_.CommandLine.IndexOf($m,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"
    let cleaner
    try {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR
      if (!systemRoot) throw new Error('Windows 系统目录不可用')
      const exe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      cleaner = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
      await waitForExit(cleaner, 6000)
      if (cleaner.exitCode === null && cleaner.signalCode === null) cleaner.kill()
    } catch {}
  }
  if (child && child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {} }
  await waitForExit(child, 3000)
}

function removeOwnedProfile (profile) {
  try {
    const actual = realpathSync(profile)
    if (dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith('pixelpet-card-')) return
    rmSync(actual, { recursive: true, force: true })
  } catch {}
}

export function createCardRenderer ({ browser, logger, timeoutMs = 30000, size = [1000, 1400], onLaunch } = {}) {
  const exe = browser === undefined ? findBrowser() : browser
  return async function snapshot ({ html, files }) {
    if (!exe || !['.html', '.htm'].includes(extname(String(html)).toLowerCase())) return null
    const dir = resolve(html, '..')
    const safeHtml = regularFileWithin(dir, html)
    if (!safeHtml) return null
    const allowed = new Map()
    for (const f of files || []) {
      const safe = regularFileWithin(dir, String(f.path || ''))
      if (safe) allowed.set(basename(safe), safe)
    }
    const htmlName = basename(safeHtml)
    allowed.set(htmlName, safeHtml)
    const token = randomBytes(10).toString('hex')
    const prefix = '/c/' + token + '/'
    let origin = ''; let rawUrl = ''
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method !== 'GET' || !url.pathname.startsWith(prefix)) { res.writeHead(404); return res.end() }
        const name = decodeURIComponent(url.pathname.slice(prefix.length))
        if (name === '_view') {
          const body = Buffer.from(cardFrameDocument(rawUrl))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length,
            'Content-Security-Policy': cardFramePolicy(rawUrl), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), web-share=()' })
          return res.end(body)
        }
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) { res.writeHead(404); return res.end() }
        const file = allowed.get(name)
        if (!file || (name === htmlName && req.headers['sec-fetch-dest'] !== 'iframe')) { res.writeHead(404); return res.end() }
        const body = readMailFile(dir, file)
        if (!body) { res.writeHead(404); return res.end() }
        const policy = name === htmlName ? attachmentCsp(origin, origin + prefix)
          : extname(name).toLowerCase() === '.svg' ? "default-src 'none'; style-src 'unsafe-inline'; sandbox" : null
        res.writeHead(200, { 'Content-Type': name === htmlName ? 'text/html; charset=utf-8' : MIME(name), 'Content-Length': body.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), web-share=()', ...(policy ? { 'Content-Security-Policy': policy } : {}) })
        res.end(body)
      } catch { try { res.writeHead(500); res.end() } catch {} }
    })
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
    origin = 'http://127.0.0.1:' + server.address().port
    rawUrl = origin + prefix + encodeURIComponent(htmlName)
    let profile; let child; let keep = false; let stopped = false
    const started = Date.now()
    try {
      profile = mkdtempSync(join(tmpdir(), 'pixelpet-card-'))
      const shot = join(profile, 'card.png')
      const dimensions = size.map((v) => Math.max(64, Math.min(4096, Math.floor(Number(v) || 1000))))
      const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--force-device-scale-factor=1',
        '--user-data-dir=' + profile, '--window-size=' + dimensions[0] + ',' + dimensions[1],
        // Extra DNS hardening only. The wrapper's frame-src + the inner sandbox/CSP enforce isolation.
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--virtual-time-budget=2500', '--screenshot=' + shot, origin + prefix + '_view']
      const completed = await new Promise((done) => {
        let timer; let settled = false
        const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); done(ok) } }
        try { child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' }) } catch { return finish(false) }
        try { if (typeof onLaunch === 'function') onLaunch({ pid: child.pid, profile }) } catch {}
        timer = setTimeout(() => finish(false), timeoutMs)
        child.once('error', () => finish(false)); child.once('close', (code) => finish(code === 0))
      })
      await stopOwnedBrowser(child, profile, started); stopped = true
      if (!completed) return null
      const png = readFileSync(shot)
      if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') return null
      keep = true
      return { path: shot, cleanup: () => removeOwnedProfile(profile) }
    } catch {
      logger?.warn?.('[dsh-pixel-pet] 贺卡截图未能完成')
      return null
    } finally {
      if (profile && !stopped) await stopOwnedBrowser(child, profile, started)
      if (!keep && profile) removeOwnedProfile(profile)
      server.closeAllConnections?.()
      await new Promise((done) => { try { server.close(done) } catch { done() } })
    }
  }
}
