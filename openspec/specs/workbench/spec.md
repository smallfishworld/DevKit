# Workbench

## Purpose

DevKit 的 Windows 本地多工具工作台，统一管理工具面板、状态和持久化配置。 它覆盖离线启动、会话隔离、用户设置恢复和本地数据保护，是其他工具共享的基础交互契约。

## Requirements

### Requirement: Windows 离线工作台

应用 MUST 在受支持的 Windows x64 环境本地运行，核心工具 MUST 无需云端账户或外网服务。

#### Scenario: 离线启动

- **WHEN** 设备没有互联网连接，用户启动 DevKit
- **THEN** 工作台及本地工具仍可打开和使用。

### Requirement: 多面板会话

工作台 MUST 支持以标签承载独立工具面板，并按工具声明允许多开或复用单例。

#### Scenario: 并行调试

- **WHEN** 用户分别打开两个串口工具面板并切换标签
- **THEN** 两个面板的连接配置和状态彼此隔离，切换不会主动销毁会话。

### Requirement: 配置持久化

工作台 MUST 将用户设置和会话信息存于本机，并在重新启动后恢复适用设置。

#### Scenario: 重新启动

- **WHEN** 用户修改终端字体或会话选项并重新启动
- **THEN** 原有设置从本地配置加载。

### Requirement: 安全边界

工具的网络访问和系统权限 MUST 仅由对应功能请求，应用 MUST 不自动上传宏、设备日志或用户配置。

#### Scenario: 记录敏感操作

- **WHEN** 用户录制本地输入宏或串口日志
- **THEN** 本地数据不会被自动发送至外部服务。

### Requirement: 可携带分发

发布构建 MUST 提供适合 Windows 的便携运行方式，并明确未签名可触发 SmartScreen 提示。

#### Scenario: 首次运行

- **WHEN** 用户启动便携版
- **THEN** 工具可不依赖系统安装流程运行，安全提示的处理说明可找到。
