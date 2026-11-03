# 设计：串口接收时序与日志可信度

## 顺序约束

`SerialPort.on('data')` 同步记录 `RxPiece { buf, time: Date.now() }`。每个接收块先经持久化的 `StringDecoder` / `iconv-lite` 流式解码；批次内有文本的片段分别以其回调时间交给 `TerminalRuntime.dataTimed` 写入 `SessionHistory.append`，显示则拼为一个字符串，不提高 xterm IPC 刷新频率。

在 `SerialService.invoke('output:clear')` 中同步执行：

1. 取消本面板的 32ms 接收 flush 定时器；把已经到达 JS 回调的所有 `pending` 数据解码、写入有序异步日志队列和显示输出队列。
2. 用原来的日志 `note` 通道写入“用户清空终端显示（历史日志继续保留）”事件；其 `formatter.finish()` 明确结束未完日志行。
3. 调用 `TerminalRuntime.clearDisplay`，保存当前已入队日志字节偏移为 `displayFloor`，清理旧 `OutputWindow` 与 16 Mi 隐藏缓存并通知 xterm 清屏。异步实际写盘继续按同一 Promise 链顺序完成；历史查询 await 写盘任务。

**边界定义**：属于清屏前的是“清屏处理开始前已触发 JS data 回调”的字节；USB 硬件 FIFO 或系统排队但还没有触发回调的字节不可能被软件在此时精确归类。流式解码器内的跨清屏多字节字符不会被重置。

## 时间来源与不确定性

`RxPiece.time` 表示主进程接收回调时间，不是实际串口线上到达时刻，更不是设备产生时间。归档插入每行时间戳时使用与该行首字符对应的主机回调时间；输入在多次回调间组装跨批 Unicode 时，归属后续完整字符所在回调。在同一 32ms 窗口内多个不同时间的回调，输出仍批量渲染，但归档日志以各自回调时间入队。

`onSystemSuspend` 先冲刷旧批次，再写休眠标记；后续若收到数据则在第一次批次前标注“休眠/唤醒交界，设备产生时间不确定”。`onSystemResume` 先冲刷已到达批次，再写唤醒事件。长休眠后的 1200ms 显示保护期间，在第一批收到的数据前写入“唤醒后驱动积压；设备产生时间不确定”标记；窗口结束前冲刷未写入的块，最后写关闭标记。此机制不能恢复未进入主机的字节。

## 不变项与风险

- 仍使用每会话独立的 .log（会话名、时间、UUID），没有替换为原始字节归档。
- `SessionHistory` 4 MiB 写入积压及 `OutputWindow` 显示背压均不改变。
- 现有 UTC/本地时区取决于宿主 `fmtStamp`，日志字段格式不变。
- 必须测试 32ms 排队清屏、跨边界 UTF-8、同批不同回调时间、唤醒前后标记与日志检索。
