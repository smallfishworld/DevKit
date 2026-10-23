# 终端历史与背压验证（2026-10-23）

## 自动化回归

运行 `npm run typecheck`、`npm test`、`npm run build`。

新增 `tests/terminal-test.js` 覆盖增量 ANSI/CRLF 清洗、Unicode 跨批边界、无换行输出、字节单次计数、最新状态节流、输出 ACK 高低水位、旧会话 ACK、队列溢出、面板生命周期、慢盘/磁盘失败、分页查询、流式导出及销毁引用释放。

新增 `tests/terminal-services-test.js` 使用模拟串口和真实 ssh2 本地服务，覆盖断开时尾部输出、重复销毁、连接尚未完成时销毁、串口暂停恢复、SSH stderr、通配销毁，以及异步创建日志期间 SSH 断线的清理顺序。网络测试需要允许本地监听。

## 实际界面冒烟

在 macOS 上通过 `tests/probes/terminal-ui-smoke.ts` 启动真实 renderer、preload、统一 IPC、配置服务及 SSH 服务；其余依赖 Win32 的服务不加载。测试配置、日志和 SSH 服务均隔离在临时目录与本机地址，不修改日常配置。

```sh
npm run build
npx esbuild tests/probes/terminal-ui-smoke.ts --bundle --platform=node --packages=external --outfile=tests/.terminal-ui-smoke.cjs
npx electron tests/.terminal-ui-smoke.cjs
```

实际操作与结果：

- 终端设置选择 1 万行，配置文件确认持久化。
- SSH 连接预填的本机服务，终端输入 `flood`，完成 120,000 行带中文和 ANSI 颜色的输出，末尾显示 `FLOOD-DONE`。
- 磁盘日志包含 120,000 条 `ROW-`，唯一标记 `NEEDLE-50000` 出现一次；日志约 10.8 MB。
- 历史日志输入 `NEEDLE-50000`，按段翻页找到第 50,000 行，证明超出回滚范围的记录仍可查询。
- 清空终端后导出日志，导出文件与当时的完整会话文件逐字节一致；断开后会话日志正确追加尾部标记。
- 最终版本再运行 120,000 行输出，状态栏显示 RX 8,768,943 / TX 6，突发结束后不再滞留首笔计数。
- 关闭窗口正常退出测试进程。

## 验证边界

当前机器不是 Windows，未实测 ConPTY 或真实串口硬件、RTS/CTS 对端行为；Windows 完整程序仍需平台冒烟。没有将这次功能回归当作 GC 暂停或内存降幅的性能基准，也未生成安装包。

关闭「保留日志」仍会写临时磁盘历史，正常关闭面板、重连或退出时删除。持久日志需自行清理；无硬件流控的串口不能通过软件保证对端停止发送，超限会明确暂停显示或关闭会话。
