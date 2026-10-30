# 串口终端无感恢复与磁盘历史滚动（2026-10-30）

## 用户体验定义

1. 切换标签 / 锁屏 / 窗口最小化：主进程持续串口读取并写入会话日志，隐藏的 xterm 不再渲染积压输出。
2. 回到实时终端：废弃旧显示世代和历史显示队列，但保留 xterm 已有回滚历史并仅复位 VT 模式，最多只追加最近 8 Ki UTF-16 代码单元的终端上下文，立即接续新输出。16 Mi 热缓存仍存在，但不再被全量重播。
3. 真正 Windows suspend/resume：系统唤醒后设置短时间的显示稳定窗口，接收和日志照常运行，期间积压不以“放录像”方式显示。操作系统/USB 设备真正丢失的字节不可能补回。
4. 用户滚动：优先沿用 xterm 自身的有限回滚；到达其顶部后继续向上，打开覆盖终端绘图区（不遮挡查找条）的只读磁盘历史浏览层，向上每次查询不超过 160 行，单次倒读至多 256 KiB；窗口最多缓存 8 个页面，往回浏览时按磁盘游标重新加载被移出的较新页面。滚动回最新或按 End 返回实时终端。
5. 无新增设置。现有“历史日志”按钮保留，用于检索、打开任意日志和导出。

## 参考 MobaXterm

MobaXterm 官方文档将 terminal scrollbar/scrollback 和“Log terminal output to the following directory”描述为独立功能；没有官方资料证明它在滚动到内存回滚顶部后自动注入磁盘旧日志。DevKit 采用相同的实时与历史分层，但增加按需磁盘历史浏览层。

官方资料：https://mobaxterm.mobatek.net/documentation.html

## 实现接口

- `DisplayBacklog.recent()`：O(8 KiB) 取最新文本，保留 UTF-16 代理对完整性。
- `TerminalRuntime.setVisible()`：后台不再触发 `pumpReplay()`；恢复前淘汰旧 `OutputWindow` 世代，通过 `output:reset` 清理 xterm 解析状态，再显示短尾。
- `SerialService.onSystemResume()`：短期拦住唤醒时驱动突发的显示，磁盘仍记录所有收到的字节。
- `SessionHistory.tailPage()` / `history:tail`：按字节游标向前读取固定上限的纯文本日志。
- `TerminalHistoryInline.vue`：在终端同一区域按需显示历史文本，最多保留 8 页 DOM；向前、向后浏览均按磁盘游标重新加载，不影响实时采集。
- `output:resync`：串口恢复显示时仅重同步 VT 解析状态并保留 xterm scrollback；`output:reset` 仍用于开启新会话或主动重置。

## 限制与下一阶段

- 磁盘历史是带时间戳的纯文本、非原始 VT 字节和屏幕快照；进入历史层不能保证与彩色 xterm 的视觉状态完全一致。
- xterm 回滚到最顶部后，磁盘历史层目前从日志的最新尾页开始显示；**尚无与 xterm 首行对应的持久索引，因此不是严格意义上的无缝行号拼接**。下一阶段须增加按会话日志行号、换行与输出窗口位置索引，再实现严格一致的滚动边界与视觉锚定。
- 当前 16 Mi 后台热缓存并非 16 Mi 的可视回滚；它用于快速取得当前状态，完整可追溯内容由磁盘负责。
- 真正睡眠及 USB 重枚举期间的硬件丢字节无法靠应用回放修复。需要 Windows 实机、不同串口芯片的回归与 MobaXterm 同机对比。
