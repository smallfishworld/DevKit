# 插件源：绑定 GitHub 插件仓库并检查更新

## Why

DevKit-Plugins 仓库已经提供机器可读的 `catalog.json`，但宿主只能安装本地目录或 JSON 包，用户需要手工构建、下载并选择文件。插件版本更新也没有可比较的来源。

## What Changes

1. 插件管理器新增「插件源」页，可绑定 `owner/repo`、GitHub 仓库链接或 `catalog.json` HTTPS 地址，并持久化到用户数据目录。
2. 按 `schemaVersion: 1` 校验目录，显示插件 ID、名称、描述、目录版本和已安装版本；仅在目录版本较新时标记可更新。
3. 安装包优先取同版本 Release 资产（标签 `<slug>/v<version>`，资产 `<manifest.id>-<version>.devkit-plugin.json` 与 `SHA256SUMS`），否则回退到相对目录地址的 `packagePath`。
4. 下载必须匹配 SHA-256，失败立即取消；每次安装/更新仍由用户确认插件源可信。
5. 目录不可达、格式错误、包未发布或校验失败时给出明确提示，不覆盖已安装版本和配置。

## Boundaries

- 不实现插件市场、自动安装、私有仓库 Token 或后台常驻轮询；更新检查只在打开管理器或手动刷新时进行。
- 外部插件仍是可信代码；utilityProcess 不是 OS 安全沙箱。
- Release 资产需要插件仓库自行发布；当前 DevKit-Plugins 未发布安装包时，列表可用但安装会提示 HTTP 404。

## Affected Capabilities

- device-plugins：新增插件源、远程安装/更新与完整性校验。
