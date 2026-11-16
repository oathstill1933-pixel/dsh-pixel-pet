// Real-browser lead probes. Only new temporary HTML and loopback canary servers; no user browser profile.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createCardRenderer } from '../lib/mail-render.js'

async function probe (makeHtml) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pixelpet-card-security-lead-')))
  let capture; let shot
  const hits = []
  try {
    capture = createServer((req, res) => {
      hits.push(req.url)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><body>SYNTHETIC ESCAPE CANARY</body>')
    })
    await new Promise((r) => capture.listen(0, '127.0.0.1', r))
    const target = 'http://127.0.0.1:' + capture.address().port + '/escape-canary'
    const file = join(root, 'fixture.html')
    writeFileSync(file, makeHtml(target), 'utf8')
    const render = createCardRenderer({ browser: process.env.PIXELPET_TEST_BROWSER, timeoutMs: 20000, size: [800, 600] })
    shot = await render({ html: file, files: [{ path: file }] })
    assert.ok(shot, 'renderer must produce a real screenshot for the synthetic card')
    const bytes = readFileSync(shot.path)
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    return { hits, pngBytes: bytes.length }
  } finally {
    shot?.cleanup()
    if (capture) await new Promise((r) => capture.close(r))
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-card-security-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
}
const options = { skip: !process.env.PIXELPET_TEST_BROWSER, timeout: 45000 }

test('real browser: infinite card script times out without leaving its owned profile or browser processes', { ...options, skip: !process.env.PIXELPET_TEST_BROWSER || process.platform !== 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pixelpet-card-security-lead-')))
  let launch
  try {
    const html = join(root, 'loop.html')
    writeFileSync(html, '<!doctype html><html><body><script>while(true){}</script></body></html>')
    const render = createCardRenderer({ browser: process.env.PIXELPET_TEST_BROWSER, timeoutMs: 2200, onLaunch: (info) => { launch = info } })
    const result = await render({ html, files: [{ path: html }] })
    assert.equal(result, null)
    assert.ok(launch?.profile)
    const marker = Buffer.from(launch.profile, 'utf8').toString('base64')
    const script = "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + marker + "'));@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($m,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count"
    const exe = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const check = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(check.status, 0, check.stderr)
    assert.equal(Number(check.stdout.trim()), 0, 'only processes carrying this fresh profile are observed')
    assert.equal(existsSync(launch.profile), false)
  } finally {
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-card-security-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
})

test('real browser positive control: inline animation code runs and a same-letter image renders', { ...options, skip: !process.env.PIXELPET_TEST_BROWSER || !process.env.PIXELPET_TEST_PYTHON }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pixelpet-card-security-lead-')))
  let shot
  try {
    const html = join(root, 'positive.html'); const image = join(root, 'square.png')
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync(html, '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#ff0000}img{position:absolute;left:100px;top:100px;width:32px;height:32px;image-rendering:pixelated}</style></head><body><img src="square.png"><script>document.documentElement.style.background="#00ff00";document.body.style.background="#00ff00";document.body.append("SCRIPT OK");</script></body></html>')
    const render = createCardRenderer({ browser: process.env.PIXELPET_TEST_BROWSER, timeoutMs: 20000, size: [800, 600] })
    shot = await render({ html, files: [{ path: html }, { path: image }] })
    assert.ok(shot)
    const proof = spawnSync(process.env.PIXELPET_TEST_PYTHON, ['-c', 'from PIL import Image; import json,sys; im=Image.open(sys.argv[1]).convert("RGB"); print(json.dumps([im.getpixel((10,100)),im.getpixel((110,110))]))', shot.path], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(proof.status, 0, proof.stderr)
    assert.deepEqual(JSON.parse(proof.stdout), [[0, 255, 0], [255, 0, 0]], 'green proves script execution; red proves sibling image load')
    if (process.env.PIXELPET_CARD_EVIDENCE) copyFileSync(shot.path, process.env.PIXELPET_CARD_EVIDENCE, constants.COPYFILE_EXCL)
  } finally {
    shot?.cleanup()
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-card-security-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
})

test('real browser: a card meta-refresh cannot navigate to another loopback service', options, async () => {
  const result = await probe((target) => '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=' + target + '"></head><body>Fixture</body></html>')
  assert.deepEqual(result.hits, [], 'CSP default-src and DNS rules alone do not block document navigation')
})

test('real browser: a card script cannot navigate its own frame to another loopback service', options, async () => {
  const result = await probe((target) => '<!doctype html><html><body>Fixture<script>location.href=' + JSON.stringify(target) + '</script></body></html>')
  assert.deepEqual(result.hits, [], 'the embedding parent must constrain the card frame navigation')
})

test('real browser: card images/fetch/forms/popups cannot contact another loopback service', options, async () => {
  const result = await probe((target) => '<!doctype html><html><body><img src="' + target + '"><form id="f" action="' + target + '"><input name="x" value="fixture"></form><script>fetch(' + JSON.stringify(target) + ').catch(()=>{});try{document.getElementById("f").submit()}catch{};window.open(' + JSON.stringify(target) + ');</script></body></html>')
  assert.deepEqual(result.hits, [])
})
