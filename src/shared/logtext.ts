/**
 * 串口/日志文本清洗：把终端原始输出整理成适合落盘/展示的干净文本。
 * 纯函数，主进程串口自动日志与测试共用。
 */

/** 剥离 ANSI/VT100 控制序列（CSI 如 ESC[36;22m，OSC，及孤立 ESC） */
export function stripAnsi(text: string): string {
  return text
    // CSI: ESC [ params? intermediates? final( @-~ )，如 SGR 颜色码
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC/其他：ESC ] ... (BEL|ST)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // 孤立的 ESC 控制单字节（ESC ( B 等）
    .replace(/\x1b\([~\x40-\x7e]/g, '')
    // 残留的裸 ESC
    .replace(/\x1b/g, '')
}

/**
 * 归一化换行：\r+\n? 统一折叠为单个 \n（吃掉设备端 \r\r\n 之类的重复回车）。
 * 有意为之的空行（\n\n）保留；3+ 连续换行（成串空行）压缩为一个空行。
 */
export function normalizeLines(text: string): string {
  return text.replace(/\r+\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
}

/** 串口自动日志的最终清洗：先剥 ANSI，再归一换行，制表符保留为真实跳格 */
export function cleanLogBody(text: string): string {
  return normalizeLines(stripAnsi(text))
}

/**
 * 把一批原始终端输出按「完整行」切分：最后一个 \n 之前是完整行区，之后是未完行尾巴。
 * 行终止符按 \r*\n 整体消费（吃掉设备端 \r\r\n 的重复回车），因此终止符即使被
 * 16ms 批量窗口切成两半（前批结尾 '行\r\r'、后批开头 '\n'），也不会产生幻影空行——
 * 前半滞留在 carry 里，与下一批拼回完整终止符。行间的空串 = 设备真实空行，保留。
 * 调用方把 carry 存下来拼到下一批开头再切（未完行/提示符/跨批 ANSI 序列都在 carry 中）。
 */
export function splitTerminalLines(raw: string): { lines: string[]; carry: string } {
  const cut = raw.lastIndexOf('\n')
  if (cut === -1) return { lines: [], carry: raw }
  const parts = raw.slice(0, cut + 1).split(/\r*\n/)
  parts.pop() // 末尾 \n 产生的空尾元素不是空行
  return { lines: parts, carry: raw.slice(cut + 1) }
}

/** 日期戳（跨天标记用）：YYYY-MM-DD */
export function dateStamp(d = new Date()): string {
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 终端时间戳逐行补戳：把一批文本按行拆开逐行加前缀（与日志落盘同规则，每行一戳）。
 * midLine 为上一批结尾是否停在行中间（未完行/提示符后回显）——延续内容不再加戳。
 * 结尾换行是行终止符：剥掉拆行，补戳后统一补回。空行同样加戳（与落盘一致）。
 */
export function stampLines(
  text: string,
  prefix: string,
  midLine: boolean
): { out: string; midLine: boolean } {
  if (!text) return { out: '', midLine } // 空批：不补戳、状态不变
  const endsNl = text.endsWith('\n')
  const segs = (endsNl ? text.slice(0, -1) : text).split('\n')
  let out = ''
  segs.forEach((seg, i) => {
    if (i > 0) out += '\n'
    out += i === 0 && midLine ? seg : prefix + seg
  })
  if (endsNl) out += '\n'
  return { out, midLine: !endsNl }
}

/** 本地时间戳（日志行前缀与终端显示统一）：HH:MM:SS.mmm；带日期时 YYYY-MM-DD HH:MM:SS.mmm（跨天可辨） */
export function fmtStamp(t = Date.now(), withDate = false): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  return withDate ? `${dateStamp(d)} ${time}` : time
}

/** 日志文件名时间戳：以创建时刻为准，YYYYMMDD-HHMMSS（无毫秒） */
export function fileNameStamp(d = new Date()): string {
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 内存日志上限的字节数估算（JS 字符串 UTF-16，1 字符 ≈ 2 字节；文本按 2 倍体积估算保守值） */
export function estimateBytes(text: string): number {
  return text.length * 2
}