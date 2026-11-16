# Tasks

- [x] 扩展 `device-actions.json` 解析：`trigger`、`detect`、`result`、`holdInput`、`authCheck`、`issue`
- [x] 抽出纯匹配模块 `device-action-match.ts` 并补单测
- [x] 主进程自动监听、输入扣留/补发与自动动作生命周期
- [x] 渲染层「自动应答」开关、状态与重连恢复
- [x] 快捷命令设备动作候选仅保留 manual 配置
- [x] 串口面板「设备动作」可视化配置（表单 + 高级 JSON + 示例生成 + 保存校验）
- [x] 集成测试：手动流程、自动应答接受/拒绝、补发/丢弃、断开与取消
- [x] 配置存储测试：缺失/损坏/超限、校验失败不覆盖、示例可解析
- [x] 更新 Electron UI 冒烟（自动应答与可视化配置保存）
- [x] 同步主 specs
- [x] `npm run dev` 手工冒烟自动应答 UI（2026-11-16 用户实测 PSH 解锁通过）
- [x] 冒烟通过后归档（2026-11-16）
