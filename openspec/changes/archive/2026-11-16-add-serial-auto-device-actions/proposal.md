# 串口设备动作支持自动应答

## Why

公司设备的 Release 串口在不发送 `debug` 的情况下也可能主动打印裸特征码并停在 `Password:` 提示前。现有设备动作只能由快捷命令主动发起，用户必须手动确认设备状态，无法覆盖「用户先输入触发词、设备输出特征码后等待口令」的流程。

## What Changes

- 设备动作配置新增 `trigger: auto`：串口面板可开启「自动应答」，常驻监听设备输出。
- 自动应答以设备回显的触发词（默认 `debug`）开始扣住用户输入；设备输出裸特征码（短 base64 行或长 base64 块）后自动走 OA 会话取口令并注入。
- 结果判定可配置：`line`（明确成功/失败行）或 `prompt-repeat`（观察窗内设备重新索要 `Password:` 即拒绝，静默即接受）。
- 扣住的用户输入在成功时按原顺序补发，拒绝、超时、取消或断开时丢弃；大小与时长有上限。
- 取码请求通用化：请求体字段模板（`$challenge`）、响应口令路径、登录失效 HTTP/业务码及一次重登重试。
- 自动应答配置不出现在快捷命令的设备动作步骤候选中。
- 串口面板新增设备动作可视化配置：表单页签（OA 登录、取码接口、动作列表增删改）与高级 JSON 兜底，首次一键生成示例，保存前主进程校验并原子写入。

## Impact

- `serial-terminal`：新增自动监听、输入扣留/补发、自动动作生命周期与串口重连后的重新布防。
- `terminal-command-macros`：设备动作步骤仅接受 manual 配置。
- 配置格式变更：`device-actions.json` 由 `statusUrl`/`issueUrl`/`challengePrefix`/`successLine` 等扁平字段迁移为 `authCheck`、`issue`、`profiles[].detect`、`profiles[].result`。旧字段不再被解析。
