# 设备插件（API v2）

## 架构概览与契约包

DevKit 插件体系基于独立同构契约包 `packages/plugin-sdk`（`@devkit/plugin-sdk`），统一导出 API v2 类型、`validateSchema`/`validateConfig`/`applyDefaults`、`parseManifest`/`satisfiesMinVersion` 与官方单测夹具 `createMockPluginContext`。宿主通过通用流会话抽象 `StreamSessionBridge` 向插件开放 **串口（`serial`）、SSH（`ssh`）、网络调试（`net`）与本地终端（`pty`）** 四类传输能力。

外部插件运行于独立 Electron `utilityProcess`，底层传输句柄仍由 DevKit 主进程持有。**该进程提供崩溃隔离而非安全沙箱**：插件仍能使用 Node.js 文件系统与网络；`capabilities` 仅约束 DevKit 提供的流与认证 API。请仅安装经过核实的可信插件。

## 安装、开发热重载与运行

1. 从扩展中心安装本地插件目录、自包含 JSON 插件包或 HTTPS 扩展源（v2 索引）；不直接导入 ZIP。
2. 开发者可在开发态调用 `watch:start` / `watch:stop` 监听本地插件目录，源码或清单改动时自动防抖重装并安全重绑活跃实例。
3. 选择插件并创建配置实例（`configVersion: 2`）；在已连接的串口、SSH 或网络面板中按 `transports` 过滤并手动绑定。
4. 插件运行态的高频 `status` 与 `log` 事件通过增量通道直接同步到前端 Store，异常停止时浮层提供「一键重试绑定」。

## 插件入口与 Manifest（API v2）

最小插件包含 `manifest.json` 与 `src/index.cjs`（在 `DevKit-Plugins` 中也支持直接编写 `src/index.ts` 由内置 `esbuild` 管线自动预打包）：

```js
exports.activate = async ctx => ({
  async run(actionId, args) {
    ctx.signal.throwIfAborted()
    const result = await ctx.stream.exchange('AT\r\n', {
      match: 'OK', timeoutMs: 3000
    })
    return { ok: true, response: result.text }
  },
  async onData(event) {
    // event.bytes 为 number[]；event.text 是流式解码文本。
  },
  async dispose() {
    // 清理插件自己的定时器和缓存。
  }
})
```

### manifest 字段

| 字段 | 含义 |
|---|---|
| `id` / `name` / `version` | 稳定命名空间 ID、显示名、SemVer 版本 |
| `apiVersion` | 固定为 `2` |
| `minHostVersion`（可选） | 最低兼容 DevKit 宿主版本，低于该值时拒绝安装与绑定 |
| `transports` | 必填非空数组，声明支持的传输类型：`serial`、`ssh`、`net`、`pty` |
| `entry` | 插件目录内的预编译 JS 入口（`.js`、`.cjs` 或 `.mjs`） |
| `configSchema` | 顶层为 `object` 的受控 Schema，支持 `x-visibleWhen` 条件显隐与对象数组规则编辑 |
| `actions` | `id`、`label`、可选 `description` 的动作列表（最多 32 项） |
| `autoRespond` | 是否提供自动监听能力 |
| `capabilities` | API v2 接受 `stream.read`、`stream.write`、`stream.exclusive`、`auth.session`；`autoRespond: true` 须声明 `stream.read`，`stream.exclusive` 须同时声明 `stream.write` |

### 条件显隐与多规则数组表单

- `x-visibleWhen`：支持 `{ field, equals?, notEquals?, in? }`，根据同级字段值动态显隐表单项；隐藏字段在保存校验时自动跳过 `required` 检查。
- 对象数组控件：当字段声明 `type: "array"` 且 `items.type === "object"` 时，表单自动渲染规则卡片列表，支持新增、删除及嵌套子字段的 `x-visibleWhen`。

## SDK 运行时上下文（`PluginContext`）

- `ctx.config`：本次实例配置快照（已按 Schema 填充默认值）。
- `ctx.autoEnabled`：本次绑定是否启用自动监听。
- `ctx.session`：`{ panelId, connectionId, transport, target, encoding }`。
- `ctx.signal`：`AbortSignal`（内置与外部插件均可用），在停止、解绑、断开或热重载时触发中止。
- `ctx.stream.write(data, options)`：发送字符串或字节数组（1 至 65536 字节），支持 `encoding: 'utf8' | 'hex'` 与 `secret: true`。
- `ctx.stream.exchange(data, options)`：先订阅响应再写入，等待 `match` 子串，`timeoutMs`（10–30000ms）与 `maxBytes`（1–262144）。
- `ctx.stream.subscribe(listener)`：独立接收订阅，返回取消订阅函数；需要 `stream.read`。订阅不占用自动应答队列，可在动作等待登录或网络请求时继续接收数据。
- `ctx.stream.acquire()`：取得跨回调独占租约，返回 `{ connectionId, write, release }`；需要 `stream.exclusive`。在流程完成后 `await lease.release()`，停止、断开和进程退出时宿主兜底释放。
- `ctx.stream.hold(options)` / `ctx.stream.releaseHold(replay)`：仅串口支持，且须声明 `stream.exclusive`。扣住用户输入后，成功时在仍持有租约期间调用 `releaseHold(true)` 按原顺序补发；失败时调用 `releaseHold(false)` 丢弃。`maxBytes` 默认 4096，范围 256–1048576；`maxMs` 默认 15000，范围 1000–300000。
- `ctx.auth.login(options)` / `ctx.auth.request(options)`：须声明 `auth.session`；由宿主管理独立的持久登录会话。插件提供 HTTPS `loginUrl`、登录检查或业务请求；业务请求与登录检查必须与登录地址同源，Cookie 不返回插件。`request` 返回 `{ status, text }`，响应体最多 64 KiB；Cookie、Host 等由宿主管理的请求头不能由插件覆盖。
- `ctx.log(level, message)` / `ctx.state(value)`：增量上报诊断日志（全局保留最近 300 条）与运行态指标（≤ 16 KiB）。
- `run(actionId, args)`：失败时须直接 `throw Error` 以中止宿主宏后续步骤。

所有异步流写入与租约调用须顺序 `await`，禁止对同一实例并发调用 `write`/`exchange`。订阅返回的取消函数须在实例清理时调用；延时发送须维护串行写队列，并在 `dispose` / `reset` / `ctx.signal` 中止时取消待发定时器。使用 `stream.exclusive` 的插件自行取得与释放显式租约，宿主不会为其预先占用会话；其他发送来源在租约期间按会话仲裁规则等待或拒绝。旧 `connectionId` 的租约不能写入重连后的会话。


## OA 外部插件与旧配置迁移

OA 设备解锁由 [DevKit-Plugins 的 `plugins/oa-unlock`](https://github.com/smallfishworld/DevKit-Plugins/tree/main/plugins/oa-unlock) 提供，稳定 ID 为 `devkit.oa-debug`，支持串口。宿主只提供通用流租约、输入扣留、秘密值保护与认证会话；触发词、挑战码识别、取码请求和结果判定由插件实现。

1. 按插件仓库说明打包并在全局「扩展中心」安装本地 JSON 包；从 HTTPS 扩展源安装须等待相应版本正式发布。
2. 安装该插件后，宿主才读取旧 `device-actions.json`，把有效 profile 转成 `legacy-<profile ID>` 的 API v2 配置实例。既有同 ID 实例不覆盖，旧文件不删除；迁移失败与其他插件隔离，可重试。
3. 迁移实例默认不启用自动监听，也不会自动绑定串口。检查配置后从「当前串口插件」绑定，按需启用自动监听。
4. 旧 `device-action` 宏步骤仍按现行导入规则丢弃；需要继续使用时，在宏中选择迁移实例及其插件动作。迁移不恢复已移除的设备动作编辑器。

自动解锁成功后，插件在同一独占租约内补发暂存输入；失败、超时、停止或断开时丢弃。发送口令须使用 `secret: true`，插件自身日志与状态也不得包含口令。秘密值的即时、跨批及延迟回显由宿主统一处理，不能广播给无关订阅者。
