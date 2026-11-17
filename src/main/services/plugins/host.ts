/** Separate, trusted-code extension host. Does not own or open serial ports. */
import { pathToFileURL } from 'node:url'
import type { PluginContext, PluginModuleInstance, PluginSessionInfo } from '../../../shared/plugins'

type Message = Record<string, unknown>
type ParentPort = { postMessage(value: unknown): void; on(event: 'message', listener: (event: { data: Message }) => void): void }
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
function send(message: Message): void {
  if (parentPort) parentPort.postMessage(message)
  else process.send?.(message)
}
let counter = 0
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
let instance: PluginModuleInstance | undefined
const controller = new AbortController()
const streams = new Map<string, (event: unknown) => void>()
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function rpc(method: string, args: unknown[]): Promise<unknown> {
  if (controller.signal.aborted) return Promise.reject(new Error('插件已停止'))
  const id = 'rpc-' + (++counter)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ type: 'request', id, method, args })
  })
}
async function handle(message: Message): Promise<void> {
  if (message.type === 'response' && typeof message.id === 'string') {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(String(message.error || '宿主请求失败')))
    return
  }
  if (message.type === 'cancel') {
    controller.abort(new Error('插件已停止'))
    streams.clear()
    for (const request of pending.values()) request.reject(controller.signal.reason as Error)
    pending.clear()
    return
  }
  if (message.type === 'data' && typeof message.stream === 'string') {
    const handler = streams.get(message.stream)
    if (handler) handler(message.event)
    return
  }
  if (message.type !== 'call' || typeof message.id !== 'string') return
  try {
    let result: unknown
    if (message.method === 'activate') {
      if (instance) throw new Error('插件已激活')
      const input = message.input as { entry: string; config: Record<string, unknown>; session: PluginSessionInfo; autoEnabled: boolean }
      const imported = await import(pathToFileURL(input.entry).href)
      const activate = imported.activate ?? imported.default?.activate
      if (typeof activate !== 'function') throw new Error('插件入口须导出 activate(ctx)')
      const context: PluginContext = {
        config: input.config,
        session: input.session,
        autoEnabled: input.autoEnabled,
        signal: controller.signal,
        serial: {
          write: (data, options) => rpc('serial.write', [data, options ?? {}]) as ReturnType<PluginContext['serial']['write']>,
          exchange: (data, options) => rpc('serial.exchange', [data, options]) as ReturnType<PluginContext['serial']['exchange']>,
          subscribe: (listener) => {
            if (typeof listener !== 'function') throw new Error('serial.subscribe 需要函数')
            const stream = 'stream-' + (++counter)
            const handler = (value: unknown): void => {
              if (controller.signal.aborted) return
              try { listener(value as Parameters<typeof listener>[0]) }
              catch (error) { send({ type: 'log', level: 'error', message: 'data 监听回调异常：' + errorMessage(error) }) }
            }
            streams.set(stream, handler)
            void rpc('serial.subscribe', [stream]).catch((error: Error) => {
              streams.delete(stream)
              send({ type: 'log', level: 'error', message: error.message })
            })
            return () => {
              if (!streams.delete(stream)) return
              void rpc('serial.unsubscribe', [stream]).catch(() => {})
            }
          },
          acquire: async () => {
            const reply = await rpc('serial.acquire', []) as { connectionId: string }
            let released = false
            return {
              connectionId: reply.connectionId,
              write: (data, options) => rpc('serial.lease.write', [data, options ?? {}]) as ReturnType<PluginContext['serial']['write']>,
              release: async () => {
                if (released) return
                released = true
                await rpc('serial.lease.release', [])
              }
            }
          },
          hold: (options) => rpc('serial.hold', [options ?? {}]) as ReturnType<PluginContext['serial']['hold']>,
          releaseHold: (replay) => rpc('serial.releaseHold', [replay === true]) as ReturnType<PluginContext['serial']['releaseHold']>
        },
        auth: {
          login: (options) => rpc('auth.login', [options]) as ReturnType<NonNullable<PluginContext['auth']>['login']>,
          request: (options) => rpc('auth.request', [options]) as ReturnType<NonNullable<PluginContext['auth']>['request']>
        },
        log: (level, text) => send({ type: 'log', level, message: String(text).slice(0, 4096) }),
        state: (value) => send({ type: 'state', value })
      }
      instance = await activate(context)
      if (!instance || typeof instance !== 'object') throw new Error('activate须返回插件实例对象')
      result = { hasRun: typeof instance.run === 'function', hasOnData: typeof instance.onData === 'function' }
    } else if (message.method === 'run') {
      if (!instance?.run) throw new Error('插件没有实现run')
      const input = message.input as { actionId: string; args?: unknown }
      result = await instance.run(input.actionId, input.args)
    } else if (message.method === 'onData') {
      await instance?.onData?.(message.input as Parameters<NonNullable<PluginModuleInstance['onData']>>[0])
    } else if (message.method === 'dispose') {
      controller.abort(new Error('插件已停止'))
      await instance?.dispose?.()
      instance = undefined
    } else throw new Error('未知插件调用')
    send({ type: 'result', id: message.id, ok: true, result })
  } catch (error) {
    send({ type: 'result', id: message.id, ok: false, error: error instanceof Error ? error.message : '插件执行失败' })
  }
}
if (parentPort) parentPort.on('message', (event) => { void handle(event.data) })
else process.on('message', (message) => { void handle(message as Message) })
process.on('uncaughtException', (error) => {
  send({ type: 'fatal', error: error.message })
  process.exitCode = 1
  setImmediate(() => process.exit(1))
})
process.on('unhandledRejection', (error) => {
  send({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
  setImmediate(() => process.exit(1))
})
