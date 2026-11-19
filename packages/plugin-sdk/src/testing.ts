import type {
  PluginContext,
  PluginExchangeOptions,
  PluginExchangeResult,
  PluginLogEntry,
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

export interface MockPluginHarness {
  ctx: PluginContext
  controller: AbortController
  writes: MockWriteRecord[]
  logs: Array<{ level: PluginLogEntry['level']; message: string }>
  states: unknown[]
  makeDataEvent(textOrBytes: string | number[], sequence?: number): Extract<StreamEvent, { type: 'data' }>
}

export interface MockContextOptions {
  config?: Record<string, unknown>
  session?: Partial<StreamSessionInfo>
  autoEnabled?: boolean
  onExchange?: (data: PluginWriteData, options: PluginExchangeOptions) => Promise<PluginExchangeResult> | PluginExchangeResult
}

/** Official zero-drift test fixture for DevKit v2 plugins. */
export function createMockPluginContext(options: MockContextOptions = {}): MockPluginHarness {
  const controller = new AbortController()
  const writes: MockWriteRecord[] = []
  const logs: Array<{ level: PluginLogEntry['level']; message: string }> = []
  const states: unknown[] = []
  const session: StreamSessionInfo = {
    panelId: options.session?.panelId ?? 'panel-test-1',
    connectionId: options.session?.connectionId ?? 'conn-test-1',
    transport: options.session?.transport ?? 'serial',
    target: options.session?.target ?? 'COM1',
    encoding: options.session?.encoding ?? 'utf8'
  }
  let seq = 0

  const ctx: PluginContext = {
    config: options.config ?? {},
    session,
    autoEnabled: options.autoEnabled ?? true,
    signal: controller.signal,
    stream: {
      async write(data, writeOptions) {
        controller.signal.throwIfAborted()
        writes.push({ data, options: writeOptions, timestamp: Date.now() })
        const bytes = typeof data === 'string'
          ? (writeOptions?.encoding === 'hex' ? Math.floor(data.replace(/\s+/g, '').length / 2) : Buffer.byteLength(data, 'utf8'))
          : data.length
        return { bytes }
      },
      async exchange(data, exchangeOptions) {
        controller.signal.throwIfAborted()
        writes.push({ data, options: exchangeOptions, timestamp: Date.now() })
        if (options.onExchange) return await options.onExchange(data, exchangeOptions)
        const text = exchangeOptions.match
        return { text, bytes: [...Buffer.from(text, 'utf8')], receivedAt: Date.now() }
      }
    },
    log(level, message) {
      logs.push({ level, message })
    },
    state(value) {
      states.push(value)
    }
  }

  return {
    ctx,
    controller,
    writes,
    logs,
    states,
    makeDataEvent(textOrBytes, sequence) {
      const bytes = typeof textOrBytes === 'string' ? [...Buffer.from(textOrBytes, 'utf8')] : [...textOrBytes]
      const text = typeof textOrBytes === 'string' ? textOrBytes : Buffer.from(bytes).toString('utf8')
      return {
        type: 'data',
        connectionId: session.connectionId,
        bytes,
        text,
        receivedAt: Date.now(),
        sequence: sequence ?? ++seq
      }
    }
  }
}
