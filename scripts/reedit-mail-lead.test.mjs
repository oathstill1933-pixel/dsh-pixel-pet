// Independent lead regressions. Synthetic fixtures only; never the user's inbox or audio.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { InboxStore } from '../lib/inbox.js'
import { MailService } from '../lib/mail.js'

const fixtureAddress = ['fixture', 'example.invalid'].join('@') // synthetic, never a real recipient
const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const mailService = (root) => new MailService({ dataDir: root, relay: { ask: async () => { throw new Error('unexpected relay') } }, settings: () => ({ mail: { agently: { enabled: false, consentAt: '' } } }) })
async function asyncFixture (fn) {
  const root = mkdtempSync(join(tmpdir(), 'pixelpet-reedit-mail-lead-'))
  try { return await fn(root) } finally {
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-reedit-mail-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
}

function fixture (fn) {
  const root = mkdtempSync(join(tmpdir(), 'pixelpet-reedit-mail-lead-'))
  try { return fn(root) } finally {
    const actual = realpathSync(root)
    assert.equal(dirname(actual), realpathSync(tmpdir()))
    assert.ok(basename(actual).startsWith('pixelpet-reedit-mail-lead-'))
    rmSync(actual, { recursive: true, force: true })
  }
}

test('failed primary inbox commit leaves no phantom message or consumed idempotency key', () => fixture((root) => {
  const store = new InboxStore(root)
  store.load()
  const normal = store.file
  const blocked = join(root, 'blocked-primary-target')
  mkdirSync(blocked)
  store.file = blocked // file-over-directory rename fails on the isolated fixture on all platforms
  assert.throws(() => store.addOut({ body: 'synthetic body', key: 'fixture-failed-key' }))
  store.file = normal
  assert.equal(store.byKey('fixture-failed-key'), null)
  assert.equal(store.list().length, 0)
  const retry = store.addOut({ body: 'synthetic retry', key: 'fixture-failed-key' })
  assert.equal(retry.created, true)
  assert.equal(store.list().length, 1)
}))

test('summary-write failure does not undo or falsely fail an already committed primary letter', () => fixture((root) => {
  const store = new InboxStore(root)
  const blocked = join(root, 'blocked-summary-target')
  mkdirSync(blocked)
  store.stateFile = blocked
  let out
  assert.doesNotThrow(() => { out = store.addOut({ body: 'synthetic body', key: 'fixture-committed-key' }) })
  assert.equal(out.created, true)
  const persisted = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(persisted.items.length, 1)
  assert.equal(persisted.items[0].id, out.item.id)
  assert.equal(store.byKey('fixture-committed-key').id, out.item.id)
}))

test('local attachment is copied, survives source removal, and its public metadata contains no local path', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png')
  writeFileSync(source, fixturePng)
  const service = mailService(root)
  const first = await service.sendOut({ body: 'synthetic image gift', key: 'fixture-local-gift', attachments: [source] })
  assert.equal(first.item.attachments?.length, 1)
  assert.equal(first.item.attachments[0].filename, 'fixture.png')
  assert.equal(JSON.stringify(first.item).includes(root), false)
  assert.deepEqual(readFileSync(source), fixturePng)
  const saved = join(root, 'mailbox', 'files', first.item.id)
  const entries = readdirSync(saved, { withFileTypes: true })
  assert.ok(entries.length > 0)
  assert.ok(entries.every((e) => e.isFile() && !e.isSymbolicLink()))
  assert.ok(entries.some((e) => readFileSync(join(saved, e.name)).equals(fixturePng)))
  const actual = realpathSync(source)
  assert.equal(dirname(actual), realpathSync(root)); assert.equal(basename(actual), 'fixture.png')
  unlinkSync(actual) // only the source that this test created
  const again = await service.sendOut({ body: 'synthetic retry', key: 'fixture-local-gift', attachments: [source] })
  assert.equal(again.item.id, first.item.id)
  assert.equal(service.store.list().length, 1)
  assert.ok(entries.some((e) => readFileSync(join(saved, e.name)).equals(fixturePng)))
}))

test('failed attachment publication does not consume its key and a repaired retry succeeds', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png'); writeFileSync(source, fixturePng)
  const service = mailService(root)
  const mailbox = join(root, 'mailbox'); mkdirSync(mailbox)
  const blocker = join(mailbox, 'files'); writeFileSync(blocker, 'owned-fixture-blocker')
  await assert.rejects(service.sendOut({ body: 'synthetic publish fail', key: 'fixture-publish-retry', attachments: [source] }))
  assert.equal(service.store.byKey('tool:fixture-publish-retry'), null)
  assert.equal(service.store.list().length, 0)
  assert.equal(readFileSync(blocker, 'utf8'), 'owned-fixture-blocker')
  const checked = realpathSync(blocker)
  assert.equal(dirname(checked), realpathSync(mailbox)); assert.equal(basename(checked), 'files')
  unlinkSync(checked)
  const repaired = await service.sendOut({ body: 'synthetic repaired', key: 'fixture-publish-retry', attachments: [source] })
  assert.equal(repaired.item.attachments.length, 1)
  assert.equal(service.store.list().length, 1)
}))

test('failed primary commit after file publication removes only its fresh files and permits retry', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png'); writeFileSync(source, fixturePng)
  const service = mailService(root)
  service.store.load() // prime the cache before injecting only the commit destination fault
  const original = service.store.file
  const blocked = join(root, 'blocked-primary'); mkdirSync(blocked)
  service.store.file = blocked
  await assert.rejects(service.sendOut({ body: 'synthetic primary fail', key: 'fixture-primary-retry', attachments: [source] }))
  assert.equal(service.store.byKey('tool:fixture-primary-retry'), null)
  assert.equal(service.store.list().length, 0)
  assert.deepEqual(readdirSync(join(root, 'mailbox', 'files')), [])
  service.store.file = original
  const repaired = await service.sendOut({ body: 'synthetic repaired', key: 'fixture-primary-retry', attachments: [source] })
  assert.equal(repaired.item.attachments.length, 1)
  assert.equal(service.store.list().length, 1)
}))

test('body and attachment metadata reach the authoritative inbox in one commit', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png'); writeFileSync(source, fixturePng)
  const service = mailService(root)
  const original = service.store.save.bind(service.store); let commits = 0
  service.store.save = () => { commits++; return original() }
  await service.sendOut({ body: 'synthetic atomic gift', attachments: [source] })
  assert.equal(commits, 1)
  const stored = JSON.parse(readFileSync(service.store.file, 'utf8'))
  assert.equal(stored.items[0].attachments.length, 1)
}))

test('retrying a deleted idempotent gift reports its tombstone without re-reading attachments', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png'); writeFileSync(source, fixturePng)
  const service = mailService(root)
  const first = await service.sendOut({ body: 'synthetic gift', key: 'fixture-tombstone', attachments: [source] })
  assert.equal(service.manage('delete', { ids: [first.item.id] }).ok, true)
  const retry = await service.sendOut({ body: 'synthetic retry', key: 'fixture-tombstone', attachments: [join(root, 'missing.png')] })
  assert.equal(retry.duplicate, true); assert.equal(retry.archived, true)
  assert.equal(service.store.list().length, 0)
}))

test('missing copied files prevent external delivery instead of silently sending text only', async () => asyncFixture(async (root) => {
  const source = join(root, 'fixture.png'); writeFileSync(source, fixturePng)
  const service = mailService(root)
  const first = await service.sendOut({ body: 'synthetic gift', attachments: [source] })
  const [copy] = service.attachmentPaths(first.item)
  const checked = realpathSync(copy.path)
  assert.equal(dirname(checked), realpathSync(join(root, 'mailbox', 'files', first.item.id)))
  unlinkSync(checked)
  let sent = 0
  service.settings = () => ({ mail: { agently: { enabled: true, consentAt: 'fixture-consent', to: fixtureAddress } } })
  service.agently = { send: async () => { sent++; return {} } }
  const status = await service.mirrorOut(first.item)
  assert.equal(status.ok, false); assert.equal(status.code, 'attachment'); assert.equal(sent, 0)
}))

test('each HTML attachment gets its own screenshot and all temporary results are cleaned', async () => asyncFixture(async (root) => {
  const htmls = [join(root, 'one.html'), join(root, 'two.html')]
  for (const html of htmls) writeFileSync(html, '<!doctype html><html><body>synthetic</body></html>')
  let renders = 0; let cleaned = 0; let sent = 0
  const service = new MailService({ dataDir: root, relay: { ask: async () => ({}) },
    settings: () => ({ mail: { agently: { enabled: true, consentAt: 'fixture-consent', to: fixtureAddress } } }),
    // Mock contract only; actual browser isolation is tested separately in mail-card-security-lead.
    snapshot: async () => { const path = join(root, 'mock-shot-' + (++renders) + '.png'); writeFileSync(path, fixturePng); return { path, cleanup: () => { cleaned++ } } },
  })
  service.agently = { send: async (to, subject, body, attachments) => { sent++; assert.equal(attachments.length, 4); return {} } }
  const result = await service.sendOut({ body: 'synthetic two cards', attachments: htmls })
  assert.equal(result.ext.ok, true); assert.equal(result.ext.screenshotCount, 2)
  assert.equal(renders, 2); assert.equal(cleaned, 2); assert.equal(sent, 1)
}))

test('malformed image content is rejected without committing a letter or idempotency key', async () => asyncFixture(async (root) => {
  const source = join(root, 'not-an-image.png')
  writeFileSync(source, '<html>synthetic wrong type</html>')
  const service = mailService(root)
  await assert.rejects(service.sendOut({ body: 'synthetic invalid', key: 'fixture-invalid', attachments: [source] }))
  assert.equal(service.store.list().length, 0)
  assert.equal(service.store.byKey('tool:fixture-invalid'), null)
}))

test('more than six distinct attachments is rejected without a partial letter', async () => asyncFixture(async (root) => {
  const sources = Array.from({ length: 7 }, (_, i) => {
    const file = join(root, 'fixture-' + i + '.png')
    writeFileSync(file, fixturePng)
    return file
  })
  const service = mailService(root)
  await assert.rejects(service.sendOut({ body: 'synthetic too many', attachments: sources }))
  assert.equal(service.store.list().length, 0)
}))

test('attachment larger than 10 MiB is rejected before a letter is committed', async () => asyncFixture(async (root) => {
  const source = join(root, 'oversized.png')
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1)
  fixturePng.copy(bytes)
  writeFileSync(source, bytes)
  const service = mailService(root)
  await assert.rejects(service.sendOut({ body: 'synthetic too large', attachments: [source] }))
  assert.equal(service.store.list().length, 0)
}))

test('archiving fallback keeps a starred letter reachable even when every other letter is unread', () => fixture((root) => {
  const store = new InboxStore(root, { maxItems: 1 })
  const kept = store.addOut({ body: 'synthetic favorite' }).item
  store.star(kept.id, true)
  store.addOut({ body: 'synthetic unread' })
  assert.ok(store.get(kept.id), 'favorite must remain visible, not disappear into an inaccessible archive')
  store.clear()
  assert.ok(store.get(kept.id), 'clear must preserve the favorite after over-cap handling')
}))
