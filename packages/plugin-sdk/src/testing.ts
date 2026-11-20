import type {
  PluginAuthLoginOptions,
  PluginAuthRequestOptions,
  PluginAuthResponse,
  PluginContext,
  PluginExchangeOptions,
  PluginExchangeResult,
  PluginHoldOptions,
  PluginLogEntry,
  PluginStreamLeaseHandle,
  PluginWriteData,
  PluginWriteOptions,
  StreamEvent,
  StreamSessionInfo
} from './types'

export interface MockWriteRecord {
  data: PluginWriteData
  options?: PluginWriteOptions
  timestamp: number
}

type DataEvent = Extract<StreamEvent, { type: 'data' }>
export interface MockPluginHarness {
  ctx: PluginContext
  controller: AbortController
  writes: MockWriteRecord[]
  logs: Array<{ level: PluginLogEntry['level']; message: string }>
  states: unknown[]
  leases: { active: boolean; acquired: number; released: number }
  holds: { active: boolean; options?: PluginHoldOptions; releases: boolean[] }
  makeDataEvent(textOrBytes: string | number[], sequence?: number): DataEvent
  emitData(textOrBytes: string | number[]): DataEvent
}

export interface MockContextOptions {
  config?: Record<string, unknown>
  session?: Partial<StreamSessionInfo>
  autoEnabled?: boolean
  onWrite?: (data: PluginWriteData, options?: PluginWriteOptions) => Promise<void> | void
  onExchange?: (data: PluginWriteData, options: PluginExchangeOptions) => Promise<PluginExchangeResult> | PluginExchangeResult
  onAuthLogin?: (options: PluginAuthLoginOptions) => Promise<void> | void
  onAuthRequest?: (options: PluginAuthRequestOptions) => Promise<PluginAuthResponse> | PluginAuthResponse
}

/** Official API-v2 protocol fixture; host integration tests still exercise the real broker and IPC. */
export function createMockPluginContext(options: MockContextOptions = {}): MockPluginHarness {
  const controller = new AbortController()
  const writes: MockWriteRecord[] = []
  const logs: Array<{ level: PluginLogEntry['level']; message: string }> = []
  const states: unknown[] = []
  const listeners = new Set<(event: DataEvent) => void>()
  const leases = { active: false, acquired: 0, released: 0 }
  const holds: MockPluginHarness['holds'] = { active: false, releases: [] }
  const session: StreamSessionInfo = {
    panelId: options.session?.panelId ?? 'panel-test-1',
    connectionId: options.session?.connectionId ?? 'conn-test-1',
    transport: options.session?.transport ?? 'serial',
    target: options.session?.target ?? 'COM1',
    encoding: options.session?.encoding ?? 'utf8'
  }
  let seq = 0
  let lease: PluginStreamLeaseHandle | undefined

  const makeDataEvent = (textOrBytes: string | number[], sequence?: number): DataEvent => {
    const bytes = typeof textOrBytes === 'string' ? [...Buffer.from(textOrBytes, 'utf8')] : [...textOrBytes]
    return {
      type: 'data', connectionId: session.connectionId, bytes,
      text: typeof textOrBytes === 'string' ? textOrBytes : Buffer.from(bytes).toString('utf8'),
      receivedAt: Date.now(), sequence: sequence ?? ++seq
    }
  }
  const write = async (data: PluginWriteData, writeOptions?: PluginWriteOptions): Promise<{ bytes: number }> => {
    controller.signal.throwIfAborted()
    writes.push({ data, options: writeOptions, timestamp: Date.now() })
    await options.onWrite?.(data, writeOptions)
    controller.signal.throwIfAborted()
    const bytes = typeof data === 'string'
      ? (writeOptions?.encoding === 'hex' ? Math.floor(data.replace(/\s+/g, '').length / 2) : Buffer.byteLength(data, 'utf8'))
      : data.length
    return { bytes }
  }
  const release = async (): Promise<void> => {
    if (!leases.active) return
    leases.active = false
    leases.released++
    lease = undefined
    holds.active = false
  }
  controller.signal.addEventListener('abort', () => {
    listeners.clear()
    void release()
    holds.active = false
  }, { once: true })

  const ctx: PluginContext = {
    config: options.config ?? {},
    session,
    autoEnabled: options.autoEnabled ?? true,
    signal: controller.signal,
    stream: {
      write,
      async exchange(data, exchangeOptions) {
        await write(data, exchangeOptions)
        if (options.onExchange) return await options.onExchange(data, exchangeOptions)
        const text = exchangeOptions.match
        return { text, bytes: [...Buffer.from(text, 'utf8')], receivedAt: Date.now() }
      },
      subscribe(listener) {
        controller.signal.throwIfAborted()
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async acquire() {
        controller.signal.throwIfAborted()
        if (lease) return lease
        leases.active = true
        leases.acquired++
        let released = false
        lease = {
          connectionId: session.connectionId,
          async write(data, writeOptions) {
            if (released) throw new Error('流事务已结束')
            return write(data, writeOptions)
          },
          async release() {
            if (released) return
            released = true
            await release()
          }
        }
        return lease
      },
      async hold(holdOptions) {
        controller.signal.throwIfAborted()
        if (session.transport !== 'serial') throw new Error('当前会话不支持输入保持')
        holds.active = true
        holds.options = holdOptions
      },
      async releaseHold(replay) {
        controller.signal.throwIfAborted()
        if (session.transport !== 'serial') throw new Error('当前会话不支持输入保持')
        holds.releases.push(replay)
        holds.active = false
      }
    },
    auth: {
      async login(input) {
        controller.signal.throwIfAborted()
        if (!options.onAuthLogin) throw new Error('未配置 auth.login 测试响应')
        await options.onAuthLogin(input)
        controller.signal.throwIfAborted()
      },
      async request(input) {
        controller.signal.throwIfAborted()
        if (!options.onAuthRequest) throw new Error('未配置 auth.request 测试响应')
        const result = await options.onAuthRequest(input)
        controller.signal.throwIfAborted()
        return result
      }
    },
    log(level, message) { logs.push({ level, message }) },
    state(value) { states.push(value) }
  }

  return {
    ctx, controller, writes, logs, states, leases, holds, makeDataEvent,
    emitData(textOrBytes) {
      const event = makeDataEvent(textOrBytes)
      for (const listener of [...listeners]) listener(event)
      return event
    }
  }
}
