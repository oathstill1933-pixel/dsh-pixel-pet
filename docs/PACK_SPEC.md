# 拓展包规范（PACK_SPEC）

定义桌宠拓展包（`.petpack`）的容器、清单与校验规则。角色包 / 家具包本身的格式见 [FURNITURE_SPEC.md](FURNITURE_SPEC.md) 与 README，本规范只管「把包包装起来」的那一层。

权威实现：`lib/packkit.js`（`checkPackManifest` / `checkRequires` / `resolveOne` / `snapshot`）与 `runtime/pixelpet/packkit.py`（同名函数）；冻结常量单一来源 [contracts/pack-contract-v1.json](../contracts/pack-contract-v1.json)。两份实现语义必须一致，由 `scripts/pack-conformance.test.mjs` + `tests/test_pack_conformance.py` 钉死。

## 1. 容器与目录

- 拓展包是一个 ZIP 容器，扩展名 `.petpack`；**包内不含安装脚本，不执行 npm / pip，不允许任意 JS / Python / DLL / EXE 随包运行**。
- 内部布局（v1）：

```
manifest.json            包身份、版本、依赖、权限（下文 §2）
characters/<id>/         完整角色目录（character.json + sprites/）
furniture/               已有家具格式的资源（furniture.json + sprites/，见 FURNITURE_SPEC）
character-adapters/      适配某角色的动画片段与语义动作映射
assets/                  本地图标、插图
README.md  LICENSE  CREDITS
```

- **本地导入 `.petpack` 与网页下载走同一条安装管线；断网也能装已拿到的包**（安装管线本体是 M1 交付，M0 只冻结格式）。

## 2. manifest.json（v1）

| 字段 | 必填 | 允许的值 |
|---|---|---|
| `id` | ✓ | `作者命名空间.包名`，正则 `^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,39}$`，**恰好一个点** |
| `version` | ✓ | 包自己的 SemVer（`pack` 域，与主插件版号、DSH 版号互不混用） |
| `manifestVersion` | ✓ | 整数，当前 `1`；不等于 1 → `E_MANIFEST_VERSION_UNSUPPORTED`，**绝不按旧/新格式猜** |
| `packApi` | ✓ | 整数，当前 `1`；不等于 1 → `E_PACK_API_UNSUPPORTED` |
| `name` | ✓ | 非空展示名 |
| `license` | ✓ | 非空字符串 |
| `requires` | — | `{core?, engines?, capabilities?}`；**未知键或 `requires.dsh` 一律 `E_FIELD_INVALID`** |
| `platforms` | — | 非空字符串数组 |
| `permissions` | — | 权限 id 数组，见 [PERMISSIONS.md](PERMISSIONS.md)；未知 id → `E_PERMISSION_UNKNOWN` |
| `entryFurniture` | — | `{id, dir?}`；id 走现有家具包 id 规则 |
| `resources` | — | `{名称: 相对路径}`，不允许 `..` / 绝对路径 |
| `characters` | — | `[{id, dir?}]`，id 唯一，目录默认 `characters/<id>`，可在 `characters/` 下增加分层，末段仍为 id。条目只接受 id / dir。 |
| `characterAdapters` | — | `[{character, required?, optional?}]`，动作 id 走状态 id 正则 |
| `dependencies` | — | `[{id, version}]`；拒绝自引用；循环依赖由安装期注册表拒绝（M1） |
| `credits` / `publisher` | — | 字符串 |

- **顶层未知键容忍并原样保留**（与 character.json 行为一致，避免降级保存时被清空）；`requires` 这类协议载体内部的未知键是协议错误。
- `characters` 是 v1 的新增可选字段，两项协议版号仍为 1。旧插件将其作为顶层未知键保留，忽略包内角色，继续处理它认识的资源。
- `requires.core` 引用**主插件版号**（`plugin` 域），由 `checkRequires` 判定；**拓展包不声明 DSH 版本区间**——宿主差异由主插件适配层解释，不进包清单。
- 版本范围语法是最小集（精确 / `^` / `~` / 比较器 / 空格 AND），之外一律 `E_RANGE_UNSUPPORTED`；预发布语义按标准 SemVer，`^0.2.0-rc.1` 不接纳 `0.3.0-rc.1`（见契约 `rangeGrammar`）。

## 3. id 与存储目录

- **命名空间 id 不直接当路径**：注册表把 `petdev.reading-demo` 映射到安全化的存储目录（点与非法字符转换规则在 M1 冻结实现时确定）；现有角色/家具包 id（无命名空间）无须改名，由注册表对照。

## 4. 有效性判定与分层（所有读取端统一）

统一语义（JS/Python 同规则，`enumeratePacks` / `resolveOne`）：

1. 枚举跳过：`.` 前缀、`_` 前缀、名字含 `.bak-`、符号链接目录。
2. 清单严格 JSON：语法错 = 无效，**不存在"能解析就行"**。
3. 结构校验对齐 `runtime/pixelpet/validate.py`；帧图查到 **PNG 头级**（尺寸 + 8bit RGBA）。
4. 分层：**用户层仅当有效时胜出**；用户层无效 → 授权且启用的有效包层优先，其次是内置层，并记录 `userErrors`（页面可见，不得"页面说已装好、实际却运行另一份"）；仅用户层且无效 → 兜底展示但 `valid:false`，运行时有效集排除；骨架包（draft）等价无效，不参与胜出。
5. **像素级终审归 Python 运行时**（PIL：含"整张全透明"检测）：一个结构有效但像素不合规的用户包，运行时可拒绝并回退内置层。两侧在合法包上结论一致（夹具基线保证）；这个角差的最终闭环是 M1 的"安装成功以运行时回执为准"。

## 5. 动画适配（v1 冻结的原则）

- 适配动画**必须是单独的增量适配层**（`character-adapters/`），不是完整用户版角色目录：现有同 ID 用户包是整包覆盖，会长期挡住内置角色的新动作和修复。
- 运行时组合：**基础角色 → 当前包的角色适配层 → 通用回退**；卸载拓展只移除适配层。
- 必需的几何/动作约束不满足时：包可保存，但不能启用该角色下的对应互动（"需要角色适配"），不播放错位画面。
- 现有 `inside` 互动会隐藏主角色窗口和输入条；共读/陪听类互动需要"互动场景仍保留输入/提问出口"的引擎状态（M2/M3 落地）。

## 6. 已知边界（如实声明）

- 语音预设读取已授权并启用的包层和内置层。同 ID 时，包层的有效预设优先。用户角色美术覆盖不贡献公开音色，用户克隆仍使用独立 ID。
- 完整角色可在 `characters/<id>/voice/` 提供 `preset.json`、参考音频和锚点。清单使用严格 UTF-8 JSON，`name` 非空且最多 40 字，`language` 为字符串，`text` 最多 600 字，`icl` 模式要求非空文本。`ref` 和 `anchor` 使用纯文件名，分别限 WAV/MP3（8 MiB）和 JSON（2 MiB），实际路径须留在角色的 voice 目录。预设无效时角色校验报 `E_FIELD_INVALID`。 ZIP 预扫描只在该目录层级放行 `.wav`、`.mp3`。
- character-adapters 在 M1 只做**校验+入库**（目录名必须是角色 id），动画叠加的运行时应用是 M2 的交付。
- 结构校验不冒充像素校验：packkit 的 PNG 头检查不是 Python 校验结果，界面不得写成"已通过严格校验"。

## 7. 安装事务（M1）

权威实现：`runtime/pack_cli.py`（注册表**唯一写者**）+ `lib/packmgr.js`（宿主编排）+ `runtime/pixelpet/app.py` 的 `packs` 控制命令（运行时回执）。

流程：下载（`voice/fetch.py fetch_file`：https-only、Range 续传、sha256）/ 随插件附带 / 本地导入 → 大小+SHA-256 校验 → 中央目录预扫描（防炸，见下表）→ 暂存目录解包 → 深度校验（manifest v1 + 角色与家具严格校验 + 资源/适配器形状 + 像素预算）→ 冲突检查（同版异哈希 / 角色或家具 id 撞名）→ 入版本库 → 原子替换注册表（generation++）→ 宿主向运行中桌宠发 `packs reload` 收回执 → 回执确认才记安装成功。

- **回执否定（重载失败 / 代次不一致 / loaded 缺家具或角色）→ 自动 rollback**：旧激活指针恢复、失败版本标记 `failed`，旧家具照常。
- **桌宠没运行**：跳过回执，登记"待启动加载"（`receipt.petRunning=false`）；宠物下次启动读注册表，宿主连接上桌宠后补收回执。**绝不偷偷启动桌宠**。
- **同版同哈希重装幂等**：generation 不变；**同版异哈希 → `E_ID_CONFLICT`**。
- **兜底自愈**：宠物进程对 registry.json 做 mtime 门控轮询（仿 settings），宿主没来得及发回执时也能追上。
- 卸载：移除注册表条目 + 版本目录，generation++；宿主顺手清掉这些家具的 settings.furniture 记忆。

### 7.1 存储布局

```
<data>/packs/
  registry.json          {v:2, generation, packs: {<packId>: {active:{...}, previous|null}}}
  progress.json          安装进度（原子写；宿主只读）
  .incoming/             上传暂存（用完即删）
  .downloads/            下载暂存（用完即删）
  store/<命名空间>/<包名>/<版本>/     版本目录只读；active 指针指到完整校验过的版本
    manifest.json  characters/…  furniture/…  character-adapters/…  assets/…
```

命名空间 id → 存储目录：`petdev.m1-demo@1.0.0 → store/petdev/m1-demo/1.0.0/`（点→路径段；清单 id 正则保证每段都是 `[a-z0-9-]`，不可能出现 `..`）。

`active` 指针包含 `{id, version, dir, sha256, permissions, furnitureIds, characterIds, characterDirs, addedAt}`。旧指针缺少角色字段时按空列表处理。`receipt.loaded` 记录 `{furniture, characters}` 两种资源 id。角色被用户层有效同名角色覆盖时，回执记录覆盖来源。

随插件发布的 `contracts/catalog.json` 条目提供 `url` 或 `bundled`（二选一，两者都有整份目录拒用），并声明 `size` 与 `sha256`。
- `url`：https（回环 http 仅限本机测试）。内置的 Claude娘 就是 GitHub Release 附件，形如 `https://github.com/oathstill1933-pixel/dsh-pixel-pet/releases/download/<tag>/<文件>`。下载器（`voice/fetch.py`）跟随 302 跳转（GitHub 会跳到 CDN 地址），**跳转目标也必须是 https（或回环 http）**，否则拒绝；下载完核对大小与 SHA-256，不符就删掉暂存并报 `E_SIZE_MISMATCH` / `E_HASH_MISMATCH`。启动迁移里的下载有 30 秒总超时（超时按失败处理，桌宠退回默认角色并提示，不卡启动）。
- `bundled`：以 `packs-bundled/` 开头，解析后的文件必须位于插件目录内，并通过目录声明的大小与 SHA-256 校验。本体不再附带任何包，这条路径留给本地构建和测试。

### 7.2 解包硬上限（实现期冻结常量，`pack_cli.py`）

| 项 | 上限 |
|---|---|
| ZIP 成员数 | 512 |
| 单成员解压后 | 32 MB |
| 全部成员解压后总量 | 256 MB |
| 包内图片宽×高总预算 | 64,000,000 像素 |
| petpack 容器本身 | 64 MB |

另拒绝：路径穿越 / 绝对路径 / 盘符、符号链接与特殊文件成员、坏图（PIL open+verify）；每个路径段过契约 `DIR_SEG_RE`（含 `:` 即 NTFS ADS 一律拒），以 `.` 或空格结尾的段、Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名如 `con.txt`）拒；重名碰撞按 NFC → rstrip(". ") → lower 归一后比较。

### 7.3 目录（catalog）

随主插件发布的 `contracts/catalog.json`：`{v:1, entries:[{id, version, name, summary, url, size, sha256, permissions?}]}`。URL https-only（回环 http 仅限本机测试）；任一条目不合法 = 整目录拒用（`E_CATALOG_INVALID`）。第一期不后台自动更新目录；用户手动下载或导入。

### 7.4 与安装状态机（INSTALL_STATES.md）的对应 / 权限门

registry v2（`<data>/packs/registry.json`，`v:2`）每个包条目：

| 字段 | 含义 |
|---|---|
| `state` | 契约 `installStates` 之一；pack_cli 每次迁移都过 `transition()`，非法组合 `E_STATE_INVALID` |
| `wantEnabled` | 用户的启用意图（「安装并启用」/「确认权限并启用」/ 勾选启用 置真，停用置假） |
| `grantedPermissions` | 已授权权限；`needsConfirm:false` 的随装随记，需确认的只有 `grant` 才写入 |
| `pendingPermissions` | active 声明但未授权的需确认权限 |
| `active` / `previous` / `failed` | 纯版本指针 `{version, dir, sha256, permissions, furnitureIds, addedAt}` |
| `receipt` | 最近一次运行时回执 `{generation, ok, petRunning, loaded, errors, overriddenBy}` |
| `previousExpiresAt` | 毫秒时间戳，只在有 `previous` 时存在：**新版本收到成功回执（`load-receipt-ok`）那一刻**起算 7 天（`PREVIOUS_KEEP_S`）；回执失败 / 桌宠没在跑不起算；已起算的不会被后来的回执往后拖；新的 `previous` 产生或回退后清掉 |

读 v1 注册表时就地迁移（active→`enabled`，含需确认权限→`waiting-authorization`，failed→`load-failed`；绝不替用户补确认），写回即 v2。

**权限门（已实现，M1 通过条件⑤）**：运行时与快照只加载 `load_pointer` / `loadPointer` 给出的指针——`wantEnabled` 为真、状态 ∈ {installed-disabled, enabled} 且 active 权限 ⊆ 已授权；更新新增需确认权限时状态停在 `waiting-authorization`，若 previous 权限已全授权则继续加载 previous（新增能力暂停等再授权）。未授权 / 未启用的包整包不进 `pack_furniture_roots` 与 Node 快照，家具 `defaultEnabled` 随之不生效。安装落地 `installed-disabled`（需确认权限时 `waiting-authorization`）；`--enable 1` 且无需确认才一次完成。设置页对待确认的包显示「确认权限并启用」按钮（`POST /api/packs/grant`），其余显示启用开关（grant / `POST /api/packs/disable`）。启用成功一律以运行时回执（`load-receipt-ok`）为准。

### 7.5 事务、并发与恢复

- 单飞行：宿主 `packmgr` 一把 busy Promise 锁覆盖 CLI + reload + 回执 + 回滚；`pack_cli` 每个子命令拿 `packs/.lock`（O_EXCL；持锁 pid 已死或锁超过 2 小时视为过期；等待 30 s 超时失败）。
- 回执判定：`data.ok` 且 `data.generation >= wantGen`，且该包每件家具被某层加载——包层加载算成功，被用户层同名覆盖记 `overriddenBy` 不判失败；否则 `receipt --ok-flag 0`（→ `load-failed`）+ `rollback`。
- 同版本不同哈希：与 active / previous / failed 任一比对都拒（`E_ID_CONFLICT`）；被任何指针引用的目录绝不删除或覆盖。
- 原子入库：暂存 → `<ver>.new-<rand>` → 既有同名残留改名 `<ver>.old-<rand>` → 换入 → 写 registry → 最后删旧；同时回收被挤出的旧 previous / failed。
- 崩溃恢复：每个子命令拿锁后清扫 `pack-stage-*`、`.downloads/*`、`.incoming/*`（2 分钟内新落盘的除外）、`registry.json.*.tmp`、未被注册表引用的 store 版本目录；注册表损坏时不碰 store。所有删除先断言绝对路径位于 `<data>/packs` 之下（不等于它）。
- 卸载返回 `leftovers`（删不掉的路径），不再静默忽略。
- 旧版本保留期：更新后 `previous` 不再永久留着。新版本加载成功并收到回执后，旧版本再保留 7 天（`entry.previousExpiresAt`），宿主每次启动调一次 `pack_cli prune-previous`，过期的清掉（先写注册表、最后才删目录，同安装事务；在役指针没变，不改 generation，桌宠不用重载）。保留期内回滚照常可用。回执没成功（`load-failed` / 有 `failed` 指针）一律不清——旧版本是唯一退路。设置页拓展包卡片的「清理旧版本」走 `prune-previous --pack-id <id> --force 1`，不等保留期，清完回滚不可用；同样拿 `packs/.lock`、先做崩溃恢复清扫、所有删除先断言落在 `<data>/packs` 之下。
- 导入路由 `/api/packs/import`：Origin/Host 一致 + `Sec-Fetch-Site` 非跨站 + 只收 `application/octet-stream`。

## 8. 自查

```
node scripts/packkit.test.mjs
node scripts/pack-conformance.test.mjs
node scripts/packmgr.test.mjs
<可用 Python> -m unittest discover -s tests -p "test_packkit.py"
<可用 Python> -m unittest discover -s tests -p "test_pack_conformance.py"
<可用 Python> -m unittest discover -s tests -p "test_pack_store.py"
<可用 Python> -m unittest discover -s tests -p "test_packs_reload.py"
<可用 Python> -m unittest discover -s tests -p "test_pack_m1_fix.py"
```

`<可用 Python>` 指本机约定里带 numpy/PIL 的解释器（见工作区 AGENTS.md；base miniconda 的 numpy 会崩 SV 测试）。

全绿才算过；夹具期望值在 `contracts/fixtures/packkit/`，改契约必须先改夹具期望并同步两侧实现。
