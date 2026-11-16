# DevKit 设备插件系统（三阶段）
## Why
当前设备动作主要表达 OA 挑战应答：共享类型、配置校验、表单和串口执行路径知道具体业务。扩展无 OA 的应答或二进制协议会同时修改宿主多个模块。现有串口锁、取消、日志脱敏与宏引用需要保留并成为扩展基础。

用户已授权在 Simular Box 完成三个阶段开发并推送 GitHub；插件示例允许放入独立仓库。本变更在 feat/device-plugin-system 分支实施，通过 PR 审查，不直接合并或发布版本。

## What Changes
1. 阶段一：抽出会话能力与事务仲裁，现有 OA 流程通过内置设备插件接入；兼容 device-actions.json 和 device-action 宏。
2. 阶段二：插件贡献配置 schema、动作及自动监听；增加通用管理/配置界面和独立文本/HEX 应答插件，支持实例与串口绑定。
3. 阶段三：本地可信 JavaScript 插件安装、版本校验、独立扩展进程、启停、诊断与旧 OA 配置迁移。
4. 修复运行中配置保存造成监听 busy 残留、运行中关闭监听仍继续取码，以及 authCheck 点路径提示与校验不一致的问题。

## Boundaries
- 宿主持有 SerialPort；插件通过 SDK 访问被绑定会话。
- 插件安装不自动启用设备写入，自动应答由用户在会话内布防。
- 首版支持可信内部插件。utilityProcess 是故障隔离，不是 OS 权限沙箱。
- 通用表单支持明确的数据 schema 子集；复杂数组/对象提供 JSON 编辑与校验，不动态注入外部 Vue 组件。
- 本地目录或自包含插件包均可作为安装形式，以实际实现和说明为准。
- 既有文本终端、ANSI/VT、UTF-8/GBK、清屏、磁盘历史和文件传输行为保持兼容。
- 不包含插件市场、自动更新服务、任意第三方不可信代码执行和整个工作台动态插件化。

## Affected Capabilities
- serial-terminal：会话事件、事务、断开/休眠取消、自动应答生命周期。
- terminal-command-macros：插件动作引用与旧宏兼容。
- device-plugins（新增）：安装、配置、实例、绑定、动作、独立进程和诊断。

## Delivery
源码、需求、测试与用户文档通过 DevKit PR 交付。插件示例、开发模板和 SDK 使用说明可独立发布到 smallfishworld/DevKit-Plugins；若账户登录阻止建库，完整示例先保留于主库 examples，避免阻塞开发。
