# 设计：宿主通用能力与外部 OA 插件

## 数据流

1. 外部插件在独立 utilityProcess 中 `activate(ctx)`，声明 `serial.read`、`serial.write`、`serial.exclusive`、`auth.session`。
2. 自动监听由单个 `serial.subscribe` 接收数据。插件自行按行缓存，把数据路由到当前交换、结果判定或触发词检测。
3. 命中触发词时调用 `serial.hold` 扣住用户输入；命中挑战码后调用 `serial.acquire` 取得跨回调租约，再通过 `auth.login` / `auth.request` 完成认证与取码。
4. 口令以 `secret: true` 经租约写入。成功后 `releaseHold(true)` 在释放租约前补发；失败或取消时 `releaseHold(false)` 丢弃。
5. 手动动作先认证、再取得租约、发送设备命令、等待挑战码并注入口令；同一实例同步拒绝并发动作。

## 关键决策

- **保留插件 ID 与配置结构**：`devkit.oa-debug`、`{ deviceActions, profileId, auto }` 和动作 `run` 不变，旧实例、宏和审计引用无需迁移命名。
- **能力最小化**：宿主只暴露订阅、租约、扣键和隔离认证；挑战码识别、取码请求和结果判定留在插件内，DevKit 不再理解 OA 业务。
- **租约所有权**：`serial.acquire` 返回的租约可跨回调保持；插件显式释放，停止、断开、禁用或崩溃时宿主兜底释放并丢弃扣住的输入。
- **认证隔离**：Cookie 保存在按登录来源哈希命名的 Chromium 持久分区；插件只获得状态码和响应文本。登录检查与业务接口必须与登录入口同源，敏感请求头由宿主保留。
- **迁移门槛**：仅当外部描述符包含 `devkit.oa-debug` 时读取旧 `device-actions.json`，避免未安装插件时产生幽灵实例或删除用户数据。
- **信任边界**：utilityProcess 隔离崩溃和卡死，但不是安全沙箱；安装/更新仍要求用户确认外部代码可信。

## 失败处理

- 取码失败只报告字段结构、长度或业务 code，不输出可能的口令。
- 登录失效按插件配置重登一次；仍失败则释放租约并按失败策略丢弃扣键。
- 串口连接身份变化、实例停止或回包超时都会拒绝旧租约写入，防止口令发送到新连接。
- 插件被宿主停止时取消在途 RPC、清空订阅和自动应答队列，并释放租约。

## 验证

- DevKit：`npm run typecheck`、`npm test`（含 `plugin-backend-test.js` 的订阅/独占/扣键/auth 参数回归）。
- DevKit-Plugins：`npm run validate`、`node scripts/test.cjs`、`npm run check`、`node scripts/check-host.cjs <DevKit>`。
- 真实 OA 地址、Cookie 和设备联调仍由部署方在 Windows 上完成。
