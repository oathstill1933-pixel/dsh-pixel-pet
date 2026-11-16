前提：你的桥和桌宠在同一台电脑上、连的是同一个 DeepSeek Harness；不是的话先告诉用户，不要硬接。

你要给一个「聊天桥」（把某个平台的消息转进 DeepSeek Harness 会话的程序）加上「桌宠跟随」对接。
桌宠是同一台机器上的 dsh-pixel-pet 插件；它不认识你的桥，也不认识你的平台，只认一个「门牌」文件。
做完以后，你的桥每次切换会话，桌宠会自己跟过去。

先读懂你要改的桥：它在哪里新建或切换 DSH 会话、在哪里把平台消息转进会话、在哪里把 AI 的回复发回平台。三处都找到再动手。

要做三件事：

1. 写门牌：每次给某个来源新建或切换会话之后，原子地写一个文件（先写 .tmp 再 rename）：
   路径：{{FOLLOW_DIR}}\<channel>-<peer>.json   一个来源一个文件
   内容：
   {
     "schema": "dsh-pixel-pet/follow@1",
     "channel": "{{CHANNEL_HINT}}",
     "peer": "<这个来源的标识：号码 / 频道 id / 房间 id>",
     "scope": "direct",
     "petHome": true,
     "sessionId": "<DSH 会话 id，带不带 session- 前缀都行>",
     "label": "<给人看的名字，比如：私聊>",
     "updatedAt": "<ISO 8601，带时区>",
     "ttlHours": 36
   }
   - 只写这些字段，别写 token、密码、cookie、聊天内容。
   - petHome 表示「这个来源适不适合当桌宠的家」。你比桌宠更懂你的平台：只有不会把别人的私事带出去的那种来源（一般是一对一私聊）填 true。
     群、频道、多人房间填 false —— 写了也不会被跟，但写上更清楚。
   - scope 照实写：一对一私聊写 "direct"；群写 "group"、频道写 "channel"、房间写 "room"。
     scope 是这类多人场合的词时，petHome 就算填了 true 桌宠也不会跟——这是防误标的保险，别为了「能跟上」去改 scope。
   - 从不切房的桥也照写一次（内容不再变，桌宠就一直跟着，没有副作用）。
   - 写失败不能影响聊天本身：try/catch 掉，记一行日志就行。

2. 不外发桌宠的轮次：桌宠发进会话的消息带 source.kind === "pixel-pet"（DSH user 消息上的 source 字段）。
   - 你的桥在决定「这一轮的 AI 回复要不要发回平台」时：如果触发这一轮的那条用户消息 source.kind 是 "pixel-pet"，一律不外发，哪怕它落在你的「唤醒尾巴」时间窗里。
   - 记一行日志「本地轮，不外发」。
   - 如果你的桥拿不到 source 字段，就看消息 id：以 "pixel-pet-" 开头的同样不外发。

3. 给转进来的消息打来源（可选但推荐）：你的桥转发平台消息进 DSH 时，在 followup 的 source 里写 { kind: "<你的桥名>", channel: "{{CHANNEL_HINT}}", peer: "<来源标识>" }。不要把号码写进对话文本。

做完自检（必须做，结果贴给用户）：
- 读 {{PET_API}}/api/follow（GET，本机）：sources 里应该能看到你的来源、sessionOk 为 true、petHome 为 true。
- 让用户在桌宠面板选中这个来源、切到「跟随」，再在平台上触发一次切换会话：20 秒内 {{PET_API}}/api/follow 的 effectiveSessionId 变成新会话。
- 让用户对桌宠说一句话：这一轮的回复不应出现在平台上；你的日志里有「本地轮，不外发」。
- 改动全部是增量：不写门牌 = 桌宠保持手动模式，桥的原有功能不受影响。
