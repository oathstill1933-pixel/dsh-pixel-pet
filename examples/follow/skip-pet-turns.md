# 桌宠的轮次不外发（伪代码）

桥在「决定这一轮的 AI 回复要不要发回平台」的地方加一道闸。**这是整件事里最重要的一步**：
没有它，桌宠在房间里说的话可能被当成平台上的回复发出去。

桌宠发进会话的每条消息都带「这是本地轮」的标记，两种读法任选（能读到前者就用前者）：

| 标记 | 在哪 |
|---|---|
| `source.kind === "pixel-pet"` | `session/event` 的 `user/message` 事件的 `data.source` |
| id 以 `pixel-pet-` 开头 | 同一个事件的 `data.id`（`source` 读不到时的兜底） |

```js
// 桥收到 session/event 之后，先认这是不是桌宠的轮次
function isLocalPetTurn (event) {
  if (!event || event.type !== 'user/message') return false
  const data = event.data || {}
  if (data.source && data.source.kind === 'pixel-pet') return true
  return typeof data.id === 'string' && data.id.startsWith('pixel-pet-')
}

// 决定要不要把这一轮的 AI 回复发回平台时
function shouldRelayBack (turnStarterEvent) {
  if (isLocalPetTurn(turnStarterEvent)) {
    log.info('本地轮，不外发')   // 记一行就够了，别把内容打进日志
    return false               // 即使它落在「唤醒尾巴」的时间窗里，也一样不外发
  }
  return true
}
```

两条容易踩的坑：

1. **唤醒尾巴**：平台起的头之后 N 秒内的后续轮次也会被算成「该发」。桌宠恰好在这个窗口里插一句，
   就可能被发到群里 —— 所以判断要看「触发这一轮的那条用户消息」，而不是「最近有没有平台消息」。
2. **别只按时间判断**：桌宠的轮次和平台自己的轮次可能紧挨着发生，时间窗分不开它们，标记才分得开。

反向那一半（平台转进来的轮次不要在房间里念出来）桌宠自己就管着：它只念自己发起的轮次的回复，
平台转进来的轮次本来就不经过桌宠的嘴，桥这边不用做任何事。
