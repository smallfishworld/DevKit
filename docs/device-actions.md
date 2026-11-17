# 串口设备动作配置

设备动作把「OA 登录 → 读设备挑战码 → 申请口令 → 注入 → 验证结果」固化成本地配置。
该功能由外部插件「OA 设备解锁」（`devkit.oa-debug`）提供，不再随 DevKit 内置发行；
插件源码与打包产物见 `smallfishworld/DevKit-Plugins` 仓库的 `plugins/oa-unlock`。
配置保存在插件实例中，每个实例拥有独立配置，可分别绑定不同串口，手动动作通过快捷命令的「插件动作」步骤调用。

## 安装插件

在串口面板左侧「会话」栏点击「插件」，打开「插件源」页绑定 `smallfishworld/DevKit-Plugins`
（或导入该仓库生成的 `devkit.oa-debug-1.0.0.devkit-plugin.json`），安装「OA 设备解锁」。
外部插件是可信本地代码，安装前会要求确认来源；插件进程不是安全沙箱。

## 界面配置（推荐）

安装插件后，在插件管理：

- 在「插件」页签的「配置与当前串口」中新建或编辑 OA 设备解锁实例；
- 实例配置即本文描述的完整结构，保存前会校验；
- 勾选「绑定后自动监听」并在需要自动应答时绑定到当前串口；
- 手动动作从快捷命令编辑器的「插件动作」步骤中选择该实例的「执行设备动作」。

实例配置的读取、快照与失效处理见 `openspec/specs/device-plugins/spec.md`。

## 手工配置（旧版导入）

旧版配置文件位于 DevKit 用户数据目录（Windows 默认为 `%APPDATA%\DevKit\device-actions.json`）。
DevKit 不再内置 OA 实现，也不会主动读取该文件；安装 `devkit.oa-debug` 插件后，
宿主才把该文件中每个 profile 迁移为一个 `legacy-<id>` 插件实例，之后修改原文件无效。
未安装插件时旧配置保持原样，不会被读取、迁移或删除。

## 模式

| `trigger` | 发起方式 | 典型用途 |
|---|---|---|
| `manual`（默认） | 快捷命令中的「插件动作」步骤 | 主动输入 `debug` 解锁后接续执行命令 |
| `auto` | 插件实例启用「绑定后自动监听」并绑定串口后常驻监听 | 用户手敲触发词，设备自行打印特征码并等待口令 |

`auto` 配置不会出现在快捷命令步骤候选中。自动模式的流程：

1. 设备回显的整行等于 `triggerWords` 之一（允许行首 `#`、`>`、`$`、`%` 提示符）→ 扣住用户后续输入。
2. 设备输出合法特征码（`detect`）→ 开始 OA 会话确认与取码。
3. 注入口令后按 `result` 判定：`prompt-repeat` 命中重新索要口令 = 拒绝；`silenceMs` 内无输出 = 接受。
4. 接受则按原顺序补发扣住的输入；拒绝、超时、取消、断开或关闭监听则丢弃。扣留上限由 `holdInput` 控制。

## 完整示例

```json
{
  "loginUrl": "https://oa.example.com/login",
  "authOrigins": ["https://sso.example.com"],
  "authCheck": { "type": "json", "url": "https://oa.example.com/api/status", "field": "authenticated" },
  "issue": {
    "url": "https://oa.example.com/api/device/token",
    "body": { "customMsg": "$challenge", "source": "devkit" },
    "responsePath": "data.data",
    "loginExpiredHttp": [401, 403],
    "loginExpiredCodes": ["003", "403003"],
    "retryLoginOnce": true
  },
  "profiles": [
    {
      "id": "debug-unlock",
      "label": "Release 设备解锁 Debug",
      "actionLabel": "解锁 Debug",
      "trigger": "manual",
      "command": "debug",
      "detect": { "type": "prefix", "prefix": "Challenge:" },
      "result": { "type": "line", "successLine": "Debug unlocked", "failureLine": "Debug denied" }
    },
    {
      "id": "debug-auto",
      "label": "Release 设备自动解锁",
      "actionLabel": "自动解锁 Debug",
      "trigger": "auto",
      "triggerWords": ["debug", "Debug", "zhimakaimen"],
      "detect": { "type": "base64-line" },
      "result": { "type": "prompt-repeat", "promptText": "Password:", "decisionDelayMs": 150, "silenceMs": 3000 },
      "holdInput": { "maxBytes": 4096, "maxMs": 15000 }
    }
  ]
}
```

## 字段说明

### 顶层

- `loginUrl`：OA 登录入口，也是 `Origin`/`Referer` 的来源。必须与两个接口同源。
- `authOrigins`：登录流程中允许跳转的额外来源（仅协议+主机+端口）。企业 SSO 回跳常用 http 地址时，可填 `http://` 来源；登录检查与取码接口本身仍必须是 HTTPS 或与登录入口同源。
- `authCheck`：
  - `{ "type": "json", "url", "field" }`：`field`（支持 `a.b` 点路径）为 `true` 视为已登录；
  - `{ "type": "http-ok", "url" }`：2xx 即已登录，重定向与 401 视为未登录。
- `issue`：
  - `body`：POST JSON 模板，值中的 `$challenge` 替换为设备挑战码（至少一个字段必须包含）；
  - `responsePath`：响应中口令的点路径，默认 `response`；
  - `loginExpiredHttp` / `loginExpiredCodes`：视为登录失效的 HTTP 状态与业务 `code`；
  - `retryLoginOnce`：失效后重新确认登录并重试一次，默认 `true`；
  - `userAgent`：可选，默认使用内嵌浏览器的 UA。

### profile

- `id` / `label` / `actionLabel`：唯一 ID、配置显示名、动作显示名。
- `kind`：目前仅 `challenge-response`。
- `command`：manual 必填，发往设备的起始命令；auto 可省略。
- `newline`：`cr`（默认）/ `lf` / `crlf`。
- `triggerWords`：auto 的输入回显触发词（大小写敏感，整行匹配）。
- `detect`：
  - `{ "type": "prefix", "prefix" }`：行首前缀，前缀后为挑战码；
  - `{ "type": "base64-line" }`：短码 `shortMin`~`shortMax`（默认 20~21，且必须以 `=` 结尾）或长码 ≥`longMin`（默认 300）且解码 ≥`longMinDecoded` 字节（默认 260）。
- `result`：
  - `{ "type": "line", "successLine", "failureLine" }`：整行精确匹配；
  - `{ "type": "prompt-repeat", "promptText", "decisionDelayMs", "silenceMs" }`：默认 `Password:` / 150ms / 3000ms。
- `challengeTimeoutMs`：等待挑战码的时间，默认 5000。
- `challengeTtlMs`：挑战码有效期（从收到时算），默认 30000。
- `resultTimeoutMs`：`line` 判定等待明确结果的时间，默认 5000。
- `holdInput`：auto 默认 `{ "maxBytes": 4096, "maxMs": 15000 }`；`false` 表示不扣键，动作期间写入按旧行为拒绝。

## 行为与限制

- 取码请求使用 Node `http`/`https` 发送，以便设置 PSH 校验的 `Origin`/`Referer`；Cookie 从专用 Chromium 会话读取。
- 所有接口必须 HTTPS（测试探针允许 `http://127.0.0.1` 回环）。
- 口令只存在于内存：发送审计、历史日志、事件消息均以「[口令已隐藏]」替换。
- 同一实例同一时间只执行一个解锁；串口事务获取失败、连接变化或实例停止会安全释放租约。
- 自动监听与串口绑定不持久化；串口重新连接或面板重新打开需重新绑定实例。
