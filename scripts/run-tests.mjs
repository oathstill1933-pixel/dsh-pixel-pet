// node scripts/run-tests.mjs [filter] — run every scripts/*.test.mjs (and tests/*.test.mjs) in a private temp root.
//
// The individual tests create scratch dirs with mkdtemp and do not remove them; run one by one they used to
// leave thousands of pp-* folders in %TEMP%. Here each child gets TEMP/TMP/TMPDIR pointing at one fresh
// directory (os.tmpdir() and Python's tempfile both honour these), which is deleted when the run ends.
// Only the child environment is changed; the caller's environment is never touched.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const filter = process.argv[2] || ''
const files = ['scripts', 'tests']
  .flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.test.mjs')).map((f) => join(d, f)))
  .filter((f) => f.includes(filter))
  .sort()

const base = tmpdir()
const scratch = mkdtempSync(join(base, 'pixelpet-test-'))
const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch }
let failed = 0
try {
  for (const f of files) {
    const r = spawnSync(process.execPath, [join(ROOT, f)], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true })
    const ok = r.status === 0
    if (!ok) failed++
    const tail = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
    console.log((ok ? 'ok   ' : 'FAIL ') + f + (tail ? '  ' + tail.slice(0, 100) : ''))
    if (!ok) {
    // 失败的用例名在 stdout 里（> FAIL / not ok），stderr 常常只是无关的告警；两边都要给，CI 上才看得出是哪条
    const outLines = String(r.stdout || '').split('\n')
    const hits = []
    outLines.forEach((line, i) => { if (/^\s*(>\s*)?FAIL\b|^not ok\b/.test(line)) hits.push(outLines.slice(i, i + 8).join('\n')) })
    if (hits.length) console.log(hits.slice(0, 6).join('\n---\n'))
    const err = String(r.stderr || '').trim()
    if (err) console.log('[stderr]\n' + err.split('\n').slice(-8).join('\n'))
    if (!hits.length && !err) console.log(outLines.slice(-8).join('\n'))
  }
  }
} finally {
  // safety: only ever delete the directory this run created, directly under the system temp dir
  if (resolve(scratch).startsWith(resolve(base) + sep) && /pixelpet-test-[A-Za-z0-9]{6}$/.test(scratch)) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`)
process.exit(failed ? 1 : 0)
