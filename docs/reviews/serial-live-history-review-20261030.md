# 串口无感恢复与磁盘历史滚动 Code Review（2026-10-30）

基线：PR #4，合并主分支 `f12ea252`，Windows CI `41016420865` 成功。审查涵盖 `TerminalRuntime`、`TerminalView`、`TerminalHistoryInline`、`SessionHistory`、`SerialService`，以及单元测试。

## 本轮确认并修复

| 优先级 | 问题与原因 | 修复 |
| --- | --- | --- |
| P0 | `setVisible(true)` 触发 `resetOutput` 后渲染进程执行 `TerminalView.reset()` 的 RIS（`ESC c`），硬复位会销毁已有 xterm scrollback；用户从休眠回来向上滚动无法看到原有历史 | 区分 `output:resync` 与 `output:reset`。恢复时让旧 IPC 世代失效、保留 xterm 已有滚动历史，仅用 DECSTR 等非清回滚复位终端状态；新会话硬重置逻辑不变 |
| P1 | 历史浏览组件 `rows = [...page.rows, ...rows]` 无限累积 DOM，越翻越慢 | 引入最多 8 页的滚动窗口；旧页从视图回收，返程可以用字节游标重新读取被移出的较新页面；每页最多 160 行/256 KiB |
| P1 | 浏览层 absolute 覆盖整个 `term-wrap`，导致 Ctrl+F 查找栏也被遮住 | 设立只覆盖 xterm 绘图区的 `term-stage` |
| P2 | 256 KiB 倒读页的起始字节可处于 UTF-8 多字节字符中，中文可能显示替代字符 `�` | 倒读后跳过开头的 UTF-8 continuation byte；增加中文及 emoji 的大日志回归测试 |

## 保持不变的原则

后台只记录不回放；返回显示最近 8 Ki 近期上下文；不清除磁盘历史；16 Mi 内存缓存上限；保留 20 万行 xterm scrollback 配置；不增加用户设置。

## 尚未解决的产品级差距

1. **磁盘历史与 xterm 顶部的精确衔接尚未实现**。原生 xterm 视口达到最旧一行后，历史层仍从磁盘最新记录开始，因此可能看见重复片段、滚动位置跳变。真正的无缝拼接需要一个将渲染行/会话状态映射到磁盘日志位置的索引（考虑 ANSI 控制符、自动换行、清屏、时间戳），不能通过字符串拼接假装已解决。
2. 唤醒保护目前固定 1200ms，USB 转串口驱动延迟超过该窗口时仍可能发生突发渲染。建议增加压测与自适应恢复方案，并验证不会导致持续满速打印时长期“看不到实时输出”。
3. 现有可读日志会过滤 VT 控制码，因此磁盘历史层不能精确重现颜色、备用屏、光标移动以及全屏应用状态。
4. 自动化 CI 无法代替 Windows 真机合盖、USB 重新枚举、CH340/CP210x/FTDI 及 921600 波特率整夜验证。

## 验证要求

- 隐藏/恢复必须触发 `output:resync`，且不能用 `output:reset` 执行全量滚动历史清理。
- 原有 6 Mi 隐藏缓存 + 8 Ki 近期尾部恢复测试保持通过。
- 日志 Unicode 边界的倒序读取测试通过。
- Typecheck、单测、Electron Windows 构建及 node-pty 打包检测全通过。

**结论**：修复上述确定性缺陷后，本次功能仍处于“实时无感恢复 + 可按需浏览磁盘历史”的阶段；并非已经实现精确无缝的跨介质滚动。
