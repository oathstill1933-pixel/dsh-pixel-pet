// 测试用 Python 解释器的统一查找：环境变量 PIXELPET_TEST_PYTHON → PATH 上的 python / python3 / py。
// 找不到返回 null，调用方应当「跳过并说明原因」，而不是失败（CI 以外的机器可能没有 Python）。
import { spawnSync } from 'node:child_process'

let cached
export function findPython () {
  if (cached !== undefined) return cached
  const candidates = [process.env.PIXELPET_TEST_PYTHON, 'python', 'python3', 'py'].filter(Boolean)
  cached = null
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0 && String(r.stdout).trim() === '3') { cached = c; break }
  }
  return cached
}

/** 没有 Python 时：打印原因并以 0 退出（本文件所在的测试整份跳过） */
export function requirePythonOrSkip (what) {
  const py = findPython()
  if (!py) {
    console.log('skip: ' + what + ' 需要 Python 3（设 PIXELPET_TEST_PYTHON 或把 python 放进 PATH）')
    process.exit(0)
  }
  return py
}
