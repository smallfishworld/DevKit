import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { LogFormatter, type HistoryPage, type HistoryQuery, type HistoryTailQuery, type HistoryTailPage } from '../../../shared/terminal-stream'

const HIGH = 256 * 1024
const MAX_PENDING = 4 * 1024 * 1024

/** One disk file per session. Only pending writes reside in memory; all writes are ordered. */
export class SessionHistory {
  private formatter = new LogFormatter()
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private pressured = false
  private accepting = true
  private failure: Error | null = null
  private closing: Promise<void> | null = null
  private readers = new Set<Promise<unknown>>()
  private committed = 0
  bytes = 0

  private constructor(
    readonly path: string,
    readonly temporary: boolean,
    private handle: FileHandle,
    private pressure: (paused: boolean) => void,
    private onError: (error: Error) => void
  ) {}

  static async create(path: string, temporary: boolean, pressure = (_: boolean): void => {}, onError = (_: Error): void => {}): Promise<SessionHistory> {
    await fs.mkdir(dirname(path), { recursive: true })
    return new SessionHistory(path, temporary, await fs.open(path, 'wx', 0o600), pressure, onError)
  }

  get pendingBytes(): number { return this.pending }

  append(text: string): void {
    if (this.accepting && !this.failure) this.formatter.write(text, (piece) => this.enqueue(piece))
  }

  note(text: string): void {
    if (!this.accepting) return
    this.formatter.finish((piece) => this.enqueue(piece))
    this.append(text + '\n')
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.onError(this.failure)
  }

  private enqueue(text: string): void {
    if (this.failure) return
    const data = Buffer.from(text, 'utf8')
    if (this.pending + data.length > MAX_PENDING) {
      this.fail(new Error('日志磁盘写入积压超过 4 MiB，已停止记录，请检查磁盘速度和剩余空间'))
      return
    }
    this.bytes += data.length // Count exactly once, independent of chunk boundaries.
    this.pending += data.length
    if (!this.pressured && this.pending >= HIGH) { this.pressured = true; this.pressure(true) }
    this.tail = this.tail.then(async () => {
      try {
        if (!this.failure) {
          await this.handle.writeFile(data)
          this.committed += data.length
        }
      } catch (error) { this.fail(error) }
      finally {
        this.pending -= data.length
        if (this.pressured && this.pending < HIGH / 4) { this.pressured = false; this.pressure(false) }
      }
    })
  }

  async flush(): Promise<void> {
    await this.tail
    if (this.failure) throw this.failure
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false
    this.formatter.finish((piece) => this.enqueue(piece))
    this.closing = this.tail.then(() => this.handle.close())
    return this.closing
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.readers.add(work)
    void work.finally(() => this.readers.delete(work)).catch(() => {})
    return work
  }

  query(request: HistoryQuery): Promise<HistoryPage> {
    return this.track((async () => {
      await this.tail
      return readHistoryPage(this.path, request, this.committed)
    })())
  }

  /** Inspect older log rows without loading earlier GBs into the renderer. */
  tailPage(request: HistoryTailQuery): Promise<HistoryTailPage> {
    return this.track((async () => {
      await this.tail
      return readHistoryTail(this.path, request, this.committed)
    })())
  }

  /** Bounded snapshot copy. Never concatenate the whole session, even when exporting GBs. */
  exportTo(target: string): Promise<void> {
    return this.track((async () => {
      if (resolve(target).toLowerCase() === resolve(this.path).toLowerCase()) throw new Error('不能覆盖正在使用的历史日志文件')
      await this.tail
      const size = this.committed
      const source = await fs.open(this.path, 'r')
      let dest: FileHandle | undefined
      try {
        dest = await fs.open(target, 'w')
        const buffer = Buffer.allocUnsafe(64 * 1024)
        for (let offset = 0; offset < size;) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
          if (!bytesRead) break
          await dest.writeFile(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
      } finally { await source.close(); await dest?.close() }
    })())
  }

  async dispose(): Promise<void> {
    await this.close()
    await Promise.allSettled([...this.readers])
    if (this.temporary) await fs.unlink(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
  }
}

/** A cursor page scans at most 1 MiB and returns at most 200 bounded records.
 * Long physical lines are split at UTF-8 boundaries; the cursor is always a byte offset. */
export async function readHistoryPage(path: string, request: HistoryQuery = {}, snapshotSize?: number): Promise<HistoryPage> {
  const handle = await fs.open(path, 'r')
  try {
    const size = Math.min((await handle.stat()).size, snapshotSize ?? Infinity)
    let offset = Math.min(size, Math.max(0, Number.isSafeInteger(request.offset) ? request.offset! : 0))
    const query = typeof request.query === 'string' ? request.query.slice(0, 1024).toLocaleLowerCase() : ''
    const rows: HistoryPage['rows'] = []
    const start = offset
    let returned = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (offset < size && offset - start < 1024 * 1024 && rows.length < 200 && returned < 256 * 1024) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset, 1024 * 1024 - (offset - start)), offset)
      if (!bytesRead) break
      let consumed = 0
      while (consumed < bytesRead && rows.length < 200 && returned < 256 * 1024) {
        const newline = buffer.indexOf(10, consumed)
        let end = newline >= consumed && newline < bytesRead ? newline + 1 : bytesRead
        end = Math.min(end, consumed + 16 * 1024)
        // Keep a partial short line for the next read, unless this is EOF.
        if (end === bytesRead && offset + end < size && end - consumed < 16 * 1024 && buffer[end - 1] !== 10) break
        if (end < bytesRead && buffer[end - 1] !== 10) {
          while (end > consumed && (buffer[end] & 0xc0) === 0x80) end--
        }
        if (end <= consumed) break
        const text = buffer.subarray(consumed, end).toString('utf8').replace(/\r?\n$/, '')
        if (!query || text.toLocaleLowerCase().includes(query)) { rows.push({ offset: offset + consumed, text }); returned += end - consumed }
        consumed = end
      }
      if (!consumed) break
      offset += consumed
    }
    return { path, rows, nextOffset: offset, size, eof: offset >= size }
  } finally { await handle.close() }
}

/**
 * Read a bounded number of physical log lines backwards. Offset cursors are
 * byte positions, stable even while the serial logger keeps appending data.
 * Each page reads <= 256 KiB; the UI requests another page only on scroll.
 */
export async function readHistoryTail(
  path: string,
  request: HistoryTailQuery = {},
  snapshotSize?: number
): Promise<HistoryTailPage> {
  const handle = await fs.open(path, 'r')
  try {
    const size = Math.min((await handle.stat()).size, snapshotSize ?? Infinity)
    const lines = Math.max(1, Math.min(200, Number.isSafeInteger(request.lines) ? request.lines! : 100))
    const end = Number.isSafeInteger(request.before) ? Math.max(0, Math.min(size, request.before!)) : size
    if (!end) return { rows: [], before: 0, hasMore: false, size }
    const parts: Buffer[] = []
    let start = end
    let newlines = 0
    while (start > 0 && end - start < 256 * 1024 && newlines <= lines + 1) {
      const n = Math.min(64 * 1024, start, 256 * 1024 - (end - start))
      const buffer = Buffer.allocUnsafe(n)
      const at = start - n
      const { bytesRead } = await handle.read(buffer, 0, n, at)
      if (!bytesRead) break
      const part = buffer.subarray(0, bytesRead)
      parts.unshift(part)
      for (const b of part) if (b === 10) newlines++
      start = at
    }
    const content = Buffer.concat(parts)
    const rows: HistoryTailPage['rows'] = []
    let pos = 0
    while (pos < content.length) {
      const lf = content.indexOf(10, pos)
      const stop = lf === -1 ? content.length : lf + 1
      // Do not display an incomplete first line when scanning starts mid-file.
      if (!(pos === 0 && start > 0)) {
        const line = content.subarray(pos, stop).toString('utf8').replace(/\r?\n$/, '')
        if (line || lf !== -1) rows.push({ offset: start + pos, text: line })
      }
      pos = stop
    }
    // A single >256KiB physical line must still allow paging backwards.
    if (rows.length === 0) {
      const text = content.toString('utf8')
      return { rows: [{ offset: start, text: '…' + text }], before: start, hasMore: start > 0, size }
    }
    const selected = rows.slice(-lines)
    const before = selected[0].offset
    return { rows: selected, before, hasMore: before > 0, size }
  } finally {
    await handle.close()
  }
}
