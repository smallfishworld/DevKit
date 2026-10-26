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

/**
 * 发送（TX）审计行：把一次下发的文本翻译成"一发送 = 一日志行"的可见字面量。
 * 不经过 cleanLogBody 的换行归一——否则 `\r` 会被归一成 `\n` 再被 split 成两行空日志
 * （日志里按一次回车出现两条时间戳相同的空行）。控制符统一转字面量，屏幕/日志均无歧义。
 */
export function txAuditLine(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) {
      out += ch
      continue
    }
    if (ch === '\r') out += '<CR>'
    else if (ch === '\n') out += '<LF>'
    else if (ch === '\t') out += '<TAB>'
    else out += `<${code.toString(16).toUpperCase().padStart(2, '0')}>`
  }
  return out
}

/**
 * 批内是否存在「裸 \r」（不跟 \n 的回车）。
 * 这类回车在真实 VT 语义下只是把光标移回行首覆盖重绘，屏幕上看不到新内容——
 * 设备进入这种输出模式时（休眠失步、进度条重绘）终端看起来"不刷新"。
 * 结尾的 \r 可能是被批量窗口切开的 \r\n 前半，交给下一批判定，此处不算。
 */
export function hasBareCr(text: string): boolean {
  if (!text) return false
  // 裸 CR = 回车之后不跟换行的空转（设备原地重绘同一行）。
  // 但 `\r` 的连续段（`\r`、`\r\r`、`\r\r\n`…）是行结束符而非重绘：
  //   - `\r\r\n` 是不少设备的行结束符，splitTerminalLines 用 `\r*\n` 明确支持；
  //   - 批尾单独一串 `\r` 可能是被 32ms 批边界切开的 CRLF 前半。
  // 所以按「\r 段」判：段后是 \n（或文本结束）→ 不是裸 CR；其余 → 是。
  // 用显式循环而非正则：`\r+` 的回溯会让 `\r\r\n` 在第一个 \r 处「不跟 \n」而误判。
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\r') continue
    let j = i
    while (j < text.length && text[j] === '\r') j++
    const next = text[j] // 段后第一个字符（可能 undefined = 文本结束）
    if (next !== '\n' && next !== undefined) return true
    i = j - 1
  }
  return false
}

/** 把 \r（含 \r\n 中的 \r）视为换行：与日志归一规则对齐，供终端「裸 CR 按换行显示」模式使用 */
export function crToNewline(text: string): string {
  // 与 normalizeLines 同一条规则：\r+\n? 折叠为单个 \n（吃掉 \r\r\n 的重复回车）
  return text.replace(/\r+\n?/g, '\n')
}

/** 时长人读格式（休眠/唤醒标记与提示条共用）：<1s 用毫秒，<60s 用秒，<60m 用分，其余用小时分 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`
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