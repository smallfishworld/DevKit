# OA 解锁迁出为外部插件

## 背景

OA 解锁包含公司 OA 地址、取码接口和挑战码格式等业务细节，却作为 `devkit.oa-debug` 内置在 DevKit 中发行。业务变化需要跟随 DevKit 发版，且与「设备插件」的可扩展目标冲突。

## 变更

1. 从 DevKit 删除内置 OA 实现、设备动作匹配/配置/提供者和对应测试，不再注册内置 `devkit.oa-debug`。
2. 在 DevKit-Plugins 仓库新增 `plugins/oa-unlock`，保留插件 ID `devkit.oa-debug`、配置结构、动作 ID 和原有手动/自动流程。
3. 将 OA 依赖的宿主内部能力收敛为通用插件 API：`serial.subscribe`、`serial.acquire`（跨回调独占租约）、`serial.hold` / `releaseHold`、`auth.session`。
4. 旧 `device-actions.json` 只在安装外部 `devkit.oa-debug` 后才迁移；未安装时不读取、不删除。
5. 同步 `device-plugins` 与 `serial-terminal` 的现行行为描述，设备动作测试用例迁到插件仓库。

## 影响

- `device-plugins`：新增宿主能力要求，明确 OA 业务不内置及迁移触发条件。
- `serial-terminal`：认证、口令保护、扣键补发与自动应答描述改为插件驱动，宿主只提供通用能力。
- 已安装旧实例、宏和插件 ID 保持兼容；不再随 DevKit 分发 OA 代码。

## 状态

已实现并通过 DevKit typecheck、测试、插件仓库校验与真实宿主契约检查；尚未发布插件 Release（需用户确认）。
