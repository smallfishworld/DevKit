## 实现与规范同步

- [x] 将用户确认的 B「模块核心」青绿标识保存为单一 SVG 母版，并派生应用 PNG、单色备用与多尺寸 ICO 资源。
- [x] 接入标题栏、原版本信息入口、运行时窗口图标和平台打包图标，保持 Windows 应用身份一致。
- [x] 补充可重复的资源生成检查及 Windows EXE、ASAR 实际产物检查入口，接入现有 CI，保留所有既有门槛。
- [x] 同步 `openspec/specs/workbench/spec.md` 的统一应用标识要求和三个验收场景。

## 验证与归档

- [x] 运行 `npm run typecheck`，确认 node 与 web 两套类型检查通过。
- [x] 运行 `npm test`，确认完整单测通过。
- [x] 运行 `npm run icons:check`；解析 ICO 验证九档 RGBA PNG 帧，且 256px 帧与运行时 PNG 完全一致；目视检查 16/20/24/32/48px 深浅底效果。
- [x] 在 Box 的 Linux 桌面实际运行 `npm run dev`，验证深色、浅色主题下 20px 标识和版本信息入口；favicon 与标题栏使用同一 SVG，未放宽 CSP。
- [x] 完成生产构建与既有扩展工作台冒烟验证。
- [x] 汇总本地验证结果后归档本变更。

Windows 的真实 EXE 图标资源与 ASAR 内运行时 PNG 由关联 PR 的 CI 检查，合并以 CI 通过为前提。Windows 任务栏的桌面视觉、macOS 打包未在 Linux Box 实测；不能将平台配置等同于实测结果。
