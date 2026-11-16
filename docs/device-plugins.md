# 设备插件（API v1）

## 安装与运行

串口面板提供插件管理入口。插件分为内置 OA 设备动作和用户安装的可信 JavaScript 插件。外部插件运行于独立 Electron utilityProcess，串口仍由 DevKit 主进程持有。

1. 导入包含 manifest.json 和入口文件的本地插件目录，或自包含 JSON 插件包；API v1 不支持直接导入 ZIP。
2. 选择插件并创建配置实例。实例保存配置，不等于已经连接设备。
3. 打开串口，将配置实例绑定到该会话；自动监听需要明确启用。
4. 从管理器运行手动动作，或在快捷命令中插入插件动作。
5. 停止/解绑会取消任务并清理实例资源；串口断开、系统休眠后也会解除绑定，恢复后需要重新绑定。

安装插件不自动获得已连接串口的控制权。一个配置实例同一时间只绑定一个会话；要同时使用多个串口，创建多个实例。

## 插件目录

最小插件包含 manifest.json 与 index.cjs。示例入口导出 CommonJS activate(ctx)，返回手动动作所需的 run、自动监听所需的 onData，以及可选的 dispose：

```js
exports.activate = async ctx => ({
  async run(actionId, args) {
    const result = await ctx.serial.exchange('AT\r\n', {
      match: 'OK', timeoutMs: 3000
    })
    return { ok: true, response: result.text }
  },
  async onData(event) {
    // event.bytes 为 number[]；event.text 是流式解码文本。
    // 一次回调不保证是完整协议帧，需在实例中维护协议缓存。
  },
  async dispose() {
    // 清理插件自己的定时器和缓存。
  }
})

```

manifest 字段：

| 字段 | 含义 |
|---|---|
| id / name / version | 稳定插件 ID、显示名、插件版本 |
| apiVersion | 当前为 1，不兼容版本拒绝安装 |
| entry | 插件目录内的预编译 JavaScript 入口（.js、.cjs 或 .mjs）；示例使用 CommonJS |
| configSchema | 配置结构及默认值 |
| actions | id、label、可选 description 的动作列表 |
| autoRespond | 是否提供自动监听能力 |
| capabilities | API v1 仅接受 serial.read、serial.write；其他能力名会拒绝安装 |

配置表单支持 object/string/number/integer/boolean/array、enum、required、默认值、长度与数值范围等常用 schema 子集。复杂数组/对象可在 JSON 编辑器填写；主进程再次校验。该 schema 不是完整 JSON Schema 实现；不支持的关键字会拒绝安装，不能使用 oneOf、$ref 等未实现的约束。

## SDK

- ctx.config：本次实例配置快照。
- ctx.autoEnabled：本次绑定是否启用自动监听；onData 还要求 manifest.autoRespond 为 true。
- ctx.session：panelId、connectionId、串口路径和编码信息。
- ctx.serial.write(data, options)：发送字符串或字节数组，单次 1 至 65536 字节。字符串默认 UTF-8，可指定 encoding 为 hex；不会自动按会话编码转为 GBK，需要其他编码时传字节数组。secret 标记接入宿主敏感值处理。
- ctx.serial.exchange(data, options)：先注册新响应等待器再发送，累计新接收数据并等待 match 子串。encoding 为 hex 时按十六进制字节匹配（忽略 match 中空格和大小写），其余情况匹配文本。timeoutMs 默认 5000、范围 10 至 30000 毫秒；maxBytes 默认 65536、最大 262144。返回 text、bytes、receivedAt；超时、超限或取消会抛错。响应等待计时在取得串口租约之后开始，不包含租约排队时间。
- ctx.log(level, message)：level 为 debug、info、warn 或 error；诊断日志在内存中全局保留最近 300 条，每条最多 4096 字符。勿写入口令或 Cookie。
- ctx.state(value)：上报可 JSON 序列化的插件状态，序列化后最多 16384 字符；不合法或超限的状态被忽略并记警告。旧绑定实例迟到的状态和日志会被丢弃。
- run(actionId, args)：手动动作；返回 {ok:false,error} 可使宏停止，成功返回 {ok:true,...}。
- onData(event)：自动监听事件；按顺序处理，队列最多 128 个事件或 256 KiB 接收字节。任一上限被超过时会停止实例并报错，不会静默丢帧后继续应答。
- dispose()：停止、更新、断开或销毁时清理自有资源。

所有 serial 调用必须在 run 或 onData 回调中顺序 await，确保回调返回前已完成。不支持对同一实例并发执行多个 write/exchange，也不要从脱离回调生命周期的定时器发起串口请求。插件应在 dispose 中清理自己的定时器；宿主会取消在途请求，并在清理超时后结束外部进程。

宿主统一仲裁动作与其他发送来源。有写权限的手动动作取得租约后持有至动作结束；自动回调在首次需要发送时申请租约，持有至该回调结束。插件租约按 FIFO 等待（最多 64 项），可通过停止实例取消等待；队列已满、取消或连接变化会明确失败。终端直接输入等同步发送在串口被占用时立即拒绝。插件不应通过导入 serialport 自行打开端口。重连后的连接身份不同，旧实例不能继续写入新连接。

## 例子

- examples/plugins/text-hex-responder：无需 OA 的完整文本/HEX 自动应答插件，支持分批、多次命中、延时与停用清理。
- examples/plugins/template：主动查询和等待响应的起始模板。
- 现有 OA 配置/宏保持兼容，OA 业务通过内置适配器接入。

## 配置与版本

插件包、用户配置实例、运行中会话绑定分别管理。配置实例有独立 ID 和 configVersion。卸载插件包会停止相关实例并保留其配置与 ID，重新安装后可以恢复使用；明确删除配置实例才会删除该实例，引用它的快捷命令需要重新选择。停用实例不会删除配置。运行中修改普通参数需先停止或等待动作完成；禁用和关闭自动监听会取消在途工作。空闲绑定实例更新配置时重建并使用新快照，不会把旧 busy 状态复制给新的监听对象。
已绑定的插件不能直接覆盖安装，需先解除相关绑定。更新包校验通过后再切换，失败保留已安装版本；已有实例下次绑定时按新 schema 校验。当前仅支持 apiVersion: 1 和 configVersion: 1，没有任意版本之间的自动配置迁移。

## 信任与运行边界

API v1 外部包是用户信任的本地代码。utilityProcess 隔离卡死/崩溃并便于终止，但仍具有 Node API；能力清单不构成文件和网络的操作系统沙箱。不要安装来源不可信的代码。
端口与现有 OA 登录会话由宿主管理。插件自动布防与安装分开，敏感串口事务不应向无关监听者广播秘密。

## 验证

独立协议测试：node examples/plugins/text-hex-responder/test.cjs。
宿主单元与集成测试挂入 npm test；Electron 插件冒烟验证实际构建后的独立 worker、安装、绑定和动作。
Box 的模拟串口与 Linux Electron 测试不替代 Windows CI 和真实设备/OA 联调。实际通过项见[三阶段验收记录](../openspec/changes/archive/2026-11-16-add-device-plugin-system/tasks.md)和 PR。

## 插件包生成

在仓库执行 `npm run plugin:pack -- examples/plugins/text-hex-responder <输出路径>.json` 生成自包含 JSON 包，包含 manifest 和文本文件映射。目录和 JSON 包均可安装；API v1 不直接解压 ZIP，不运行安装脚本。包上限 4 MiB、128 个文件，不含 node_modules；运行依赖请预先打包到 JS。
