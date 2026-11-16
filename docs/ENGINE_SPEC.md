# 玩法引擎 / provider 契约（ENGINE_SPEC）

定义「玩法引擎」如何登记进桌宠主插件、声明能力、被拓展包依赖。M0 只冻结接口；reading / listening 等引擎本体是 M2/M3 的交付。

权威实现：`lib/packkit.js` 的 `createEngineRegistry`；能力 id 冻结在 [contracts/pack-contract-v1.json](../contracts/pack-contract-v1.json) 的 `capabilities`。未注册引擎 → `E_ENGINE_UNKNOWN`；没有满足版本范围的已注册版本 → `E_ENGINE_VERSION_UNSUPPORTED`；未知能力 → `E_CAPABILITY_UNKNOWN`。

## 1. 引擎是什么

- 玩法引擎是**随主插件发行的受审计代码**（不是拓展包带来的可执行代码），按需启动，禁用后释放监听器、计时器与资源。
- 引擎有 `id`（`^[a-z][a-z0-9-]{0,31}$`）、自己的 SemVer、以及它对核心提供的能力清单。
- 拓展包通过 `requires.engines: {引擎id: 版本范围}` 与 `requires.capabilities: [...]` 依赖引擎；**包不探测宿主私有 API**。

## 2. 注册与解析

```js
const engines = createEngineRegistry()
const off = engines.register({ id: 'reading', version: '1.0.0', capabilities: ['docs.select', 'session.ask'], activate })
const engine = engines.resolve('reading', '^1.0.0')   // 无注册 → E_ENGINE_UNKNOWN；范围不中 → E_ENGINE_VERSION_UNSUPPORTED
off()                                                  // 注销：主插件禁用/卸载时不留残余
```

- 同 id 同版本重复注册 → `E_FIELD_INVALID`；多版本并存允许，`resolve` 取满足范围的最高版。
- registry 只管登记与解析；**生命周期所有权归引擎**（见 §3）。

## 3. 生命周期（冻结规则）

1. **activate(ctx) → handle**：引擎拿到的是一个受限上下文（能力按 `capabilities` 声明过，权限经 [PERMISSIONS.md](PERMISSIONS.md) 的门），不是任意 DSH 服务。
2. **deactivate(handle) 必须释放全部资源**：所有工具、监听器、计时器、窗口、子进程都有拥有者和释放回执；主插件被禁用后不得残留玩法后台跑。
3. **provider 健康检查先行**：玩法引擎声明 provider 契约与版本，检查健康后再启动；缺组件时显示明确缺项，不静默安装依赖、不启动私用服务。
4. **运行时对宿主失联采用明确的租约策略**：停止宿主依赖动作，是否保留纯待机由用户配置决定。
5. 互动进行中更新/卸载：等到安全点，或提示先结束互动；先让角色退出家具，再卸载窗口、监听器及缓存。

## 4. 能力表（v1）

| 能力 id | 含义 |
|---|---|
| `docs.select` | 请求用户选定本地文档/文段 |
| `session.ask` | 经宿主中转向目标会话提问并取回复 |
| `playback.status` | 读取播放状态 |
| `playback.control` | 控制播放 |
| `pet.motion` | 驱动桌宠动作/表情/气泡 |
| `voice.speak` | 走桌宠语音出口合成并念出 |

能力 id 只在契约文件里增删；代码不私加。能力 ≠ 权限：能力是核心对引擎暴露的接口，权限是用户授予的敏感操作（见 PERMISSIONS.md），两者都要在包清单里分别声明。

## 5. 现有边界的对应关系

- 会话提问复用长任务回执 v1（`lib/relay.js` 的 start/result 协议，`protocol: 1`）：`session.ask` 的语义就是它，不再发明第二条通道。
- 播放状态/控制将对接 M3 的本地终端播放器 CLI（`playback.*`）；在播放器落地前，声明这两个能力的包只能进"待组件"状态。
- `pet.motion` 即现有控制接口（`runtime/pixelpet/control.py` 的 `/cmd`）；`voice.speak` 即 voice bridge 的既有出口。引擎不得绕过这两层直连 DSH。
