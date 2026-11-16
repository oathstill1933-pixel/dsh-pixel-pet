#!/usr/bin/env node
// Stand-in for the user's agently-cli in tests. Never touches the network.
// FAKE_AGENTLY_DIR/scenario.json drives replies; every call is appended to FAKE_AGENTLY_DIR/calls.jsonl.
//
// scenario.json keys (all optional):
//   authStatus            exit code of `auth status`            (3 = authorization lost)
//   me / meExit           `+me` payload / exit code
//   watch: [...]          one entry per `message +watch` call, { lines, stderr, exit, hang }
//   list / lists: [...]   `message +list` reply; `lists` is indexed by +list call number (paging / gaps)
//   read: { id: {...} }   `message +read` payloads
//   send: [...]           one exit code per `message +send` call
//   login: {...}          `auth login`: { lines, stderr, exit, hang } — the link is printed here
//   unknownExit           exit code of anything else
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_AGENTLY_DIR
const args = process.argv.slice(2)
const sc = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))
const callsFile = join(dir, 'calls.jsonl')
const prior = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const cnt = (a, b) => prior.filter((c) => c.args[0] === a && c.args[1] === b).length
const rec = { args, cwd: process.cwd() }
const out = (j) => process.stdout.write(JSON.stringify(j) + '\n')

const key = args.slice(0, 2).join(' ')
if (key === 'message +send') {
  const bf = opt('--body-file')
  rec.body = bf ? readFileSync(join(process.cwd(), bf), 'utf8') : null
  rec.relative = !!bf && !/^[A-Za-z]:|^\//.test(bf)
}
appendFileSync(callsFile, JSON.stringify(rec) + '\n')

if (key === 'auth status') process.exit(sc.authStatus ?? 0)
if (args[0] === '+me') { out({ data: sc.me || { aliases: [] } }); process.exit(sc.meExit ?? 0) }
if (key === 'message +send') {
  const code = (sc.send || [])[cnt('message', '+send')] ?? 0
  if (code) { process.stderr.write(sc.sendStderr || ('error ' + code)); process.exit(code) }
  out({ data: { queued: true, message_id: 'msg_sent_' + cnt('message', '+send') } }); process.exit(0)
}
if (key === 'auth login') {
  // the real CLI opens a browser / prints the link and then waits for the user to finish
  const run = sc.login || { hang: true }
  for (const l of run.lines || []) process.stdout.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n')
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.hang) setInterval(() => {}, 1 << 30)
  else setTimeout(() => process.exit(run.exit ?? 0), 30)
} else if (key === 'message +watch') {
  const run = (sc.watch || [])[cnt('message', '+watch')] || { hang: true }
  for (const l of run.lines || []) process.stdout.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n')
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.hang) setInterval(() => {}, 1 << 30)
  else setTimeout(() => process.exit(run.exit ?? 1), 30)
} else if (key === 'message +list') {
  const page = sc.lists && sc.lists[cnt('message', '+list')]
  out(page || sc.list || { data: { messages: [] } }); process.exit(0)
} else if (key === 'message +read') { out({ data: { message: (sc.read || {})[opt('--id')] || {} } }); process.exit(0) }
else if (key === 'attachment +download') {
  const d = join(process.cwd(), opt('--output')); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'pic.png'), 'png')
  out({ data: { saved_to: opt('--output') + '/pic.png' } }); process.exit(0)
} else if (!['auth status'].includes(key)) process.exit(sc.unknownExit ?? 0)
