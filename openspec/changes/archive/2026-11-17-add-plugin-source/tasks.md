# 实施任务与验收记录

- [x] S1 解析并校验 DevKit-Plugins `catalog.json`（schema/api 版本、ID/目录名、packagePath、可选 packageUrl/sha256）。
- [x] S2 统一插件源地址：owner/repo、GitHub 仓库/tree/blob 链接、raw 与 GitHub Pages 地址。
- [x] S3 解析下载候选：GitHub Release 资产优先，`packagePath` 回退；404 才回退，网络错误或校验失败立即终止。
- [x] S4 读取并解析 `SHA256SUMS`，安装前校验插件包；校验失败不覆盖已安装版本。
- [x] S5 持久化插件源地址；刷新不阻塞绑定/停止等操作；并发检查与安装互斥。
- [x] S6 插件管理器「插件源」页：绑定、解绑、检查更新、更新徽标、错误提示与安装确认。
- [x] S7 单元测试覆盖目录校验、地址解析、版本比较、SHA256SUMS、404 回退。
- [x] S8 Electron 插件 UI 冒烟覆盖本地 catalog.json 绑定、发现更新、确认、下载校验与更新完成。
- [x] S9 同步 `openspec/specs/device-plugins/spec.md`、README、`docs/device-plugins.md` 与 AGENTS 测试清单。
- [x] V1 `npm run typecheck`（node/web）。
- [x] V2 `npm test` 全绿。
- [x] V3 `npm run build` 与 `npm run test:plugins-smoke` 通过。
- [x] V4 用真实 `smallfishworld/DevKit-Plugins` 的 raw `catalog.json` 验证列表解析与下载候选；仓库尚未发布 Release，安装按预期提示包未发布。
