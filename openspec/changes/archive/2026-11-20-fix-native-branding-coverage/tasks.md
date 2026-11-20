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
- [x] 实际启动开发应用，核对深浅主题、24×20px DK 标识、favicon 同源、版本浮层与正常窗口品牌。
- [x] 使用独立本地 HTTPS fixture 显示真实插件登录窗口，核对 DK 图标并确认取消后销毁。
- [x] 运行生产构建，通过。
- [x] 运行 `npm run test:plugins-smoke` 与 `npm run test:extensions-smoke`，分别以 exit 0 完成。
- [x] 在 Windows 对本次产物执行原生窗口、应用身份及图标验证，记录平台和验证边界。
- [x] Windows CI 通过后记录验证 Artifact 与结果，确认现行 spec 与 delta 一致，并归档本次变更；正式 Release 仍遵循原有工作流。

## Linux 实际界面验证

在独立配置目录实际运行 `npm run dev`，深浅主题、DK 的 24×20px 显示尺寸、favicon 与标题栏 SVG 同源、版本浮层及顶部任务栏 DK 图标均通过。界面留证位于验证工作区的 `/workspace/devkit-taskbar-ui-20261120/`。

真实 `PluginAuthHost` 与 branding 模块通过独立 Electron fixture 显示登录窗口；HTTPS 页面由本地 protocol handler 提供，不使用真实 OA 账号。实际截图可见 DK 图标，取消后确认窗口已销毁，进程 exit 0。留证位于 `/workspace/devkit-taskbar-auth-ui-20261120/`，包含 `auth-desktop.png`、`auth-content.png`、`ready.json`、`result.json` 和 `run-v2.log`。

`/workspace/devkit-taskbar-smoke.json` 记录插件与扩展中心冒烟分别耗时 5.8 秒、13.4 秒，均为 exit 0，测试 fixture 已退出。以上路径是当次验证工作区记录，不是发行包内容或永久下载链接。

## Windows 原生窗口与分发产物验证

[PR #16](https://github.com/smallfishworld/DevKit/pull/16) 的 [Windows CI run 44711274930](https://github.com/smallfishworld/DevKit/actions/runs/44711274930) / [job 136203310355](https://github.com/smallfishworld/DevKit/actions/runs/44711274930/job/136203310355) 全部通过。被验证的分支 head 为 `eade72439af446c1d03bbb622a9630ce122f901a`，代码树为 `80c038087371d4f4c71f0e528b356045f0679994`。

| 检查对象 | 实际结果 |
| --- | --- |
| 目录版 EXE | RT_GROUP_ICON #1 的 9 个图标帧与 DK ICO 匹配 |
| portable 外层启动器 | RT_GROUP_ICON #103 的 9 个图标帧与 DK ICO 匹配 |
| ZIP 内的应用 | 内层 EXE 的 9 个图标帧匹配，包内运行时资源通过核验 |
| ASAR 运行时资源 | PNG 与 ICO 均和源资源逐字节匹配 |
| development / unpacked / portable 真实窗口 | HWND 的 AppID、图标资源、重启命令及显示名称全部通过 |
| HWND 实际图标像素 | 16×16 小图标、32×32 大图标均与预期匹配 |
| portable 路径与重命名 | 将启动器复制到含空格和中文的路径并重命名后仍通过；退出后外层启动器仍存在 |
| Windows 原生输入自检 | `koffiLoaded`、`uiohookLoaded`、`sendInputResolved` 全部为 true |

验证 Artifact 为 [DevKit-Windows-641adab2791da00327c8b15e35a822d1b6029d9d](https://github.com/smallfishworld/DevKit/actions/runs/44711274930/artifacts/14617534051)，ID `14617534051`，到期日 2026-11-27。名称中的 SHA 是该 PR 运行的测试合并提交 `github.sha`，不是上文的分支 head；二者由同一 workflow run 关联。

## 真实门槛发现的修复

- Windows 检出时的 CRLF 曾使派生 SVG 的逐字节生成检查失败；通过 `.gitattributes` 固定相关文件为 LF，保留原有一致性断言。
- 真实主进程启动暴露 `uiohook-napi`、`koffi` 作为可选原生依赖被 Vite 内联后发生 `__dirname` 错误；在 main 的 `externalizeDepsPlugin` 中显式保留其外置加载，并以真实原生输入自检确认修复，没有通过 mock 或跳过模块规避。
- 验证脚本补齐本轮测试所拥有进程的清理，避免残留测试进程影响后续阶段；产物、原生窗口、图标像素和应用身份断言继续保留。

## 验证与发布边界

Linux 证据覆盖实际开发界面和登录窗口；Windows 证据覆盖实际构建产物、真实 HWND、系统属性、图标像素及原生依赖加载。Windows 检查不等同于替用户核验其机器上的历史固定项或 Shell 缓存，macOS 运行效果未在本轮实测。

本次提供经过 CI 验证的 Artifact，没有发布新的正式 Release，也没有修改用户已有任务栏固定项。合并代码不会自动更新旧 Release 附件或旧快捷方式，不能把“新代码通过验证”写成“旧下载包已经改变”。
