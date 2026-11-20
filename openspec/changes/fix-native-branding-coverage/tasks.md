## 审计与实现

- [x] 审计生产 BrowserWindow、标题栏/favicon、版本入口、托盘、工具图标、资源与各平台打包配置。
- [x] 统一 Windows ICO 和其他平台 PNG 的运行时入口，以及主窗口的 Windows 应用身份和重启属性。
- [x] 为普通插件登录窗口接入同一品牌入口，确保重启命令只指向 DevKit 自身。
- [x] 保留辅助浮窗的 skipTaskbar 行为，避免把工具功能图标替换为品牌标识。
- [x] 扩充运行时资源、EXE、便携版与 ZIP 的产物验证，并将原生 HWND 门槛接入 Windows CI/Release。
- [x] 更新品牌覆盖表、用户排查指引及现行 workbench 规范。

## 验证与归档

- [x] 运行 Windows 应用身份纯函数与插件登录窗口接线回归；现有 plugin-backend 回归通过。
- [x] 运行 `npm run icons:check`、`npm run typecheck` 和完整 `npm test`，全部通过。
- [ ] 实际启动开发应用，核对标题栏、版本入口和正常窗口品牌。
- [ ] 使用独立本地 HTTPS fixture 显示真实插件登录窗口，核对图标并确认取消后销毁。
- [x] 运行生产构建，通过。
- [ ] 运行既有扩展中心冒烟。
- [ ] 在 Windows 对本次产物执行原生窗口、应用身份及图标验证；保留平台和验证边界。
- [ ] Windows CI 通过后记录验证 Artifact 与结果，同步完成状态并归档；Release 发布仍遵循原有工作流。

当前本地验证平台为 Linux。Windows 身份逻辑和认证窗口生命周期的模拟回归不等同于真实 Windows HWND 或任务栏视觉验证；原生检查及完整 Windows 分发产物仍待关联 PR 的 Windows CI 执行。第一轮提交保留活动 change，不提前归档或宣称 Windows 已通过。
