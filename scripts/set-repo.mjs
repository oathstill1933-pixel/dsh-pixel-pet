// node scripts/set-repo.mjs <owner>/<repo> [--check]
// 仓库地址在发布前只填一次：把所有 `<OWNER>/<REPO>` 占位替换成真实的 owner/repo。
//   --check  只列出还有占位的文件（退出码 = 文件数是否为 0），不改任何东西
// 占位符出现的位置固定在下面的清单里（scripts/purge 之外的测试会核对：别处出现占位符就报错）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLACEHOLDER = '<OWNER>/<REPO>'
/** 允许出现占位符的文件（相对插件根） */
export const PLACEHOLDER_FILES = [
  'package.json',
  'contracts/catalog.json',
  'README.md',
  'CHANGELOG.md',
  'docs/RELEASE.md',
  'docs/PACK_SPEC.md',
  'THIRD_PARTY_NOTICES.md',
  'characters/whale-girl/CREDITS.md',
  'scripts/set-repo.mjs',
]
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function withPlaceholder (root = ROOT) {
  return PLACEHOLDER_FILES.filter((f) => existsSync(join(root, f)) && readFileSync(join(root, f), 'utf8').includes(PLACEHOLDER))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const slug = args.find((a) => !a.startsWith('--'))
  if (check || !slug) {
    const left = withPlaceholder()
    console.log(left.length ? '还有占位符：\n  ' + left.join('\n  ') : '没有占位符了')
    process.exit(check && left.length ? 1 : (slug || check ? 0 : 2))
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(slug)) {
    console.error('格式要是 owner/repo，例如 someone/dsh-pixel-pet')
    process.exit(2)
  }
  for (const f of withPlaceholder()) {
    if (f === 'scripts/set-repo.mjs') continue          // 脚本自己不改
    const p = join(ROOT, f)
    writeFileSync(p, readFileSync(p, 'utf8').split(PLACEHOLDER).join(slug), 'utf8')
    console.log('已替换 ' + f)
  }
}
