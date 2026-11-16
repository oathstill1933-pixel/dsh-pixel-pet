# vendor —— 第三方库原样拷贝（插件零依赖，node_modules 一律不放）

本目录 `package.json` 声明 `"type": "commonjs"`，使下列 `.js` 文件可用 `createRequire` 直接 require（插件根是 ESM）。

| 库 | 版本 | 许可 | 来源 | 用途 | 联网 |
|---|---|---|---|---|---|
| `lunar-javascript/lunar.js` | 1.7.8 | MIT | npm `lunar-javascript`（github.com/6tail/lunar-javascript） | 农历、二十四节气、传统节日、黄历宜忌冲煞；农历生日 → 当年公历 | 否 |
| `ical.js/ical.es5.cjs` | 2.2.1 | MPL-2.0 | npm `ical.js`（github.com/kewisch/ical.js，npm 元数据里的仓库地址） | ICS 订阅解析（RRULE / EXDATE / TZID / 全天） | 否（解析本地缓存） |
| `holiday-cn/{year}.json` | 抓取日快照 | MIT（数据，© 2019 NateScarlet，`holiday-cn/LICENSE`） | github.com/NateScarlet/holiday-cn（自动抓国务院公告） | 中国法定节假日 + 调休上班 | 更新时 |

- holiday-cn 快照：随插件带当年/次年（当前 2026、2027）；运行时缓存与更新写 `<dataDir>/calendar/cache/holiday-cn-{year}.json`。
- 文件未做任何修改（仅从 npm tarball / GitHub 取出原文件）。每个库的许可文本都在各自目录里（`LICENSE`）；全部第三方清单见仓库根的 `THIRD_PARTY_NOTICES.md`。
