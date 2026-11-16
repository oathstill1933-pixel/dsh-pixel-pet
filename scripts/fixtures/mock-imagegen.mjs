// Fake OpenAI-compatible image service for tests and screenshots. Never talks to the network.
//   const m = await startMockImagegen({ key: 'test-key' }); m.url -> 'http://127.0.0.1:<port>/v1'
//   m.fail = { status: 429, code: 'insufficient_quota' } | { status: 401 } | { hang: true } | null
//   m.failAfter = N  -> the N+1-th image request fails with m.fail (earlier ones succeed)
//   m.log -> [{ path, n, refs, prompt }]
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** rgba: Uint8Array w*h*4 -> PNG */
export function encodePng (w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]

/** a chunky pixel critter on #00FF00, 8 px cells (so the native-grid converter has something real to find) */
export function drawCritter (prompt, variant = 0) {
  const G = 32; const C = 8; const W = G * C
  const act = (prompt.match(/Action: ([^.\n]*)/) || [, 'idle'])[1]
  const fm = prompt.match(/Frame (\d+) of (\d+)/); const fi = fm ? Number(fm[1]) - 1 : 0
  const look = prompt.match(/direction (\d+) of 16/)
  const palettes = [['#57689B', '#3D3E61', '#FDF2F3', '#74A2CA'], ['#C46A4A', '#6B3326', '#FFF1E6', '#F2B04C'], ['#6A9E5B', '#2F5130', '#F7F3E8', '#E8D36A'], ['#8E6AC4', '#45306B', '#FBF2FF', '#F07FA8']]
  const [body, dark, skin, accent] = palettes[(hash(prompt.split('\n')[1] || '') + variant) % palettes.length].map(hex)
  const grid = Array.from({ length: G }, () => Array(G).fill(null))
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < G && y < G) grid[y][x] = c }
  const lying = /lying|asleep|curled/.test(act)
  const air = /jump/.test(act) ? [0, 0, 4, 2, 0, 0][fi % 6] : /dragged/.test(act) ? 3 : 0
  const bob = /idle|breath|speaking|waiting|listening/.test(act) ? (fi % 2) : 0
  const dx = /LEFT/.test(act) ? -1 : /RIGHT/.test(act) ? 1 : 0
  const cx = 16 + dx; const foot = 29 - air
  if (lying) {
    for (let y = 22; y < 29; y++) for (let x = 7; x < 25; x++) put(x, y, (y === 22 || x === 7 || x === 24) ? dark : body)
    for (let y = 18; y < 26; y++) for (let x = 20; x < 28; x++) put(x, y, (y === 18 || x === 27) ? dark : skin)
    put(22, 22, dark); put(25, 22, dark)
    if (/Zzz|asleep/.test(act)) { put(27, 12 - fi % 2, accent); put(28, 12 - fi % 2, accent); put(28, 13 - fi % 2, accent); put(27, 14 - fi % 2, accent); put(28, 14 - fi % 2, accent) }
  } else {
    for (let y = foot - 9; y < foot; y++) for (let x = cx - 5; x < cx + 5; x++) put(x, y, (x === cx - 5 || x === cx + 4 || y === foot - 1) ? dark : body)
    for (let y = foot - 18 + bob; y < foot - 9 + bob; y++) for (let x = cx - 6; x < cx + 6; x++) put(x, y, (y === foot - 18 + bob || x === cx - 6 || x === cx + 5) ? dark : skin)
    for (let x = cx - 6; x < cx + 6; x++) { put(x, foot - 19 + bob, body); put(x, foot - 20 + bob, body) }
    put(cx + 5, foot - 21 + bob, accent); put(cx + 6, foot - 21 + bob, accent); put(cx + 6, foot - 22 + bob, accent)
    const ex = look ? Math.round(Math.sin(Number(look[1]) * Math.PI / 8) * 1.5) : dx
    const ey = look ? -Math.round(Math.cos(Number(look[1]) * Math.PI / 8) * 1.2) : 0
    put(cx - 3 + ex, foot - 14 + bob + ey, dark); put(cx + 2 + ex, foot - 14 + bob + ey, dark)
    const mouth = /speaking/.test(act) ? [0, 1, 2, 1][fi % 4] : /surprised|oops/.test(act) ? 2 : 0
    for (let m = 0; m < mouth + 1; m++) put(cx - 1 + ex, foot - 12 + bob + m, mouth ? dark : accent)
    const wave = /waving/.test(act) ? fi % 2 : 0
    put(cx - 6, foot - 7 - wave * 3, skin); put(cx + 5, foot - 7 - (wave ? 0 : 0), skin)
    if (wave) { put(cx - 7, foot - 11, skin); put(cx - 7, foot - 12, skin) }
    const step = /walk|run|working/.test(act) ? fi % 2 : 0
    put(cx - 3 + step, foot, dark); put(cx + 2 - step, foot, dark)
    for (let t = 0; t < 4; t++) put(cx + 6 + t, foot - 4 - (t >> 1) + (fi % 2), body) // tail
  }
  const px = new Uint8Array(W * W * 4)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid[(y / C) | 0][(x / C) | 0] || [0, 255, 0]
      const i = (y * W + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
    }
  }
  return encodePng(W, W, px)
}

export function startMockImagegen ({ key = 'test-key', delayMs = 0 } = {}) {
  const m = { log: [], fail: null, failAfter: 0, served: 0, key }
  const reply = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b) }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      if (req.headers.authorization !== 'Bearer ' + m.key) return reply(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })
      if (req.method === 'GET' && req.url === '/v1/models') return reply(res, 200, { data: [{ id: 'gpt-image-2' }, { id: 'other' }] })
      if (req.method !== 'POST' || !/^\/v1\/images\/(generations|edits)$/.test(req.url)) return reply(res, 404, { error: { message: 'not found' } })
      let prompt = ''; let n = 1; let refs = 0
      if (req.url.endsWith('generations')) { const j = JSON.parse(body.toString('utf8')); prompt = j.prompt; n = j.n || 1 } else {
        const t = body.toString('latin1')
        refs = (t.match(/name="image\[\]"/g) || []).length
        const field = (name) => { const r = new RegExp('name="' + name + '"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--'); const mm = t.match(r); return mm ? Buffer.from(mm[1], 'latin1').toString('utf8') : '' }
        prompt = field('prompt'); n = Number(field('n')) || 1
      }
      m.log.push({ path: req.url, n, refs, prompt })
      if (m.fail && m.served >= m.failAfter) {
        if (m.fail.hang) return // never answers: client timeout
        return reply(res, m.fail.status, { error: { message: m.fail.message || 'failure', code: m.fail.code || null } })
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      m.served++
      reply(res, 200, { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: drawCritter(prompt, i).toString('base64') })) })
    })
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    m.url = 'http://127.0.0.1:' + server.address().port + '/v1'
    m.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
    ok(m)
  }))
}
