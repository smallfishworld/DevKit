# Device plugins

## Purpose

为串口设备扩展提供可信本地 JavaScript 插件、配置实例、受控串口会话和可诊断的独立运行时。OA 解锁等业务能力由外部插件提供，DevKit 只发行宿主能力，不内置具体业务插件。

## Requirements
### Requirement: 插件安装与兼容性
宿主 SHALL 支持安装可信本地设备插件，校验插件 ID、版本、API 版本和入口范围。
#### Scenario: 安装兼容插件
- WHEN 用户选择有效的本地插件包或目录
- THEN 插件出现在列表中，安装本身不触发串口写入。
#### Scenario: 安装无效或越界插件
- WHEN manifest 无效、API 不兼容或入口越出插件目录
- THEN 安装失败并说明原因，既有插件和用户配置不被覆盖。
#### Scenario: 未安装 OA 业务插件
- WHEN 用户目录存在旧 `device-actions.json`，但未安装提供 `devkit.oa-debug` 的外部插件
- THEN 宿主不注册内置 OA 插件，也不读取、迁移或删除该旧配置。
#### Scenario: 安装后迁移旧配置
- WHEN 用户安装 ID 为 `devkit.oa-debug` 的外部插件且旧 `device-actions.json` 存在
- THEN 宿主把旧 profile 一次性迁移为插件实例，迁移失败不影响其他插件，旧文件不被删除。

### Requirement: 插件源与远程更新
宿主 SHALL 支持绑定 DevKit-Plugins 风格的 HTTPS 插件目录，按版本列出安装与更新，并在安装前校验插件包完整性。
#### Scenario: 绑定 GitHub 插件仓库
- WHEN 用户输入 `owner/repo`、GitHub 仓库链接或 `catalog.json` 地址
- THEN 宿主读取目录并显示各插件版本及可更新状态，不自动安装。
#### Scenario: 从 Release 安装或更新
- WHEN 目录版本对应的安装包存在于同版本 Release 资产
- THEN 宿主下载 JSON 插件包并核对 SHA-256 后安装；失败时保留已安装版本和配置。
#### Scenario: 安装包未发布
- WHEN Release 资产与 `packagePath` 均不存在
- THEN 宿主明确提示插件包尚未发布，不改变已安装插件与配置。
#### Scenario: 源格式或校验失败
- WHEN 地址不是 HTTPS、目录格式无效、缺少校验值或 SHA-256 不匹配
- THEN 宿主拒绝读取或安装，不执行下载的插件代码。

### Requirement: 插件配置实例
宿主 SHALL 将插件包、配置实例和会话绑定分开管理，保存前执行服务端校验。
#### Scenario: 配置实例独立
- WHEN 同一个插件创建两个不同配置实例并绑定不同串口
- THEN 参数与运行状态互不影响。
#### Scenario: 配置失效
- WHEN 用户保存不符合 schema 的配置
- THEN 显示字段错误且保留原有效配置。

### Requirement: 可视化配置与动作发现
插件 SHALL 可贡献配置结构和动作元数据；宿主 SHALL 显示表单、动作和诊断。
#### Scenario: 无 OA 插件
- WHEN 安装普通应答插件
- THEN 无需填写 OA 或挑战码字段即可配置、绑定和运行。
#### Scenario: 快捷命令调用插件
- WHEN 宏包含已安装插件的有效动作引用
- THEN 宿主等待动作结果后再继续，失败或取消时按现有宏语义停止。
#### Scenario: 插件缺失
- WHEN 引用的插件不存在或不兼容
- THEN 宏保留引用并报告缺失，不静默跳过执行。

### Requirement: 隔离的扩展运行时
外部 JavaScript 插件 SHALL 在独立进程中运行，宿主保有串口并验证绑定会话。
#### Scenario: 插件进程退出
- WHEN 插件崩溃、超时或被禁用
- THEN 在途任务被取消，监听和事务被释放，其他串口继续可用。
#### Scenario: 连接已变化
- WHEN 旧动作在串口重连后返回
- THEN 旧动作不得写入新的连接。
#### Scenario: 插件停止
- WHEN 用户停用已运行插件
- THEN 停止新的触发并取消在途工作，不留下定时器、订阅或端口租约。

### Requirement: 数据与事务
插件 SHALL 可处理原始字节，宿主 SHALL 协调设备动作与其他发送来源。
#### Scenario: 分批协议输入
- WHEN 一个帧被拆为多次接收或一次接收包含多帧
- THEN 插件按协议缓存与消费数据，不假设一次 data 回调就是一帧。
#### Scenario: 发送者冲突
- WHEN 插件持有设备事务而其他来源申请发送
- THEN 宿主按确定策略排队或拒绝，协议交互不被插入破坏。

### Requirement: 插件串口能力与认证会话
宿主 SHALL 按 manifest 能力向插件提供独立接收订阅、跨回调独占租约、输入扣留/回放和隔离认证会话，未声明的能力调用 MUST 被拒绝。
#### Scenario: 订阅与动作并行
- WHEN 插件在手动动作或自动回调执行期间订阅串口数据
- THEN 订阅独立收到该连接的数据，不依赖 exchange 或自动应答队列，取消订阅后不再回调。
#### Scenario: 跨回调独占
- WHEN 声明 `serial.exclusive` 的插件在回调中取得租约并跨多个回调保持
- THEN 其他发送来源在释放前排队或拒绝；释放、停止或断开后宿主释放租约，旧租约不能写入新连接。
#### Scenario: 扣键补发
- WHEN 插件在自动流程中扣住用户输入并最终报告成功
- THEN 宿主按原顺序经同一租约补发；失败、超时、取消或断开时丢弃，不发送到设备。
#### Scenario: 认证会话
- WHEN 声明 `auth.session` 的插件请求登录和同源 HTTPS 业务接口
- THEN 宿主在独立持久分区中完成登录并携带 Cookie 请求，插件只得到状态码与响应文本；登录检查、业务接口与登录入口不同源或请求头越界时拒绝。
#### Scenario: 能力未声明
- WHEN 插件调用 manifest 未声明的串口订阅、独占、扣键或认证能力
- THEN 宿主拒绝调用并说明缺少的能力，不改变串口状态。

### Requirement: 配置升级与诊断
宿主 SHALL 保留配置版本与可理解的状态诊断。
#### Scenario: 忙碌时修改普通配置
- WHEN 配置实例仍有在途动作且用户修改普通参数
- THEN 明确要求等待或停止任务，原任务保持启动时快照，未通过的修改不覆盖有效配置。
#### Scenario: 关闭自动监听或禁用
- WHEN 用户关闭已绑定实例的自动监听或禁用实例
- THEN 在途任务被取消，空闲状态可再次明确绑定，旧 busy 不传递给新运行实例。
#### Scenario: 日志
- WHEN 插件报告状态或错误
- THEN 用户可见插件与实例身份，敏感口令不出现在普通诊断中。
