// Sanitising a reply for the pet bubble / TTS: tool traces (oh-my-claude) and UI mood tags go away.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanReplyText, stripMoodTags, stripToolTraces } from '../lib/reply-clean.js'

const WJ = '\u2060'

test('oh-my-claude tool lines and their fenced block never reach the bubble', () => {
  const raw = '我看看你的日程。' + '\n' + '✳' + WJ + ' Glob `memory/*`' + '\n' + '```' + '\n' + 'memory/2026-11-11.md' + '\n' + '```' + '\n' + '今天有两件事。'
  assert.equal(cleanReplyText(raw), '我看看你的日程。\n今天有两件事。')
})

test('a tool anchor glued straight onto prose still splits and disappears', () => {
  const raw = '先查一下' + '⌕' + WJ + ' Search `x`' + '\n' + '```' + '\n' + 'hit' + '\n' + '```' + '\n' + '查到了。'
  assert.equal(cleanReplyText(raw), '先查一下\n查到了。')
})

test('a prose code block is replaced by one spoken line, not read out loud', () => {
  const raw = '这样写：\n```bash\nrm -rf /tmp/x\n```\n就完了'
  assert.equal(cleanReplyText(raw), '这样写：\n（这段我打给你看吧）\n就完了')
})

test('mood tags are dropped; a line of nothing but tags disappears', () => {
  assert.equal(stripMoodTags('晚安啦[表情:开心]'), '晚安啦')
  assert.equal(stripMoodTags('想你[害羞]\n[疑惑]'), '想你')
  assert.equal(cleanReplyText('[表情：卖萌]\n好呀'), '好呀')
})

test('[QQ] wrappers keep the words and lose the markers', () => {
  assert.equal(cleanReplyText('[QQ]在的[/QQ]'), '在的')
})

test('ordinary text is left alone', () => {
  const raw = '今天天气不错。\n要不要一起吃饭？'
  assert.equal(cleanReplyText(raw), raw)
  assert.equal(cleanReplyText(''), '')
  assert.equal(stripToolTraces(undefined), '')
})
