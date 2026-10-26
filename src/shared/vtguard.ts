/**
 * 串口控制台「回滚保护」：中和设备发来的、会销毁已滚出屏幕内容的 VT 序列。
 *
 * 背景（实测，见 tests/probes/erase-semantics-probe.js、hazard-neutralize-probe.js）：
 *   - `CSI 3J`（ED3，擦除回滚缓冲）：屏幕保留最后 rows 行，**之上全部永久消失，滚动也回不去**。
 *     ncurses/busybox 的 clear 常发 `ESC[H ESC[2J ESC[3J`，在 53 行输出上表现为
 *     「前半段看不见、滚动也看不见、后半段还在」——正是用户报的现象。
 *   - `ESC c`（RIS，硬复位）：清掉回滚缓冲与所有模式，历史全丢。
 *   - `?1049h/?1047h/?47h`（切备用屏）：备用屏没有回滚，进去之后主屏历史看不到；
 *     设备若在退出时不发 `?1049l`（或该序列在链路上丢了），整个后续会话都留在
 *     没有回滚的备用屏里——同样表现为「前半段看不见、滚动也看不见、后半段还在」。
 *     **但不能中和**（实测见 tests/probes/altscreen-policy-probe.js）：一旦把 `?1049h`
 *     丢掉，vi/top 的光标定位重绘就落进主屏，会把当前屏上已有的行原地覆盖掉
 *     （30 行历史只剩 7 行），比原生行为更糟。所以这里**只识别、不修改**；
 *     跨会话残留由重开串口时的 TerminalView.resetVtState() 拉回主屏
 *     （实测能保住全部回滚，见 altscreen-carryover-probe.js）。
 *
 * 日志里看不到这些序列，是因为落盘前 cleanLogBody 会剥掉全部 ANSI；
 * 所以这里不仅要中和，还要把「命中过哪种」回报给面板，让用户看见原因。
 *
 * 纯逻辑、无 xterm 依赖，供 TerminalView 与单测共用。
 */

export interface VtGuardStats {
  /** 命中的 `CSI 3J`（清回滚）次数 */
  eraseScrollback: number
  /** 命中的 `ESC c`（硬复位）次数 */
  hardReset: number
  /** 命中的备用屏切换次数（只统计，不改写：中和它反而会覆盖当前屏，见文件头） */
  altScreen: number
}

export interface VtGuardResult {
  /** 中和后的文本（可能为空串：整批都是被丢弃的序列） */
  out: string
  stats: VtGuardStats
}

/** 备用屏私用模式号：1049（保存/恢复光标）、1047、47 */
const ALT_SCREEN_MODES = new Set([1049, 1047, 47])
/** RIS 降级成「清屏 + 光标归位」：屏幕擦掉但回滚历史留着 */
const SCREEN_CLEAR = '\x1b[2J\x1b[H'

function emptyStats(): VtGuardStats {
  return { eraseScrollback: 0, hardReset: 0, altScreen: 0 }
}

/** 简单串替换计数（避免每批都跑全局正则对象的状态） */
function countOccurrences(text: string, needle: string): number {
  let n = 0
  let i = text.indexOf(needle)
  while (i !== -1) {
    n++
    i = text.indexOf(needle, i + needle.length)
  }
  return n
}

/** 滞留尾巴的长度上限：正常 CSI 参数（`?1049;1004;2004` 之类）远小于它，超长视为设备噪声 */
const MAX_CARRY = 64

/**
 * 批尾是否为「没写完的 CSI」——`ESC`、`ESC[`、`ESC[?104`、`ESC[?1004;` 等。
 * 没写完就吐给终端，下一批只能拼出半条，中和判定会漏（例如 `?1004;` + `1049h`
 * 把备用屏模式拆到两批，第一批看起来人畜无害）。
 * 判据：找到最后一个 ESC；其后若出现 CSI 的终止字节（@-~）说明序列已完整，不必滞留。
 */
function pendingTail(text: string): string {
  const esc = text.lastIndexOf('\x1b')
  if (esc === -1) return ''
  const tail = text.slice(esc)
  if (tail.length > MAX_CARRY) return ''
  if (tail.length === 1) return tail // 裸 ESC：可能是 RIS 或某个序列的开头
  if (tail[1] !== '[') return '' // ESC x：单字节终结算完整序列（ESC c / ESC ( B 等）
  // CSI 参数区：0x20-0x3F；终止字节 0x40-0x7E
  for (let i = 2; i < tail.length; i++) {
    const c = tail.charCodeAt(i)
    if (c >= 0x40 && c <= 0x7e) return '' // 已到终止字节，序列完整
  }
  return tail
}

/**
 * 逐批喂入设备数据，返回中和后的文本与命中统计。
 * 有状态：跨批被切开的序列由内部 carry 拼回，不会漏掉也不会重复输出。
 */
export class VtGuard {
  private carry = ''

  push(text: string): VtGuardResult {
    const stats = emptyStats()
    if (!text && !this.carry) return { out: '', stats }
    const src = this.carry + text
    this.carry = ''

    // 1. 硬复位 ESC c → 只清屏（先处理：它可能吞掉后面的序列，语义上等价于整屏重置）
    stats.hardReset = countOccurrences(src, '\x1bc')
    let out = stats.hardReset > 0 ? src.replace(/\x1bc/g, SCREEN_CLEAR) : src

    // 2. 清回滚 CSI 3J → 直接丢掉（同批的 CSI 2J/H 仍会清屏，观感不变，历史保住）
    stats.eraseScrollback = countOccurrences(out, '\x1b[3J')
    if (stats.eraseScrollback > 0) out = out.replace(/\x1b\[3J/g, '')

    // 3. 备用屏切换 → **只识别、不改写**（原样放行，仅用于统计与日志留痕）
    //    丢掉 ?1049h 会让全屏程序在主屏上按绝对光标重绘，把当前屏已有的行覆盖掉
    //    （实测 30 行历史只剩 7 行），比原生行为更糟；跨会话残留改由重开时 resetVtState() 处理。
    //    终端「当前是否在备用屏」不在这里跟踪——以 xterm 的 buffer.active.type 为准（权威且不受开关影响）。
    const altRe = /\x1b\[\?([0-9;]*)[hl]/g
    for (const m of out.matchAll(altRe)) {
      if (m[1].split(';').some((p) => ALT_SCREEN_MODES.has(Number(p)))) stats.altScreen += 1
    }

    // 4. 末尾可能是被批边界切开的序列：留在 carry 里等下一批拼回
    const tail = pendingTail(out)
    if (tail) {
      this.carry = tail
      out = out.slice(0, out.length - tail.length)
    }
    return { out, stats }
  }

  /** 冲掉滞留半截序列（清屏/断线/换会话时调用） */
  reset(): void {
    this.carry = ''
  }
}

/** 单批无状态版本（探针/测试便利；跨批切分场景请用 VtGuard） */
export function neutralizeVt(text: string): VtGuardResult {
  return new VtGuard().push(text)
}

/**
 * 「重开串口该发什么复位序列」——纯函数，按终端**实际**所处的屏幕决定。
 *
 * `?1049l` 只在备用屏里才发：xterm 的 DECRST 1049 会无条件调 restoreCursor()，
 * 主屏上 savedY 从未被保存（=0），光标会被倒回行 0，新会话的输出于是原地上覆回滚顶部。
 * 实测（tests/probes/normal-screen-1049l-probe.js）：15 行历史的主屏发过 `?1049l` 后，
 * 新会话写入的第一行把 `old-session line 0` 覆盖成 `Linux boot: hello0`。
 *
 * DECSTR(`ESC[!p`) 始终发：只复位模式/光标，不清回滚（vt-reset-probe.js）；
 * 但它**不能**退出备用屏（altscreen-exit-strategy-probe.js），所以备用屏里两者都要。
 */
export function reopenResetSequence(bufferType: 'normal' | 'alternate'): string {
  return (bufferType === 'alternate' ? '\x1b[?1049l' : '') + '\x1b[!p'
}
