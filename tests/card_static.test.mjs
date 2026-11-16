// node tests/card_static.test.mjs — 听歌小卡: static routes, no Edge window, pet-owned open path
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pagePath } from '../lib/open-window.js'

// the card is a pywebview window owned by the pet now, never a browser --app window
assert.equal(pagePath('card'), null)
for (const bad of ['card/../x', 'card.html', '../card', 'card?x=1', 'cards']) assert.equal(pagePath(bad), null, bad)

const host = readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8')
for (const r of ["path === '/card'", "path === '/card.js' || path === '/card.css'", "path === '/api/card/open'",
  "path === '/api/open' && body.page === 'card'", "{ cmd: 'card', op: 'open' }", '桌宠没有在运行']) assert.ok(host.includes(r), r)
assert.ok(!host.includes("'/api/card/state'"), 'old Edge mode route removed')

const html = readFileSync(new URL('../web/card.html', import.meta.url), 'utf8')
assert.match(html, /<title>pet-listen-card<\/title>/)
assert.match(html, /id="bClose"/)
const js = readFileSync(new URL('../web/card.js', import.meta.url), 'utf8')
assert.ok(js.includes("native('set_mode'") && js.includes("native('close')") && js.includes('contextmenu'))
assert.ok(!js.includes('music/chat') && !js.includes('card/state'))
const win = readFileSync(new URL('../runtime/music/pixelmusic/cardwin.py', import.meta.url), 'utf8')
assert.match(win, /TITLE = "pet-listen-card"/)
assert.ok(!/[A-Z]:\\\\/.test(win) && !/venv\\\\Scripts/.test(win), 'no hard-coded interpreter path')
console.log('card_static ok')
