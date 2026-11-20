## Why

DevKit 的 Windows 单文件版与 ZIP 解压版当前依赖用户自行查找新版本、下载并替换程序。把 GitHub Release 的更新内容、下载与重启入口放进工作台，用户可以在完成手头的调试后再升级。

## What Changes

- 正式 Windows x64 构建启动后在后台检查 GitHub Releases，也可从标题栏版本浮层手工检查。
- 跟踪匹配当前分发格式的完整更新包。发现更新后显示版本和发布说明，由用户发起下载。
- 验证下载的大小和 SHA-256，保留待更新包，提供「重启并更新」与「稍后」。原路径无法更新时，可保存已验证的更新包。
- 在 Windows CI 中验证两种发布包的进程退出、替换、重启与恢复路径。

## Capabilities

### Modified Capabilities

- `workbench`：增加桌面应用更新。

## Impact

涉及应用主进程与 IPC、工作台版本入口、Windows 打包与验证，以及 README 发布包使用说明。
