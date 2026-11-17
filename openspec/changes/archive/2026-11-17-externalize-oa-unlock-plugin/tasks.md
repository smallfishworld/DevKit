# 任务

- [x] 删除 DevKit 内置 OA 插件、设备动作匹配/配置/提供者、共享类型和旧测试。
- [x] 从内置列表移除 `devkit.oa-debug`，保留安装外部同 ID 插件后的旧配置迁移。
- [x] 宿主实现 `serial.subscribe`、`serial.acquire` / lease write / release、`serial.hold` / `releaseHold`、`auth.session`。
- [x] 在 DevKit-Plugins 新增 `plugins/oa-unlock`：manifest、独立 CommonJS 入口、README、CHANGELOG 与协议测试。
- [x] 插件仓库 manifest 校验支持 `serial.exclusive` / `auth.session` 及组合约束，重新生成 catalog。
- [x] 扩展 `tests/plugin-backend-entry.js`：独立订阅、跨回调租约、扣键补发/丢弃、认证参数同源与请求头校验、能力兼容性。
- [x] 更新 README、`docs/device-actions.md`、`docs/device-plugins.md`、AGENTS 测试清单。
- [x] 同步 `openspec/specs/device-plugins` 与 `openspec/specs/serial-terminal` 并归档本变更。
- [x] `npm run typecheck` 与 `npm test` 全绿。
- [x] DevKit-Plugins `npm run validate`、`node scripts/test.cjs`、`npm run check`、`node scripts/check-host.cjs <DevKit>` 通过。
- [x] 本次不自动发布 Release；如后续对外分发，由用户确认后再为 `oa-unlock/v1.0.0` 发布。
