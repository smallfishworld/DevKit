/**
 * 终端显示队列（纯函数，无 Vue/xterm 依赖，供 TerminalView 与单元测试共用）
 *
 * 为什么要队列：xterm 的 write 是"扔进内部 WriteBuffer 就返回"，每轮事件循环只解析
 * 12ms，未消费数据会一直堆在渲染进程内存里；堆到 50MB 时 WriteBuffer 直接 **throw**
 * （"write data discarded..."），而那个异常会打断 IPC 监听器里后续的数据处理。
 * 这里把"入队"和"真正写终端"解耦：drain 用 write 的完成回调逐块推进，
 * 在途字节永远只有一块，渲染进程内存因此有界（对标 MobaXterm 单进程同步读写、无应用层队列）。
 *
 * 满了怎么办：只丢屏幕，不丢日志——日志走主进程独立通道，完整性不受影响。
 * 丢最旧的块（保留最新内容，用户关心的是"现在"），并把丢弃字节数报给调用方做提示。
 */

export interface FlowLimits {
  /** 回落水位：一旦触发丢弃，就从队首丢到回落到该值以下（本身不触发丢弃） */
  highBytes: number
  /** 硬上限：在途字节超过它才从队首丢弃最旧的块 */
  hardBytes: number
}

/** 默认上限：超过 8MB 开始丢旧块，丢到回落到 2MB 以下
 *  （xterm 自身 50MB 才 throw，留足余量） */
export const DEFAULT_FLOW_LIMITS: FlowLimits = { highBytes: 2 * 1024 * 1024, hardBytes: 8 * 1024 * 1024 }

/** 队列在途字节（JS 字符串按 UTF-16 计，与 estimateBytes 同口径） */
export function queueBytes(queue: readonly string[]): number {
  let n = 0
  for (const q of queue) n += q.length * 2
  return n
}

/**
 * 入队新块；超硬上限时从队首丢最旧的块，回落到高水位以下为止。
 * 返回新的队列与本次丢弃的字节数（0 表示未丢弃）。空块不入队。
 */
export function pushDisplay(
  queue: readonly string[],
  chunk: string,
  lim: FlowLimits = DEFAULT_FLOW_LIMITS
): { queue: string[]; droppedBytes: number } {
  if (!chunk) return { queue: queue as string[], droppedBytes: 0 }
  const next = [...queue, chunk]
  let bytes = queueBytes(next)
  if (bytes <= lim.hardBytes) return { queue: next, droppedBytes: 0 }

  let dropped = 0
  // 至少保留刚入队的块：即使单块自身就超过硬上限，也只丢它之前的旧内容
  while (next.length > 1 && bytes > lim.highBytes) {
    const old = next.shift() as string
    dropped += old.length * 2
    bytes -= old.length * 2
  }
  return { queue: next, droppedBytes: dropped }
}

/** 丢弃提示行（灰色本地提示，与 TerminalView.info 同风格） */
export function dropNotice(droppedBytes: number): string {
  const kb = Math.max(1, Math.round(droppedBytes / 1024))
  return `\x1b[90m[DevKit] 显示落后，已跳过 ${kb} KB（日志完整）\x1b[0m\r\n`
}

/**
 * 裸 CR 洪泛判定：设备用 \r 反复覆盖同一行时（休眠失步、进度条重绘），
 * 屏幕看不到新内容，用户会误以为终端"不刷新"。
 * 同一秒内累计 ≥ threshold 个含裸 CR 的批次即判定为洪泛，用于提示一次开关。
 * 传入/返回的都是"计数状态"，调用方按批喂入。
 */
export interface BareCrWatch {
  /** 当前统计窗口的起始时刻（ms） */
  windowStart: number
  /** 本窗口内累计的含裸 CR 批次数 */
  count: number
  /** 已提示过（每会话只提示一次） */
  notified: boolean
}

export const BARE_CR_WINDOW_MS = 1000
export const BARE_CR_THRESHOLD = 20

export function newBareCrWatch(now = 0): BareCrWatch {
  return { windowStart: now, count: 0, notified: false }
}

/** 喂入一批（是否含裸 CR）与当前时刻；返回是否应弹出提示（只会返回一次 true） */
export function noteBareCr(w: BareCrWatch, hasCr: boolean, now: number): boolean {
  if (now - w.windowStart > BARE_CR_WINDOW_MS) {
    w.windowStart = now
    w.count = 0
  }
  if (!hasCr) return false
  w.count += 1
  if (w.count < BARE_CR_THRESHOLD || w.notified) return false
  w.notified = true
  return true
}
