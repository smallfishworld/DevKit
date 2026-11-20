# device-plugins delta

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: 插件安装与兼容性
宿主 SHALL 支持安装可信本地设备插件，校验插件 ID、版本、API 版本和入口范围；OA 等业务插件 MUST NOT 内置发行。
#### Scenario: 安装兼容插件
- WHEN 用户选择有效的本地插件包或目录
- THEN 插件出现在列表中，安装本身不触发串口写入。
#### Scenario: 未安装 OA 业务插件
- WHEN 用户目录存在旧 `device-actions.json`，但未安装提供 `devkit.oa-debug` 的外部插件
- THEN 宿主不注册内置 OA 插件，也不读取、迁移或删除该旧配置。
#### Scenario: 安装后迁移旧配置
- WHEN 用户安装 ID 为 `devkit.oa-debug` 的外部插件且旧 `device-actions.json` 存在
- THEN 宿主把旧 profile 一次性迁移为插件实例，迁移失败不影响其他插件，旧文件不被删除。
