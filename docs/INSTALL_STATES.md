# 安装状态机（INSTALL_STATES）

拓展包从下载到启用/回滚的全部状态与迁移。状态、事件、迁移表冻结在 [contracts/pack-contract-v1.json](../contracts/pack-contract-v1.json)；本文件是解释。非法 `(状态, 事件)` 组合 → `E_STATE_INVALID`。

权威实现：`lib/packkit.js` / `runtime/pixelpet/packkit.py` 的 `transition`；状态机的**执行者**是 M1 的 `runtime/pack_cli.py`：registry v2 的 `entry.state` 就是这里的状态，每次迁移都过 `transition()`。

M1 的实际路径：新装 `not-downloaded → downloading → waiting-dependency → waiting-authorization`，无待确认权限则继续 `→ waiting-adaptation → installed-disabled`（M1 无依赖/适配判定，这两步即时通过）；已装包更新从 `update-install` 进入。`load-failed` / 等待中 / 不兼容的包重装时从 `not-downloaded` 重走整条管线。`grant` = `authorization-granted → adaptation-resolved → enable-request`；回执 = `load-receipt-ok/fail`；回退 = `rollback-ok`；停用 = `disable-request`。运行时只加载 `wantEnabled` 且已授权的 installed-disabled / enabled 包（见 PACK_SPEC §7.4）。

## 1. 状态

| 状态 | 含义 |
|---|---|
| `not-downloaded` | 未下载（卸载后回到这里） |
| `downloading` | 下载中（本地导入与网页下载同一管线，同一状态） |
| `waiting-dependency` | 下载完，等依赖/组件判定 |
| `waiting-authorization` | 等用户授权（涉及 PERMISSIONS.md 的确认项） |
| `waiting-adaptation` | 待角色适配（必需动画/几何不满足；包已保存，互动不可启用） |
| `installed-disabled` | 已安装未启用 |
| `enabled` | 已启用 |
| `incompatible` | 不兼容（缺引擎 / core 不满足），显示原因，不悄悄消失 |
| `load-failed` | 加载失败（运行时回执否定）；旧版回滚后恢复 |

`has-update`（有更新）是**叠加标记，不是状态**：已安装状态上显示"有更新"，更新走 `update-install` 重新进入 `downloading`，不自动替换。

## 2. 主干流程

```
not-downloaded ──download-start──▶ downloading
downloading ──download-done──▶ waiting-dependency
downloading ──download-failed / cancel──▶ not-downloaded        （只清理本次暂存，不动旧版本）
waiting-dependency ──dependency-resolved──▶ waiting-authorization
waiting-dependency ──engine-missing / core-incompatible──▶ incompatible
waiting-authorization ──authorization-granted──▶ waiting-adaptation
waiting-authorization ──authorization-denied──▶ installed-disabled
waiting-adaptation ──adaptation-resolved──▶ installed-disabled
installed-disabled ──load-receipt-ok──▶ enabled
installed-disabled ──load-receipt-fail──▶ load-failed
enabled ──disable-request──▶ installed-disabled
load-failed ──rollback-ok──▶ installed-disabled                 （旧激活指针恢复）
load-failed ──load-receipt-ok──▶ enabled                        （重试成功）
incompatible ──core-resolved──▶ waiting-dependency              （主插件升级后重评）
任意已安装状态 ──uninstall──▶ not-downloaded
```

## 3. 冻结的语义（对应方案 §七）

- **enable-request 是意图事件，不改变状态**：状态停在 `installed-disabled`，等 `load-receipt-ok` / `load-receipt-fail` 才迁移。安装与启用的成功**一律以运行时回执为准**，不以目录写完或 HTTP 200 为准。
- **失败只清理本次暂存**：下载/校验失败回 `not-downloaded`，磁盘不足、取消、断网都不动旧版本、不删用户自定义覆盖。
- **回滚保留上一份可用包**：`load-failed --rollback-ok--> installed-disabled`，退出新引擎、清理本次监听器、保留用户数据。
- **卸载默认移除包资源**；读书笔记/偏好另行询问，不连带删除角色或主插件。用户自制覆盖与发行包分层，更新检测到用户修改时不直接覆盖。
- 桌宠尚未运行时：登记为"待启动加载"，启动成功后确认；**不为安装偷偷启动桌宠**。老运行时不支持热加载时如实提示"需要重启桌宠"，绝不假装已加载。
