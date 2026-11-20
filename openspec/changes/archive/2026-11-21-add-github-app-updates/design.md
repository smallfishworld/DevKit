## Context

GitHub Actions 在 Release 发布后才上传 Windows 便携 EXE 与 ZIP。electron-builder 的 NSIS 安装版可使用 electron-updater，现有单文件 portable 与 Windows ZIP 需要各自的替换策略。VS Code Windows ZIP 由用户手工更新，yt-dlp 的 Windows 单文件更新在替换前验证摘要并保留旧文件。

## Decisions

1. 主进程请求指定仓库的 GitHub Releases API。使用带有完整对应附件和 SHA-256 的稳定版，只接受高于当前版本的版本。启动后延时检查，每六小时复查，合并并发请求并使用 ETag。已发布但上传未完成的版本先等待下次检查。
2. 通过现有 `tool:invoke` 和 `tool:event` 提供更新状态。主进程选择下载地址、缓存和替换路径。发布说明作为文本显示，状态入口留在标题栏。下载以流方式写入临时文件，通过长度和摘要校验后才记录待重启状态。更新信任边界是官方 GitHub 仓库的发布权限与 HTTPS。
3. 用户明确点击重启后，Windows 更新助手在目标卷完成预检和暂存，等待现有关闭流程释放资源。单文件版还等待外层启动器退出，在原路径替换并备份旧 EXE。ZIP 版仅替换与打包清单一致的专用目录，整个旧目录作为备份，保留原启动路径。通过新主窗口启动握手确认后清理备份。原路径受限或目录内含额外文件时允许另存包。
4. 下载和待重启状态以启动目标隔离。用户设置、插件、日志仍通过用户数据目录持久化。正在运行的工具可以等到用户选择重启再退出。

## References

- [electron-builder Windows 打包目标](https://www.electron.build/v26/docs/targets/)
- [electron-builder 便携启动器源码](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/portable.nsi)
- [VS Code Windows ZIP 分发说明](https://github.com/microsoft/vscode-docs/blob/main/docs/setup/windows.md)
- [yt-dlp 更新实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/update.py)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
