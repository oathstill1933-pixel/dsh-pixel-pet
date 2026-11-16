/**
 * Turn one assistant reply into what the pet actually shows and speaks.
 *
 * oh-my-claude (the brain behind Clawd) is not a native DSH model route: it folds every tool call
 * into the reply body as a markdown line (`✳⁠ Glob …`) followed by a fenced block, and its personas
 * decorate sentences with `[表情:开心]` / bare `[开心]` markers meant for a chat UI. The QQ bridge
 * already strips both before sending a message out; the pet bubble needs the same treatment, or the
 * cat shows tool calls and mood tags verbatim and the TTS reads them aloud.
 *
 * Pure string work, no I/O — covered by scripts/reply-clean.test.mjs.
 */

const HEAD_GLYPHS = '❯⌕▤✎✳⤓☑⚙☰⌘◆'
const WORD_JOINER = '\u2060'
const FENCE = '```'
const CODE_PLACEHOLDER = '（这段我打给你看吧）'
const MOOD_WORDS = ['开心', '无语', '生气', '卖萌', '得意', '委屈', '震惊', '难过', '疑惑', '害羞']

const isToolLine = (line) => {
  const t = String(line).replace(/^\s+/, '')
  return t.length >= 2 && HEAD_GLYPHS.includes(t.charAt(0)) && t.charAt(1) === WORD_JOINER
}

/** dsh joins parts without a separator, so a tool anchor often sits right after prose. */
function splitAnchors (text) {
  const s = String(text == null ? '' : text)
  let out = ''
  let i = 0
  for (;;) {
    const at = s.indexOf(WORD_JOINER, i)
    if (at < 0) { out += s.slice(i); break }
    const glyph = at - 1
    if (glyph >= i && HEAD_GLYPHS.includes(s.charAt(glyph))) {
      const before = s.slice(i, glyph)
      out += before
      if (before && !/\n$/.test(before)) out += '\n'
      out += s.charAt(glyph) + WORD_JOINER
      i = at + 1
    } else {
      out += s.slice(i, at + 1)
      i = at + 1
    }
  }
  return out
}

/** Tool trace lines go away with the fenced block that follows them; prose code blocks become one line. */
export function stripToolTraces (text) {
  const src = splitAnchors(text)
  if (!src) return ''
  if (!src.includes(WORD_JOINER) && !src.includes(FENCE)) return src.replaceAll(WORD_JOINER, '')
  const out = []
  let awaitFence = false
  let insideFence = false
  const feed = (line) => {
    if (insideFence) {
      const at = line.indexOf(FENCE)
      if (at < 0) return
      insideFence = false
      const tail = line.slice(at + FENCE.length)
      if (tail.trim()) feed(tail)
      return
    }
    if (isToolLine(line)) {
      const at = line.indexOf(FENCE)
      if (at >= 0) {
        insideFence = true
        const tail = line.slice(at + FENCE.length)
        if (tail.trim()) feed(tail)
        return
      }
      awaitFence = true
      return
    }
    if (awaitFence) {
      awaitFence = false
      if (/^\s*```/.test(line)) {
        insideFence = true
        const tail = line.slice(line.indexOf(FENCE) + FENCE.length)
        if (tail.trim()) feed(tail)
        return
      }
    }
    const at = line.indexOf(FENCE)
    if (at >= 0) {
      const before = line.slice(0, at)
      if (before.trim()) out.push(before.replace(/\s+$/, ''))
      const after = line.slice(at + FENCE.length)
      const close = after.indexOf(FENCE)
      if (close >= 0) {
        out.push(CODE_PLACEHOLDER)
        const tail = after.slice(close + FENCE.length)
        if (tail.trim()) feed(tail)
        return
      }
      out.push(CODE_PLACEHOLDER)
      insideFence = true
      return
    }
    out.push(line)
  }
  for (const line of src.split('\n')) feed(line)
  return out.join('\n').replaceAll(WORD_JOINER, '')
}

/** `[表情:开心]` / `[表情：卖萌]` / bare `[开心]` are UI tags; a whole line of tags disappears. */
export function stripMoodTags (text) {
  const bare = new RegExp('\\[(' + MOOD_WORDS.join('|') + ')\\]', 'g')
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\[表情[:：][^\]\n]*\]/g, '').replace(bare, '').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/** `[QQ]…[/QQ]` wrappers only exist for the QQ bridge; keep the words, drop the markers. */
export function stripChannelTags (text) {
  return String(text || '').replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
}

/** One pass for the pet bubble, the spoken text and the mail body. */
export function cleanReplyText (text) {
  return stripChannelTags(stripMoodTags(stripToolTraces(String(text == null ? '' : text))))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
