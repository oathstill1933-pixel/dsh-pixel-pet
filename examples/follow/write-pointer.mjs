#!/usr/bin/env node
/**
 * 最小门牌写入器（Node，零依赖）。抄进你自己的桥里就行。
 *
 *   node write-pointer.mjs <sessionId> [label]
 *
 * 每次给某个来源新建或切换 DSH 会话之后调一次。字段含义见 docs/FOLLOW.md。
 * 下面三个值全部是假的，换成你自己平台的东西。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHANNEL = 'myapp'          // ^[a-z0-9_-]{1,32}$
const PEER = '10000'             // 号码 / 频道 id / 房间 id
const PET_HOME = true            // 一对一私聊才填 true；群、频道、多人房间填 false

const followDir = process.env.PIXELPET_FOLLOW_DIR ||
  join(process.env.LOCALAPPDATA || '', 'dsh-pixel-pet', 'follow')

export function writePointer (sessionId, label = '私聊') {
  const pointer = {
    schema: 'dsh-pixel-pet/follow@1',
    channel: CHANNEL,
    peer: PEER,
    scope: 'direct',
    petHome: PET_HOME,
    sessionId,
    label,
    updatedAt: new Date().toISOString(),
    ttlHours: 36,
  }
  const file = join(followDir, CHANNEL + '-' + PEER + '.json')
  const tmp = file + '.' + process.pid + '.tmp'
  mkdirSync(followDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf8')
  renameSync(tmp, file)          // 原子替换：桌宠永远读不到半截文件
  return file
}

if (import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/')) {
  const sessionId = process.argv[2]
  if (!sessionId) {
    console.error('用法：node write-pointer.mjs <sessionId> [label]')
    process.exit(2)
  }
  try {
    console.log('写了门牌：' + writePointer(sessionId, process.argv[3]))
  } catch (e) {
    // 写失败绝不能影响聊天本身
    console.error('门牌没写成（不影响聊天）：' + (e && e.message))
  }
}
