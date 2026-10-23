import { fmtStamp } from './logtext'

export const DEFAULT_SCROLLBACK = 50_000
export const SCROLLBACK_OPTIONS = [10_000, 20_000, 50_000, 100_000, 200_000]
export function normalizeScrollback(value: unknown): number {
  return typeof value === 'number' && SCROLLBACK_OPTIONS.includes(value) ? value : DEFAULT_SCROLLBACK
}

export interface OutputFrame {
  text: string
  generation: string
  sequence: number
}
export interface OutputAck { generation: string; sequence: number }
export interface HistoryQuery { offset?: number; query?: string; selected?: boolean }
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

  constructor(
    readonly generation: string,
    private send: (frame: OutputFrame) => void,
    private pressure: (paused: boolean) => void,
    private overflow: () => void,
    private high = 128 * 1024,
    private limit = 2 * 1024 * 1024
  ) {}

  get pending(): number { return this.queued + this.inFlight }

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
    while (this.head < this.queue.length && this.inFlight < this.high && !this.stopped) {
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
