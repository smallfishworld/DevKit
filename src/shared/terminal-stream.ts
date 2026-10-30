import { fmtStamp } from './logtext'

export interface OutputFrame {
  text: string
  generation: string
  sequence: number
}
export interface OutputAck { generation: string; sequence: number }
export interface HistoryQuery { offset?: number; query?: string; selected?: boolean }
/** Backward disk-log page used by the in-terminal history viewer. */
export interface HistoryTailPage {
  rows: Array<{ offset: number; text: string }>
  before: number
  hasMore: boolean
  size: number
}
export interface HistoryTailQuery { before?: number; lines?: number }
export interface HistoryPage {
  path: string
  rows: Array<{ offset: number; text: string }>
  nextOffset: number
  size: number
  eof: boolean
}

/** Streaming ANSI removal and CR normalization. No unfinished line or escape payload is retained. */
export class LogFormatter {
  private state: 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'charset' = 'text'
  private cr = false
  private lineStart = true
  private surrogate = ''

  write(text: string, emit: (text: string) => void, now = Date.now()): void {
    text = this.surrogate + text
    this.surrogate = ''
    if (text && /[\uD800-\uDBFF]/.test(text[text.length - 1])) {
      this.surrogate = text.slice(-1)
      text = text.slice(0, -1)
    }
    let out = ''
    const put = (value: string): void => {
      if (this.lineStart) { out += `[${fmtStamp(now, true)}] `; this.lineStart = false }
      out += value
      if (value === '\r\n') this.lineStart = true
      if (out.length >= 16_384) { emit(out); out = '' }
    }
    for (const char of text) {
      if (this.state === 'osc') { if (char === '\x07') this.state = 'text'; else if (char === '\x1b') this.state = 'osc-esc'; continue }
      if (this.state === 'osc-esc') { this.state = char === '\\' || char === '\x07' ? 'text' : char === '\x1b' ? 'osc-esc' : 'osc'; continue }
      if (this.state === 'csi') { if (char >= '@' && char <= '~') this.state = 'text'; continue }
      if (this.state === 'charset') { this.state = 'text'; continue }
      if (this.state === 'esc') {
        this.state = char === '[' ? 'csi' : char === ']' || char === 'P' || char === '^' || char === '_' ? 'osc' : '()*+'.includes(char) ? 'charset' : 'text'
        continue
      }
      if (char === '\x1b') { this.state = 'esc'; continue }
      if (char === '\r') { this.cr = true; continue }
      if (this.cr) { put('\r\n'); this.cr = false; if (char === '\n') continue }
      put(char === '\n' ? '\r\n' : char)
    }
    if (out) emit(out)
  }

  finish(emit: (text: string) => void): void {
    if (this.surrogate) { this.surrogate = ''; this.write('\ufffd', emit) }
    if (this.cr || !this.lineStart) emit('\r\n')
    this.cr = false
    this.lineStart = true
    this.state = 'text'
  }
}

/** Bounded output window. Sizes are UTF-16 code units (not UTF-8 bytes). */
export class OutputWindow {
  private queue: string[] = []
  private head = 0
  private outstanding = new Map<number, number>()
  private sequence = 0
  private queued = 0
  private inFlight = 0
  private pressured = false
  private stopped = false
  private deliveryPaused = false

  constructor(
    readonly generation: string,
    private send: (frame: OutputFrame) => void,
    private pressure: (paused: boolean) => void,
    private overflow: () => void,
    private high = 128 * 1024,
    private limit = 2 * 1024 * 1024
  ) {}

  get pending(): number { return this.queued + this.inFlight }

  /** Suspend NEW frames while hidden; already-sent frames retain normal ACKs. */
  suspendDelivery(): void { this.deliveryPaused = true }
  resumeDelivery(): void {
    if (!this.deliveryPaused) return
    this.deliveryPaused = false
    this.drain()
  }

  write(text: string): void {
    if (this.stopped || !text) return
    if (this.pending + text.length > this.limit) {
      this.dispose()
      this.overflow()
      return
    }
    // Avoid splitting a UTF-16 surrogate pair across frames.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16_384, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      this.queue.push(text.slice(start, end)); start = end
    }
    this.queued += text.length
    this.drain()
  }

  ack(ack: OutputAck): void {
    if (ack?.generation !== this.generation) return
    const length = this.outstanding.get(ack.sequence)
    if (length === undefined) return
    this.outstanding.delete(ack.sequence)
    this.inFlight -= length
    this.drain()
  }

  private drain(): void {
    while (this.head < this.queue.length && this.inFlight < this.high && !this.stopped && !this.deliveryPaused) {
      const text = this.queue[this.head]
      this.queue[this.head++] = ''
      this.queued -= text.length
      this.inFlight += text.length
      const sequence = ++this.sequence
      this.outstanding.set(sequence, text.length)
      this.send({ text, generation: this.generation, sequence })
    }
    if (this.head === this.queue.length) { this.queue = []; this.head = 0 }
    else if (this.head > 256) { this.queue = this.queue.slice(this.head); this.head = 0 }
    if (!this.pressured && this.pending >= this.high) { this.pressured = true; this.pressure(true) }
    else if (this.pressured && this.pending <= this.high / 4) { this.pressured = false; this.pressure(false) }
  }

  dispose(): void {
    this.stopped = true
    this.deliveryPaused = false
    this.queue = []; this.head = 0; this.queued = 0; this.inFlight = 0
    this.outstanding.clear()
    if (this.pressured) { this.pressured = false; this.pressure(false) }
  }
}

/** Serialize connect / disconnect / dispose for each panel, including pending opens. */
export class PanelTasks {
  private tasks = new Map<string, Promise<unknown>>()
  get ids(): string[] { return [...this.tasks.keys()] }
  run<T>(id: string, work: () => Promise<T>): Promise<T> {
    const task = (this.tasks.get(id) ?? Promise.resolve()).catch(() => {}).then(work)
    this.tasks.set(id, task)
    void task.finally(() => { if (this.tasks.get(id) === task) this.tasks.delete(id) }).catch(() => {})
    return task
  }
}

/** Publish the latest counters in a burst, including its final update. */
export class ByteCounterThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null
  private rx = 0
  private tx = 0
  constructor(private publish: (rx: number, tx: number) => void, private delay = 500) {}
  update(rx: number, tx: number): void {
    this.rx = rx
    this.tx = tx
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.publish(this.rx, this.tx)
    }, this.delay)
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/**
 * Serial background cache (UTF-16 code units). Unlike xterm scrollback this is
 * strictly memory-bounded and does not require the renderer to stay active.
 * 16 Mi code units retain 32x the original 512 Ki window.
 */
export const SERIAL_BACKGROUND_CACHE_CHARS = 16 * 1024 * 1024
export const SERIAL_REPLAY_HIGH_WATER_CHARS = 128 * 1024
export const SERIAL_REPLAY_FRAME_CHARS = 16 * 1024
/** Only the most recent terminal screen context is shown on return; older output lives on disk. */
export const SERIAL_LIVE_TAIL_CHARS = 8 * 1024

/**
 * Bounded FIFO with incremental reads. O(1) amortized consumption: do not join
 * the entire backlog or hand multiple MiB to the renderer in a single write.
 * Text is retained with its original VT escape sequences for terminal replay;
 * the independent disk history remains authoritative for complete logs.
 */
export class DisplayBacklog {
  private chunks: string[] = []
  private head = 0
  private offset = 0
  private length = 0
  private dropped = 0

  constructor(readonly limit = SERIAL_BACKGROUND_CACHE_CHARS) {
    if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('invalid background cache limit')
  }

  get pending(): number { return this.length }
  get droppedChars(): number { return this.dropped }

  push(text: string): void {
    if (!text) return
    // Preserve UTF-16 surrogate pairs if the source splits them across chunks.
    const lastIndex = this.chunks.length - 1
    if (lastIndex >= this.head &&
        /[\uD800-\uDBFF]/.test(this.chunks[lastIndex].slice(-1)) &&
        /^[\uDC00-\uDFFF]/.test(text)) {
      this.chunks[lastIndex] += text[0]
      this.length++
      text = text.slice(1)
    }
    if (text) { this.chunks.push(text); this.length += text.length }
    if (this.length > this.limit) {
      this.dropPrefix(this.length - this.limit)
      this.alignToNextLine()
    }
  }

  /** Drop only the oldest text; never split a UTF-16 surrogate pair. */
  private dropPrefix(count: number): void {
    while (count > 0 && this.head < this.chunks.length) {
      const chunk = this.chunks[this.head]
      const available = chunk.length - this.offset
      let n = Math.min(available, count)
      if (n < available && n > 0 &&
        /[\uD800-\uDBFF]/.test(chunk[this.offset + n - 1]) &&
        /[\uDC00-\uDFFF]/.test(chunk[this.offset + n])) n++
      this.offset += n
      count -= n
      this.length -= n
      this.dropped += n
      if (this.offset === chunk.length) this.advanceChunk()
    }
  }

  /** Prefer a complete log line after an overflow to a partial VT command.
   * Bounded search: no extra scan beyond 4 Ki; CR-only streams retain a tail.
   */
  private alignToNextLine(): void {
    if (!this.length) return
    let scanned = 0
    let pos = this.offset
    for (let i = this.head; i < this.chunks.length && scanned < 4096; i++) {
      const chunk = this.chunks[i]
      const end = Math.min(chunk.length, pos + 4096 - scanned)
      const lf = chunk.indexOf('\n', pos)
      if (lf >= 0 && lf < end) {
        this.dropPrefix(scanned + lf - pos + 1)
        return
      }
      scanned += end - pos
      pos = 0
    }
  }

  private advanceChunk(): void {
    this.chunks[this.head++] = ''
    this.offset = 0
    if (this.head === this.chunks.length) {
      this.chunks = []
      this.head = 0
    } else if (this.head >= 256) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  /** Pop at most maxChars while leaving all later data queued in order. */
  read(maxChars: number): string {
    if (this.length === 0) return ''
    if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new RangeError('invalid replay frame size')
    const chunk = this.chunks[this.head]
    const remaining = chunk.length - this.offset
    let n = Math.min(maxChars, remaining)
    if (n < remaining &&
      /[\uD800-\uDBFF]/.test(chunk[this.offset + n - 1]) &&
      /[\uDC00-\uDFFF]/.test(chunk[this.offset + n])) n--
    if (!n) n = Math.min(2, remaining)
    const text = chunk.slice(this.offset, this.offset + n)
    this.offset += n
    this.length -= n
    if (this.offset === chunk.length) this.advanceChunk()
    return text
  }

  /**
   * Peek only the newest content. The normal resume path must NOT drain 16 Mi
   * through xterm: it discards old display history while the disk log retains it.
   * Work is O(maxChars), regardless of how long the session was hidden.
   */
  recent(maxChars = SERIAL_LIVE_TAIL_CHARS): string {
    if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new RangeError('invalid live tail limit')
    let remaining = Math.min(this.length, maxChars)
    if (!remaining) return ''
    const pieces: string[] = []
    for (let i = this.chunks.length - 1; i >= this.head && remaining; i--) {
      const begin = i === this.head ? this.offset : 0
      const chunk = this.chunks[i]
      const from = Math.max(begin, chunk.length - remaining)
      pieces.push(chunk.slice(from))
      remaining -= chunk.length - from
    }
    let text = pieces.reverse().join('')
    if (text.length > 1 && /[\uDC00-\uDFFF]/.test(text[0])) text = text.slice(1)
    // Prefer starting at a complete line, avoiding remnants of an ANSI escape.
    const firstNewline = text.indexOf('\n')
    if (this.length > maxChars && firstNewline >= 0 && firstNewline < Math.min(text.length, 2048))
      text = text.slice(firstNewline + 1)
    return text
  }

  /** Consume the number of characters evicted since the last replay warning. */
  takeDropped(): number {
    const count = this.dropped
    this.dropped = 0
    return count
  }

  /** Compatibility helper for small test cases; production replay uses read(). */
  take(): { chunks: string[]; dropped: number } {
    const result: string[] = []
    while (this.pending) result.push(this.read(SERIAL_REPLAY_FRAME_CHARS))
    return { chunks: result, dropped: this.takeDropped() }
  }
}
