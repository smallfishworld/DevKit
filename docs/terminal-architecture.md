# 终端架构、数据保留与验证

> 当前技术设计和验证入口。对外行为以 [OpenSpec：串口终端](../openspec/specs/serial-terminal/spec.md)及 [SSH/本地终端](../openspec/specs/ssh-and-local-terminals/spec.md) 为准。以下描述按 2026-11-04 的串口后台连续解析修改更新；历史计划与 Review 通过 Git 记录追溯，不再作为现行设计。

## 1. 为什么将终端视图与日志分开

实时 xterm、后台缓存和磁盘归档解决不同问题：

| 层 | 职责 | 边界 |
| --- | --- | --- |
| xterm.js / WebGL | 真实 VT/ANSI 字符渲染，色彩、回滚、输入与查找 | 正常回滚 20 万行，不是无限历史 |
| OutputWindow | 分帧发送和 ACK 驱动的流控（会话世代、序号） | 约 16 Ki/帧，128 Ki/32 Ki 水位，2 Mi 显示积压硬上限 |
| 后台串口解析 | 隐藏时继续解析并维护同一份 xterm 状态 | 固定 20 万行回滚；继续使用 OutputWindow 水位 |
| SessionHistory | 按时间顺序写盘、日志检索和导出 | 清洗 ANSI/VT、逐行时间戳；待写不超过 4 MiB |
| 磁盘历史浏览层 | 有需要时在终端区域查看文本归档 | 每页不超过 160 行/256 KiB，最多 8 页 DOM 窗口 |

串口后台切换、锁屏或最小化时继续接收、落盘并解析输出。串口采集期间关闭主窗口后台定时器节流，最后一个串口关闭后恢复节流，xterm 对不相交的隐藏区域通过内部 IntersectionObserver 暂停绘制。返回页面沿用同一解析器、输出世代和回滚，不进行尾部重放或软复位。后台 CPU 消耗包含终端解析成本。DisplayBacklog 的旧尾部策略仍留在共享运行时供非连续模式使用，生产串口通过内部 keepParsingWhenHidden 选项启用连续模式。

真实 Windows suspend 时运行线程可能被冻结、USB 驱动缓冲可能丢失数据。应用使用 Electron 的防自动空闲休眠机制让采集保持运行（仍可熄屏）；**手动睡眠并不能保证零丢包**。系统休眠/唤醒按时间顺序写入标记；在休眠交界及唤醒后约 1200ms 的积压接收窗口中，用日志标记“设备产生时间不确定”，仍保留能收到的字节，通过 ACK 流控有序解析。恢复等待窗口仅用于日志时间来源标记，不暂停终端解析。需 Windows 真机验证。

## 2. 清屏、时间戳与 ANSI 色彩

- **清空终端**：串口服务先同步排空已进入 32ms 接收批次的旧 RX 数据，再写入“用户清空终端显示”的审计记录，最后按已入队日志字节数和完整行边界设置自动回滚下界并清空显示队列。清屏前内容及审计标记仍可通过全文日志搜索和导出获取，但不能通过普通滚轮再次出现。处理保持单个 JS 事件循环内同步排序；磁盘实际写入异步串行完成。
- **时间戳**：归档文件为了审计始终存 `[YYYY-MM-DD HH:mm:ss.mmm]`；串口 RX 行的时间戳取自**主进程收到该数据块时的回调时间**，同一个 32ms 合并批次中的各块分别保留其回调时间，渲染端仍按批合并。它并非设备产生时间，也不是物理线上逐字节到达的精确时刻。终端和磁盘浏览层遵循同一开关，关闭后不显示归档时间戳，开启时以 `[HH:mm:ss.mmm]` 形式呈现。
- **颜色**：实时 xterm 使用原始 ANSI/VT 控制序列，原生回滚包含设备颜色。清洗后的日志永久失去了 SGR 颜色/字体、光标位置和备用屏信息，**不能从旧 .log 精确恢复**。因此尽可能使用 xterm 原生彩色回滚：只有回滚已达到上限或其他模式存在显示缺口时才启用磁盘纯文本历史。
- **尚未做到的无缝衔接**：磁盘历史未建立 xterm 渲染行到文件偏移的完整索引，切换到文本历史仍可能重复或跳变。不能将纯文本日志当作 VT 屏幕快照。

设备发来的清屏控制序列（CSI 2J/3J、RIS）与用户按“清空终端”不同：串口默认中和会破坏回滚的 ED3/RIS；普通 VT 光标和 CR 原地更新保留语义。SSH 和本地终端保持既有标准终端行为。

## 3. 核心模块与数据路径

- `src/main/services/serial/index.ts`：SerialPort 会话、批量收取、休眠/唤醒、DTR/RTS、视图可见性。
- `src/main/services/terminal/runtime.ts`：统一输出窗口、显示世代、隐藏缓存、会话日志、IPC 回应。
- `src/main/services/terminal/history.ts`：异步追加、历史游标、文本查询、流式导出及清屏可视下界。
- `src/shared/terminal-stream.ts` 与 `src/shared/logtext.ts`：缓存和输出队列、日志清洗与时间戳转换。
- `src/renderer/src/components/TerminalView.vue`：实时 VT 显示和回滚；`TerminalHistoryInline.vue`：磁盘历史只读有界浏览。
- `src/renderer/src/composables/useTerminalStream.ts`：渲染端解析完成后才发送 ACK，旧世代 ACK 不再释放新世代队列。

IPC 统一使用 `window.api.invoke(tool, action, panelId, payload)` 和已有的 `tool:event` 机制；不得为同一行为另开通道。

## 4. 已验证与待验证

| 场景 | 证据或方式 | 现状 |
| --- | --- | --- |
| 类型检查、单测、Electron 构建、Windows 打包、node-pty 检查 | `.github/workflows/ci.yml` | 代码提交经 PR CI 验证 |
| 日志拆包、跨批 UTF-8、ANSI/CRLF、文件查询与导出、ACK 流控 | `tests/terminal-test.js`、`tests/logtext-test.js` | 自动测试 |
| 串口休眠标记、清屏前 RX 排空、跨清屏 UTF-8、每数据回调时间戳、RTS/CTS 模拟、关闭/重连、显示恢复 | `tests/terminal-services-test.js` | 自动模拟（不是硬件验收） |
| SSH 高吞吐 120,000 行、日志搜索与导出 | 历史 macOS 渲染器实验，见 Git 历史 `docs/terminal-validation.md` | 曾做界面冒烟，不能推断 Windows 硬件性能 |
| Windows 真机 CH340/CP210x/FTDI、115200/921600 baud、整夜日志 | 实机序号、吞吐、内存、CPU 与 MobaXterm 同机对照 | **尚未完成** |

不要把 GitHub CI 通过当成 USB 串口硬件无丢包的证据；不要声称全面超过 MobaXterm。保留显式错误状态和日志完整性边界，避免静默掩盖磁盘写入失败。

## 5. 后续变化应进入 OpenSpec

尚未交付的架构目标：
1. 新增独立原始字节流/VT 归档，保留原始 SGR、控制码与足够的时间信息；不破坏现有可读文本日志。
2. 建立屏幕状态检查点以及终端渲染行到磁盘偏移的索引，保证按需浏览时的颜色及行号一致性。
3. 真实设备长时间运行压测、自动/手动睡眠恢复压测和性能基准。

这些属于**未来改动**，不应写成“已实现要求”。每个改动使用 `openspec/changes/<change-name>/proposal.md`、`specs/`、可选 `design.md` 和 `tasks.md`；实施验收后同步到 `openspec/specs/` 并归档。参照 [OpenSpec 官方流程](https://openspec.dev/docs/quickstart)。

## 6. 历史记录与参考

被合并的历史文档在仓库 Git 历史中可检索：
`docs/serial-capture-cache-plan.md`、`docs/serial-live-history-design.md`、`docs/serial-scrollback-and-color-design.md`、`docs/reviews/` 以及 `docs/terminal-validation.md`。

关键变更：PR #2（16 Mi 后台缓存）→ PR #3（隐藏流控/休眠时序）→ PR #4（无感恢复）→ PR #5（保留原生回滚、限制历史 DOM）→ PR #6（清屏边界与时间戳）。

相关实践：MobaXterm 将终端回滚与磁盘日志分开；Tabby 使用 xterm，tio 分离清屏/时间戳/日志开关；Serial Studio 也把终端 ANSI 显示与可读日志分开。原始设备色彩归档须遵循 VT 解析语义，不能凭文本关键词着色。
