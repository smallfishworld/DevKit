/** The only owner of serial writes. A lease covers an entire protocol transaction. */
export interface SerialTxLease {
  readonly owner: string
  write(bytes: Uint8Array): Promise<void>
  /** Synchronous acceptance, for existing streaming transfer implementations. */
  writeNow(bytes: Uint8Array, completed?: (error?: Error) => void): void
  release(): void
}

type PortWriter = (bytes: Buffer, completed: (error?: Error | null) => void) => void
interface LeaseState {
  owner: string
  released: boolean
  pending: number
  signal?: AbortSignal
  abort?: () => void
  failures: Set<(error: Error) => void>
  /** Driver callbacks, not logical cancellations, determine physical write completion. */
}
interface Waiter {
  owner: string
  signal: AbortSignal
  resolve: (lease: SerialTxLease) => void
  reject: (error: Error) => void
  abort: () => void
}

export class SerialTxBroker {
  private active?: LeaseState
  private waiters: Waiter[] = []
  private closed?: Error

  constructor(private readonly writer: PortWriter, private readonly connected: () => boolean) {}

  get busy(): boolean { return !!this.active || this.waiters.length > 0 }
  get owner(): string | undefined { return this.active?.owner }

  /** UI writes retain their synchronous accepted/error result. Port errors arrive separately. */
  writeNow(bytes: Uint8Array, completed?: (error?: Error) => void): void {
    this.check()
    if (this.busy) throw new Error('插件或文件传输正在使用此串口')
    this.dispatch(bytes, undefined, completed)
  }

  tryAcquire(owner: string, signal?: AbortSignal): SerialTxLease {
    this.check()
    signal?.throwIfAborted()
    if (this.busy) throw new Error('插件或文件传输正在使用此串口')
    return this.createLease(owner, signal)
  }

  acquire(owner: string, signal: AbortSignal): Promise<SerialTxLease> {
    try {
      this.check()
      signal.throwIfAborted()
      if (!this.busy) return Promise.resolve(this.createLease(owner, signal))
      if (this.waiters.length >= 64) throw new Error('串口事务等待队列已满')
    } catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, signal, resolve, reject, abort: () => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(this.abortReason(signal))
      } }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }

  close(reason = new Error('串口连接已变化')): void {
    if (this.closed) return
    this.closed = reason
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(reason)
    }
    if (this.active) this.cancel(this.active, reason)
  }

  private check(): void {
    if (this.closed) throw this.closed
    if (!this.connected()) throw new Error('串口连接已变化')
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('串口事务已取消')
  }

  private createLease(owner: string, signal?: AbortSignal): SerialTxLease {
    const state: LeaseState = { owner, released: false, pending: 0, signal, failures: new Set() }
    this.active = state
    state.abort = () => this.cancel(state, this.abortReason(signal!))
    signal?.addEventListener('abort', state.abort, { once: true })
    return {
      owner,
      write: (bytes) => new Promise<void>((resolve, reject) => {
        try { this.dispatch(bytes, state, (error) => error ? reject(error) : resolve()) }
        catch (error) { reject(error) }
      }),
      writeNow: (bytes, completed) => this.dispatch(bytes, state, completed),
      release: () => { state.released = true; this.releaseIfReady(state) }
    }
  }

  private dispatch(bytes: Uint8Array, state?: LeaseState, completed?: (error?: Error) => void): void {
    this.check()
    if (state && (this.active !== state || state.released)) throw new Error('串口事务已结束')
    if (!bytes.byteLength) throw new Error('发送内容为空')
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('单次串口发送超出大小限制')
    if (state) state.pending++
    let settled = false
    let driverCompleted = false
    const done = (error?: Error | null): void => {
      if (settled) return
      settled = true
      state?.failures.delete(fail)
      completed?.(error ?? undefined)
    }
    const fail = (error: Error): void => done(error)
    const driverDone = (error?: Error | null): void => {
      if (driverCompleted) return
      driverCompleted = true
      done(error)
      if (state) {
        state.pending--
        this.releaseIfReady(state)
      }
    }
    state?.failures.add(fail)
    try { this.writer(Buffer.from(bytes), driverDone) }
    catch (error) { driverDone(error instanceof Error ? error : new Error(String(error))); throw error }
  }

  private cancel(state: LeaseState, reason: Error): void {
    state.released = true
    for (const fail of [...state.failures]) fail(reason)
    this.releaseIfReady(state)
  }

  private releaseIfReady(state: LeaseState): void {
    if (this.active !== state || !state.released || state.pending !== 0) return
    if (state.abort) state.signal?.removeEventListener('abort', state.abort)
    this.active = undefined
    if (this.closed) return
    while (this.waiters.length) {
      const next = this.waiters.shift()!
      next.signal.removeEventListener('abort', next.abort)
      if (next.signal.aborted) { next.reject(this.abortReason(next.signal)); continue }
      try { this.check(); next.resolve(this.createLease(next.owner, next.signal)) }
      catch (error) { next.reject(error instanceof Error ? error : new Error(String(error))) }
      break
    }
  }
}