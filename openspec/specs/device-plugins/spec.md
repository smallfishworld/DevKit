# Device plugins

## Purpose

基于独立同构契约包 `@devkit/plugin-sdk`（API v2），为串口、SSH、网络调试及本地终端等流会话提供可信本地 JavaScript 插件、可视化条件/多规则配置实例、受控 `StreamSessionBridge` 会话租约、开发态热重载与可治理的 HTTPS 扩展源。

## Requirements

### Requirement: 独立契约包与插件安装兼容性
宿主与插件仓库 SHALL 共享独立的同构契约包 `packages/plugin-sdk`（`@devkit/plugin-sdk`），统一提供 API v2 类型、Manifest/Schema 校验器、语义版本比较与官方单测夹具 `createMockPluginContext`。宿主 SHALL 校验插件 ID、版本、`apiVersion: 2`、`minHostVersion`、`transports` 与入口范围。
#### Scenario: 安装兼容插件
- **WHEN** 用户选择有效的本地插件包或目录，且满足 `apiVersion: 2` 与 `minHostVersion`
- **THEN** 插件出现在列表中，安装本身不触发任何流会话写入。
#### Scenario: 安装无效、越界或不满足宿主最低版本的插件
- **WHEN** manifest 无效、`apiVersion` 不为 2、当前宿主版本低于 `minHostVersion` 或入口越出插件目录
- **THEN** 安装失败并说明原因，既有插件和用户配置不被覆盖。

### Requirement: 插件配置实例与条件/多规则表单
宿主 SHALL 将插件包、配置实例（`configVersion: 2`）和会话绑定分开管理，保存前执行服务端 Schema 校验。配置 Schema SHALL 支持 `x-visibleWhen` 条件显隐与对象数组（`type: "array"` + `items.type: "object"`）规则编辑；隐藏字段在保存校验时跳过 `required` 检查。
#### Scenario: 条件显隐与多规则编辑
- **WHEN** 插件 Schema 声明 `x-visibleWhen`（如 HEX 模式下隐藏文本换行/大小写项）或对象数组规则字段
- **THEN** 配置表单按当前字段值实时切换可见项，并提供规则的增删与子字段编辑。
#### Scenario: 配置实例独立
- **WHEN** 同一个插件创建两个不同配置实例并绑定不同会话面板
- **THEN** 参数与运行状态互不影响。

### Requirement: 通用流会话桥接与多协议动作发现
宿主 SHALL 通过 `StreamSessionBridge`（支持 `serial`、`ssh`、`net`、`pty`）向插件提供受控 `ctx.stream.write` / `ctx.stream.exchange` 与 `ctx.signal`，并按 `manifest.transports` 过滤可绑定会话。
#### Scenario: 多协议绑定
- **WHEN** 插件声明 `transports: ["serial", "ssh", "net"]`
- **THEN** 用户可在已连接的串口、SSH 或网络调试面板中绑定同一插件配置并执行手动动作或自动应答。
#### Scenario: 快捷命令调用插件
- **WHEN** 宏包含已安装插件的有效动作引用
- **THEN** 宿主等待动作结果后再继续，插件失败抛出异常或被取消时按宏语义中止后续步骤。

### Requirement: 隔离的扩展运行时、增量同步与一键恢复
外部 JavaScript 插件 SHALL 在独立 `utilityProcess` 中运行，宿主保有底层会话并验证 `connectionId` 租约。前端状态管理 SHALL 对高频 `status` 与 `log` 事件采用增量写入而非全量 `snapshot` 刷新，并在实例异常停止时提供一键重试绑定入口。
#### Scenario: 插件进程退出或异常
- **WHEN** 插件崩溃、超时或被禁用
- **THEN** `ctx.signal` 触发中止，在途任务与租约被释放，其他会话继续可用；插件浮层展示错误并提供一键重试绑定按钮。
#### Scenario: 连接已变化
- **WHEN** 旧动作在会话重连后返回
- **THEN** 旧动作不得写入新的连接。

### Requirement: 开发态本地目录热重载
宿主 SHALL 支持对本地插件开发目录开启 `watch:start` / `watch:stop` 文件监听。
#### Scenario: 修改本地插件源码
- **WHEN** 开发者修改被监听目录中的插件代码或清单
- **THEN** 宿主防抖重装并安全停止再重新绑定受影响的活跃实例。

### Requirement: HTTPS 扩展源 v2 版本治理
扩展中心 MUST 持久化已添加的 HTTPS 安装索引（`version: 2`），预置官方扩展源并支持手动刷新、停用、启用和移除。索引条目 MUST 校验 SHA-256、包标识、版本、`apiVersion: 2`，并支持 `minHostVersion`、`transports`、`deprecated` 与 `yanked` 治理字段。
#### Scenario: 拦截已撤回或不兼容版本
- **WHEN** 扩展源条目被标记为 `yanked: true` 或其 `minHostVersion` 高于当前宿主版本
- **THEN** 扩展源界面明确标示状态并禁用安装按钮，宿主安装接口同步拒绝安装；已废弃（`deprecated`）条目展示提醒标签。

### Requirement: 插件来源与当前绑定详情
扩展中心 MUST 在插件详情呈现已记录的安装来源、支持的传输类型与运行状态。各会话面板的插件浮层 MUST 支持直接编辑、停止与重试绑定实例。
