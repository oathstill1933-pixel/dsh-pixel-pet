// Settings-page removal of characters / furniture (lib/host.js removePack + sanitizeHidden).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as H from '../lib/host.js'

export async function runRemoveTests (t) {
  await t('remove: user packs are deleted, built-ins hidden and restorable', () => {
    const data = mkdtempSync(join(tmpdir(), 'pp-remove-'))
    const userChar = join(data, 'characters', 'my-cat')
    mkdirSync(userChar, { recursive: true })
    writeFileSync(join(userChar, 'character.json'), JSON.stringify({ name: '我的猫' }))
    const builtIn = H.listCharacters(data).find((c) => !c.user && !c.draft)
    assert.ok(builtIn, 'a built-in character exists')

    let s = H.mergeSettings({}, { character: 'my-cat' })
    const del = H.removePack(data, s, 'character', 'my-cat')
    assert.equal(del.how, 'deleted')
    assert.equal(existsSync(userChar), false)
    assert.notEqual(del.patch.character, 'my-cat')

    s = H.mergeSettings(s, del.patch)
    const hid = H.removePack(data, s, 'character', builtIn.id)
    if (hid.ok) {
      assert.equal(hid.how, 'hidden')
      s = H.mergeSettings(s, hid.patch)
      assert.ok(s.hidden.character.includes(builtIn.id))
      assert.notEqual(s.character, builtIn.id)
    } else {
      assert.equal(hid.code, 409) // it was the last usable character
    }

    const f = H.listFurniture(data).find((x) => !x.user)
    const rf = H.removePack(data, s, 'furniture', f.id)
    assert.equal(rf.how, 'hidden')
    assert.deepEqual(rf.patch.furniture, { [f.id]: { enabled: false } })

    assert.equal(H.removePack(data, s, 'character', '../x').ok, false)
    assert.equal(H.removePack(data, s, 'sprite', 'x').ok, false)
    assert.deepEqual(H.sanitizeHidden({ character: ['ok', 'Bad!', 'ok', 3] }), { character: ['ok'], furniture: [] })
  })
}
