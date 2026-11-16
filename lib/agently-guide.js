/**
 * "Connect Agently Mail" — a prompt the user hands to their own AI. It only points at the official setup
 * document and the official install commands; it carries no copy of the official skill text, no account,
 * no address, and the AI never registers or scans on the user's behalf.
 */
export const OFFICIAL_SETUP_URL = 'https://agent.qq.com/doc/cli-setup.md'

export function buildAgentlyGuide ({ settingsUrl = '' } = {}) {
  const where = settingsUrl ? '（' + settingsUrl + '）' : ''
  return `# 帮我把桌宠信箱接到 Agently Mail

我在用 dsh-pixel-pet 桌宠插件。它的信箱默认只存在本机；我想给它接一个 Agently Mail 邮箱（腾讯 QQ 邮箱的 Agent 专属邮箱），这样桌宠写给我的信会同时发到我自己的邮箱，我也能用自己的邮箱给桌宠写信。请按下面的步骤带我做，每一步做完告诉我结果再继续。

## 0. 先把这几件事念给我听，等我说「继续」
- 这是腾讯的内测服务，要用**我本人的微信**扫码授权，可能触发实名核验；18 岁以下需要监护人同意。
- 信件内容会经过腾讯的服务器。涉密、敏感的内容不要走这个通道。
- 服务条款和收费可能变化；插件随时可以在设置页关掉它，退回纯本地信箱，本地的信不受影响。
- 你（AI）不会替我注册，也不会替我扫码，授权必须由我本人完成。

## 1. 环境检查
- \`node --version\` 要 ≥ 22（skills 工具用到了 node 22 才有的 API，node 20 会报 SyntaxError）。
- \`npm --version\` 能用。
- 需要中国大陆网络能直连；在海外的话先提醒我可能连不上。
- npm 慢可以加 \`--registry=https://mirrors.cloud.tencent.com/npm/\`。

## 2. 安装官方 CLI 和官方 skill（命令原样执行）
\`\`\`
npm install -g @tencent-qqmail/agently-cli
npx skills add https://agent.qq.com --skill agently-mail -a <你自己的 agent 名> -y
\`\`\`
- \`-a\` 填你自己（比如 claude-code / codex / cursor），只装给你自己；**不要**裸用 \`-g -y\`，那会装进这台机器上所有探测到的 agent 目录。不想动全局可以去掉 \`-g\`，或者加 \`--copy\`。
- 装完跑 \`agently-cli --version\` 确认。
- 用法以官方文档为准：${OFFICIAL_SETUP_URL} 。skill 的内容由上面的命令从官方拉取，不要用别处的副本代替。

## 3. 授权（我本人扫码）
- 在后台运行 \`agently-cli auth login\`，从输出里找到授权链接，**一字不改**地发给我。
- 提醒我：链接大约 15–20 分钟就过期，请尽快用微信扫；过期了不要重试旧链接，重新跑一次拿新链接。
- 失败或超时不要自动重试，告诉我结果，等我决定。

## 4. 验证
- 运行 \`agently-cli +me\`，能看到邮箱地址就算成功。把地址告诉我。

## 5. 填回插件设置页${where}
- 「信箱」一栏打开 Agently Mail 开关（会弹一次确认：允许桌宠 AI 通过这个邮箱自动发信）。
- 收信邮箱填我自己常用的邮箱（桌宠的信会发到这里）。
- 如果 \`agently-cli\` 不在 PATH 里，把它的完整路径填进 CLI 一栏。
- 填完插件会自己常驻监听新信；我用自己的邮箱发信到上面那个 Agently 地址，桌宠就能收到。

## 6. 收尾自查
- 让桌宠用 pixelpet_mail_send 给我写一封主题为「[桌宠接入测试]」的短信，确认我的邮箱收到了。
- 我从自己的邮箱回一封，确认桌宠信箱里出现了这封回信。

## 7. 以后想停用
- 在设置页关掉 Agently Mail 开关，监听进程会停掉；本地信箱里的信不动。
- 想连授权一起清掉，再运行 \`agently-cli auth logout\`。
`
}
