/**
 * 一起看书 · AI 工具（docs/READING_CONTRACT.md）。when: s => s.reading?.enabled === true —— 关着时 AI 看不到。
 * 只读：经宿主内部接口 reading.snapshot()，不碰文件路径、不读整本书。
 */
const when = (s) => s?.reading?.enabled === true

export function readingSentence (v) {
  if (!v || !v.open) return '现在没有在读的文档。'
  const d = v.doc || {}
  let s = (d.kind === 'pdf' ? 'PDF' : '网页') + '《' + (d.title || '未命名') + '》'
  if (d.kind === 'pdf' && d.page) s += '，第 ' + d.page + (d.total ? ' / ' + d.total : '') + ' 页'
  if (d.site) s += '（' + d.site + '）'
  if (v.selection) s += '\n当前划选：「' + v.selection.text + '」'
  if (v.kept && v.kept.length) s += '\n最近留存 ' + v.kept.length + ' 条。'
  return s
}

export function createReadingTools ({ reading, settings } = {}) {
  const on = () => { try { return when(settings()) } catch { return false } }
  const output = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: !v || typeof v !== 'object' ? String(v) : v.data === undefined ? String(v.message) : String(v.message) + '\n' + JSON.stringify(v.data, null, 2) }],
  }
  const tools = () => [{
    name: 'pixelpet_reading_now',
    when,
    description: '一起看书：读用户此刻在阅读窗里看的文档（标题、页码）、当前划选的那段及前后文、最近几条留存摘要。只读，不含本地路径，也读不到整本书。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    timeoutMs: 10_000,
    async execute () {
      if (!on()) return { ok: false, message: '「一起看书」没有打开。' }
      let v = null
      try { v = reading.snapshot() } catch {}
      return { ok: !!v, message: readingSentence(v), data: v || { open: false } }
    },
  }]
  return { tools }
}
