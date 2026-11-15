# Debug 解锁设计和部署配置

快捷命令保存 `debug-unlock` 步骤和设备配置 ID。主进程通过现有 `serial` 服务处理设备配置、执行和取消。绑定串口连接对象，在登录后获取独占写入权。每阶段处理新的接收数据。普通串口输出继续走现有显示和历史链路。发送审计只记录口令已隐藏。对于连续文本回显，包括分到多个接收批次的回显，按原口令匹配后脱敏。若实际设备会在口令字符中间插入控制序列、掩码或重新编码，部署前验证其表现。

独立 OA 窗口启用沙箱，禁用 Node.js 与新窗口，无应用 preload。只允许导航到业务和显式配置的认证来源。后台请求留在业务来源，拒绝跟随跳转。登录状态来自业务接口。专用持久会话只保存 Chromium 正常管理的站点数据，保留期限由站点 Cookie 决定。

以下为公司部署方放入 DevKit 用户数据目录（与现有 `config.json` 同目录）的 `debug-unlock.json` 示例，所有主机、路径和提示均为虚构。保存后重新打开快捷命令编辑器读取配置。

```json
{
  "loginUrl": "https://debug.example.invalid/debug",
  "statusUrl": "https://debug.example.invalid/api/session",
  "issueUrl": "https://debug.example.invalid/api/unlock",
  "authOrigins": ["https://oa.example.invalid"],
  "challengeField": "challenge",
  "responseField": "response",
  "profiles": [
    {
      "id": "release-serial",
      "label": "Release 串口",
      "newline": "cr",
      "challengePrefix": "Challenge:",
      "successLine": "Debug unlocked",
      "failureLine": "Debug denied",
      "challengeTimeoutMs": 5000,
      "challengeTtlMs": 30000,
      "resultTimeoutMs": 5000
    }
  ]
}
```

接口约定：`GET statusUrl` 返回 `{ "authenticated": true }` 或 `{ "authenticated": false }`，也可用 HTTP 401 表示登录过期。取码接口用 Cookie 认证，接受 `POST` JSON，响应含配置的口令字段。如果真实接口使用其他请求体、字段结构或防伪令牌，按公司接口约定调整适配层。设备提示采用以 CR 或 LF 结束的完整行，去掉 ANSI 控制序列和行两端空白后匹配。挑战码及口令应为 4 至 256 个 ASCII 字符，允许字母、数字和 `._~+/=-`。上线以公司接口、设备固件及 OA 策略核对实际格式。

模拟验收使用两套入口。`npm test` 的解锁服务测试覆盖旧数据过滤、跨批次回显、拒绝、超时、取消和断线重连。`npm run build` 后执行 `npm run test:debug-unlock-smoke`，在实际 Electron 界面新建快捷命令，操作模拟 OA 网页并验证同一会话复用 Cookie、设备成功确认后发送版本查询、取码 HTTP 403 阻止继续执行。
