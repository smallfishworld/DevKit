import { app, dialog, utilityProcess } from 'electron'
import { watch as fsWatch, type FSWatcher, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { emitToolEvent } from '../../ipc'
import type { ToolService } from '../../ipc'
import type {
  BuiltinPluginDefinition, PluginContext, PluginDescriptor, PluginExchangeOptions, PluginExchangeResult,
  PluginInstance, PluginLogEntry, PluginModuleInstance, PluginRuntimeStatus, PluginWriteData, PluginWriteOptions,
  StreamEvent, StreamLease, StreamSessionBridge, StreamSessionInfo, StreamTransport
} from '../../../shared/plugins'
import { satisfiesMinVersion } from '../../../../packages/plugin-sdk/src/manifest'
import { applyDefaults } from './schema'
import { MAX_PACKAGE_BYTES, PluginStore, parseJson, safePackagePath } from './store'
import { PluginSources } from './sources'
export type { BuiltinPluginDefinition } from '../../../shared/plugins'

export interface PluginHostProcess {
  postMessage(message: unknown): void
  on(event: string, listener: (...args: any[]) => void): unknown
  kill(): unknown
}
export interface PluginServiceOptions {
  userData?: string
  hostVersion?: string
  hostPath?: string
  hostFactory?: (path: string) => PluginHostProcess
  download?: (url: string, maxBytes: number) => Promise<Buffer>
  emit?: (panelId: string, type: string, payload: unknown) => void
}
type DataEvent = Extract<StreamEvent, { type: 'data' }>
type PendingCall = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Runtime {
  instance: PluginInstance
  descriptor: PluginDescriptor
  bridge: StreamSessionBridge
  session: StreamSessionInfo
  controller: AbortController
  status: PluginRuntimeStatus
  unsubscribe: () => void
  host?: PluginHostProcess
  plugin?: PluginModuleInstance
  builtin?: BuiltinPluginDefinition
  pending: Map<string, PendingCall>
  nextCall: number
  queue: DataEvent[]
  queueBytes: number
  operation: boolean
  ioBusy: boolean
  draining: boolean
  hasOnData: boolean
  lease?: StreamLease
  leasePromise?: Promise<StreamLease>
  secrets: string[]
  stopping?: Promise<void>
}
interface DevWatcher {
  pluginId: string
  dir: string
  watcher: FSWatcher
  timer?: NodeJS.Timeout
}

const AUTO_CALLBACK_TIMEOUT_MS = 30_000
const MAX_EVENTS = 128
const MAX_QUEUE_BYTES = 256 * 1024
const MAX_LOGS = 300
const MAX_DATA_BYTES = 64 * 1024

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求须为对象')
  return value as Record<string, unknown>
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error(field + '无效')
  return value
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export class PluginService implements ToolService {
  private readonly store: PluginStore
  private readonly sources: PluginSources
  private readonly hostVersion: string
  private readonly hostPath: string
  private readonly hostFactory: (path: string) => PluginHostProcess
  private readonly emitEvent: NonNullable<PluginServiceOptions['emit']>
  private readonly bridges = new Map<StreamTransport, StreamSessionBridge>()
  private readonly builtins = new Map<string, BuiltinPluginDefinition>()
  private readonly watchers = new Map<string, DevWatcher>()
  private descriptors = new Map<string, PluginDescriptor>()
  private instances: PluginInstance[] = []
  private runtimes = new Map<string, Runtime>()
  private statuses = new Map<string, PluginRuntimeStatus>()
  private logs: PluginLogEntry[] = []
  private initialized?: Promise<void>
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(
    bridges: Partial<Record<StreamTransport, StreamSessionBridge>>,
    builtins: BuiltinPluginDefinition[] = [],
    options: PluginServiceOptions = {}
  ) {
    const userData = options.userData ?? app.getPath('userData')
    this.hostVersion = options.hostVersion ?? (typeof app?.getVersion === 'function' ? app.getVersion() : '0.1.10')
    this.store = new PluginStore(userData)
    this.sources = new PluginSources(userData, options.download, this.hostVersion)
    this.hostPath = options.hostPath ?? join(__dirname, 'plugin-host.js')
    this.hostFactory = options.hostFactory ?? ((path) => utilityProcess.fork(path, [], { stdio: 'ignore', serviceName: 'DevKit Device Extension' }) as unknown as PluginHostProcess)
    this.emitEvent = options.emit ?? ((panelId, type, payload) => emitToolEvent('plugins', panelId, type, payload))
    for (const [transport, bridge] of Object.entries(bridges) as Array<[StreamTransport, StreamSessionBridge | undefined]>) {
      if (bridge) this.bridges.set(transport, bridge)
    }
    for (const builtin of builtins) {
      if (this.builtins.has(builtin.manifest.id)) throw new Error('重复内置插件ID')
      this.builtins.set(builtin.manifest.id, builtin)
    }
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> {
    return this.execute(panelId, action, payload)
  }

  private async execute(panelId: string, action: string, payload: unknown): Promise<unknown> {
    try {
      await this.initialize()
      const p = payload === undefined || payload === null ? {} : object(payload)
      switch (action) {
        case 'snapshot': return {
          ok: true,
          hostVersion: this.hostVersion,
          plugins: clone([...this.descriptors.values()]),
          instances: clone(this.instances),
          statuses: clone([...this.statuses.values()]),
          logs: clone(this.logs)
        }
        case 'list': return { ok: true, plugins: clone([...this.descriptors.values()]) }
        case 'instance:list': return { ok: true, instances: clone(this.instances) }
        case 'status': return { ok: true, statuses: clone([...this.statuses.values()]), logs: clone(this.logs) }
        case 'instance:save': return await this.mutate(() => this.saveInstance(panelId, object(p.instance)))
        case 'instance:delete': return await this.mutate(() => this.deleteInstance(panelId, string(p.instanceId, 'instanceId')))
        case 'sources:list': return { ok: true, hostVersion: this.hostVersion, sources: await this.sources.list() }
        case 'sources:add': return await this.mutate(async () => ({ ok: true, hostVersion: this.hostVersion, sources: await this.sources.add(p.name, p.url) }))
        case 'sources:toggle': {
          if (typeof p.enabled !== 'boolean') throw new Error('启用状态无效')
          const enabled = p.enabled
          return await this.mutate(async () => ({ ok: true, hostVersion: this.hostVersion, sources: await this.sources.update(string(p.id, '扩展源'), enabled) }))
        }
        case 'sources:remove': return await this.mutate(async () => ({ ok: true, hostVersion: this.hostVersion, sources: await this.sources.update(string(p.id, '扩展源')) }))
        case 'sources:refresh': return await this.mutate(async () => ({ ok: true, hostVersion: this.hostVersion, sources: await this.sources.refresh(string(p.id, '扩展源')) }))
        case 'sources:install': return await this.mutate(() => this.installFromSource(panelId, p))
        case 'install:file': return await this.mutate(() => this.install(panelId, undefined, true))
        case 'install': return await this.mutate(() => this.install(panelId, p.path))
        case 'watch:start': return await this.mutate(() => this.startWatch(panelId, string(p.dir, 'dir')))
        case 'watch:stop': return await this.mutate(() => this.stopWatch(panelId, string(p.pluginId, 'pluginId')))
        case 'remove': return await this.mutate(() => this.remove(panelId, string(p.pluginId, 'pluginId')))
        case 'bind': {
          const transport = typeof p.transport === 'string' ? p.transport as StreamTransport : undefined
          return { ok: true, status: await this.mutate(() => this.bind(panelId, string(p.instanceId, 'instanceId'), transport)) }
        }
        case 'unbind': case 'stop': {
          const id = string(p.instanceId, 'instanceId')
          const runtime = this.runtimes.get(id)
          if (runtime && runtime.session.panelId !== panelId) throw new Error('实例绑定在其他会话，请在对应面板停止')
          if (runtime) await this.stopRuntime(runtime, 'stopped')
          return { ok: true }
        }
        case 'run': {
          const launched = await this.mutate(async () => ({ task: this.run(panelId, string(p.instanceId, 'instanceId'), string(p.actionId, 'actionId'), p.args) }))
          const result = await launched.task
          if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
            throw new Error('error' in result && typeof result.error === 'string' ? result.error : '插件动作执行失败')
          }
          return { ok: true, result }
        }
        default: throw new Error('未知插件操作：' + action)
      }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(fn)
    this.mutations = result.catch(() => {})
    return result
  }

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const state = await this.store.readState()
      this.instances = state.instances
      for (const descriptor of await this.store.listInstalled()) this.descriptors.set(descriptor.id, descriptor)
      for (const builtin of this.builtins.values()) this.descriptors.set(builtin.manifest.id, { ...builtin.manifest, builtin: true })
    })()
  }

  private resolveSession(panelId: string, preferred?: StreamTransport): { bridge: StreamSessionBridge; session: StreamSessionInfo } | undefined {
    if (preferred) {
      const bridge = this.bridges.get(preferred)
      const session = bridge?.describe(panelId)
      return bridge && session ? { bridge, session } : undefined
    }
    for (const bridge of this.bridges.values()) {
      const session = bridge.describe(panelId)
      if (session) return { bridge, session }
    }
    return undefined
  }

  private changed(panelId: string): void {
    this.emitEvent(panelId, 'changed', {})
    if (panelId !== 'plugin-catalog') this.emitEvent('plugin-catalog', 'changed', {})
  }

  private setStatus(runtime: Runtime, state: PluginRuntimeStatus['state'], error?: string): void {
    runtime.status = { ...runtime.status, state, bound: state !== 'stopped' && state !== 'error', error }
    this.statuses.set(runtime.instance.id, runtime.status)
    this.emitEvent(runtime.session.panelId, 'status', clone(runtime.status))
    this.emitEvent('plugin-catalog', 'status', clone(runtime.status))
  }

  private redact(runtime: Runtime, text: string): string {
    let result = text
    for (const secret of runtime.secrets) if (secret) result = result.split(secret).join('[口令已隐藏]')
    return result
  }

  private log(runtime: Runtime, level: PluginLogEntry['level'], message: string, duringStop = false): void {
    if (!duringStop && (runtime.stopping || this.runtimes.get(runtime.instance.id) !== runtime)) return
    const entry: PluginLogEntry = {
      timestamp: Date.now(),
      instanceId: runtime.instance.id,
      panelId: runtime.session.panelId,
      level,
      message: this.redact(runtime, message).slice(0, 4096)
    }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    this.emitEvent(runtime.session.panelId, 'log', entry)
    this.emitEvent('plugin-catalog', 'log', entry)
  }

  private check(runtime: Runtime): void {
    runtime.controller.signal.throwIfAborted()
    if (this.runtimes.get(runtime.instance.id) !== runtime ||
      runtime.bridge.describe(runtime.session.panelId)?.connectionId !== runtime.session.connectionId) {
      throw new Error('会话连接已变化，插件需要重新绑定')
    }
  }

  private async saveInstance(panelId: string, raw: Record<string, unknown>): Promise<unknown> {
    const pluginId = string(raw.pluginId, 'pluginId')
    const descriptor = this.descriptors.get(pluginId)
    if (!descriptor) throw new Error('插件未安装')
    const id = raw.id ? string(raw.id, 'id') : randomUUID()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error('实例ID无效')
    const existing = this.instances.find((item) => item.id === id)
    if (existing && existing.pluginId !== pluginId) throw new Error('不能更改已有实例的插件类型')
    const runtime = this.runtimes.get(id)
    const stopping = raw.enabled === false || (runtime?.instance.autoEnabled === true && raw.autoEnabled === false)
    if (runtime?.operation && !stopping) throw new Error('实例正在执行，请先停止或等待完成再保存')
    const config = applyDefaults(object(raw.config ?? {}), descriptor.configSchema)
    if (JSON.stringify(config).length > MAX_QUEUE_BYTES) throw new Error('实例配置超过256KiB')
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled须为boolean')
    if (raw.autoEnabled !== undefined && typeof raw.autoEnabled !== 'boolean') throw new Error('autoEnabled须为boolean')
    const instance: PluginInstance = {
      id, pluginId, label: string(raw.label || descriptor.name, 'label').slice(0, 128), config,
      enabled: raw.enabled !== false, autoEnabled: raw.autoEnabled === true, configVersion: 2
    }
    if (instance.autoEnabled && !descriptor.autoRespond) throw new Error('插件不支持自动应答')
    const next = this.instances.filter((item) => item.id !== id).concat(instance)
    if (next.length > 128) throw new Error('最多128个插件实例')
    if (runtime && stopping) await this.stopRuntime(runtime, 'stopped')
    await this.store.writeState(next, true)
    this.instances = next
    if (runtime) {
      const boundPanel = runtime.session.panelId
      const transport = runtime.session.transport
      await this.stopRuntime(runtime, 'stopped')
      if (instance.enabled && this.resolveSession(boundPanel, transport)) await this.bind(boundPanel, id, transport)
    }
    this.changed(panelId)
    return { ok: true, instance: clone(instance) }
  }

  private async deleteInstance(panelId: string, id: string): Promise<unknown> {
    const existing = this.instances.find((item) => item.id === id)
    if (!existing) throw new Error('实例不存在')
    const runtime = this.runtimes.get(id)
    if (runtime) await this.stopRuntime(runtime, 'stopped')
    const next = this.instances.filter((item) => item.id !== id)
    await this.store.writeState(next, true)
    this.instances = next
    this.statuses.delete(id)
    this.changed(panelId)
    return { ok: true }
  }

  private async installFromSource(panelId: string, request: Record<string, unknown>): Promise<unknown> {
    const bytes = await this.sources.package(string(request.sourceId, '扩展源'),
      string(request.pluginId, '插件 ID'), string(request.sha256, 'SHA-256'), MAX_PACKAGE_BYTES)
    const directory = await fs.mkdtemp(join(tmpdir(), 'devkit-plugin-'))
    try {
      const path = join(directory, 'bundle.json')
      await fs.writeFile(path, bytes, { flag: 'wx' })
      return await this.install(panelId, path)
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async install(panelId: string, value: unknown, file = false): Promise<unknown> {
    let path: string
    if (value === undefined || value === '') {
      const result = await dialog.showOpenDialog(file
        ? { title: '选择可信的 JSON 插件包', properties: ['openFile'], filters: [{ name: 'DevKit 插件包', extensions: ['json'] }] }
        : { title: '选择可信的本地插件目录', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消安装' }
      path = result.filePaths[0]
    } else path = string(value, 'path')
    const blocked = new Set(this.builtins.keys())
    for (const runtime of this.runtimes.values()) blocked.add(runtime.instance.pluginId)
    const descriptor = await this.store.install(path, blocked)
    if (descriptor.minHostVersion && !satisfiesMinVersion(this.hostVersion, descriptor.minHostVersion)) {
      await this.store.remove(descriptor.id)
      throw new Error(`插件要求 DevKit 宿主版本 >= ${descriptor.minHostVersion}（当前 ${this.hostVersion}）`)
    }
    this.descriptors.set(descriptor.id, descriptor)
    this.changed(panelId)
    return { ok: true, plugin: clone(descriptor) }
  }

  /** Dev-mode hot reload: watch a local plugin folder, reinstall and rebind active runtimes on change. */
  private async startWatch(panelId: string, dir: string): Promise<unknown> {
    const installed = await this.install(panelId, dir) as { ok: boolean; plugin?: PluginDescriptor; error?: string }
    if (!installed.ok || !installed.plugin) throw new Error(installed.error || '无法加载监听目录')
    const pluginId = installed.plugin.id
    this.closeWatcher(pluginId)
    const watcher = fsWatch(dir, { recursive: true }, () => {
      const entry = this.watchers.get(pluginId)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.mutate(() => this.reloadWatched(pluginId, dir)).catch(() => {})
      }, 250)
    })
    this.watchers.set(pluginId, { pluginId, dir, watcher })
    const descriptor = this.descriptors.get(pluginId)
    if (descriptor) descriptor.watchDir = dir
    this.changed(panelId)
    return { ok: true, plugin: clone(descriptor) }
  }

  private async reloadWatched(pluginId: string, dir: string): Promise<void> {
    const active = [...this.runtimes.values()]
      .filter((runtime) => runtime.instance.pluginId === pluginId)
      .map((runtime) => ({ instanceId: runtime.instance.id, panelId: runtime.session.panelId, transport: runtime.session.transport, runtime }))
    await Promise.all(active.map((item) => this.stopRuntime(item.runtime, 'stopped', '开发热重载')))
    const descriptor = await this.store.install(dir, new Set(this.builtins.keys()))
    descriptor.watchDir = dir
    this.descriptors.set(descriptor.id, descriptor)
    this.changed('plugin-catalog')
    for (const item of active) {
      if (this.resolveSession(item.panelId, item.transport)) {
        await this.bind(item.panelId, item.instanceId, item.transport).catch(() => {})
      }
    }
  }

  private closeWatcher(pluginId: string): void {
    const existing = this.watchers.get(pluginId)
    if (!existing) return
    if (existing.timer) clearTimeout(existing.timer)
    try { existing.watcher.close() } catch {}
    this.watchers.delete(pluginId)
    const descriptor = this.descriptors.get(pluginId)
    if (descriptor) delete descriptor.watchDir
  }

  private async stopWatch(panelId: string, pluginId: string): Promise<unknown> {
    this.closeWatcher(pluginId)
    this.changed(panelId)
    return { ok: true }
  }

  private async remove(panelId: string, id: string): Promise<unknown> {
    if (this.builtins.has(id)) throw new Error('内置插件不能卸载')
    this.closeWatcher(id)
    const active = [...this.runtimes.values()].filter((runtime) => runtime.instance.pluginId === id)
    await Promise.all(active.map((runtime) => this.stopRuntime(runtime, 'stopped')))
    await this.store.remove(id)
    this.descriptors.delete(id)
    this.changed(panelId)
    return { ok: true }
  }

  private async bind(panelId: string, id: string, preferredTransport?: StreamTransport): Promise<PluginRuntimeStatus> {
    const instance = this.instances.find((item) => item.id === id)
    if (!instance?.enabled) throw new Error('实例不存在或未启用')
    const descriptor = this.descriptors.get(instance.pluginId)
    if (!descriptor) throw new Error('实例对应的插件未安装')
    if (descriptor.minHostVersion && !satisfiesMinVersion(this.hostVersion, descriptor.minHostVersion)) {
      throw new Error(`插件要求 DevKit >= ${descriptor.minHostVersion}`)
    }
    const resolved = this.resolveSession(panelId, preferredTransport)
    if (!resolved) throw new Error('当前会话未连接')
    const { bridge, session } = resolved
    if (!descriptor.transports.includes(session.transport)) {
      throw new Error(`插件不支持 ${session.transport} 会话类型`)
    }
    const existing = this.runtimes.get(id)
    if (existing) {
      if (existing.session.panelId !== panelId) throw new Error('实例已绑定其他会话，请先解除绑定')
      if (existing.session.connectionId === session.connectionId) return clone(existing.status)
      await this.stopRuntime(existing, 'stopped')
    }
    const snapshot = clone(instance)
    snapshot.config = applyDefaults(snapshot.config, descriptor.configSchema)
    const runtime: Runtime = {
      instance: snapshot, descriptor, bridge, session: clone(session), controller: new AbortController(),
      status: { instanceId: id, panelId, transport: session.transport, connectionId: session.connectionId, state: 'starting', bound: true },
      unsubscribe: () => {}, builtin: this.builtins.get(descriptor.id), pending: new Map(), nextCall: 0,
      queue: [], queueBytes: 0, operation: true, ioBusy: false, draining: false, hasOnData: false, secrets: []
    }
    this.runtimes.set(id, runtime)
    this.setStatus(runtime, 'starting')
    try {
      runtime.unsubscribe = bridge.subscribe(panelId, (event) => this.receive(runtime, event), 'plugin:' + runtime.instance.id)
      if (runtime.builtin) {
        runtime.plugin = await runtime.builtin.activate(this.context(runtime))
        runtime.hasOnData = typeof runtime.plugin.onData === 'function'
      } else {
        const host = this.hostFactory(this.hostPath)
        runtime.host = host
        host.on('message', (message: unknown) => this.hostMessage(runtime, message))
        host.on('exit', () => { if (!runtime.stopping) void this.stopRuntime(runtime, 'error', '插件进程已退出') })
        host.on('error', (error: Error) => { if (!runtime.stopping) void this.stopRuntime(runtime, 'error', error.message) })
        const result = await this.callHost(runtime, 'activate', {
          entry: safePackagePath(descriptor.path!, descriptor.entry), config: snapshot.config, session: runtime.session, autoEnabled: snapshot.autoEnabled
        }, 10_000) as { hasOnData: boolean }
        runtime.hasOnData = result.hasOnData
      }
      this.check(runtime)
      runtime.operation = false
      this.releaseLease(runtime)
      this.setStatus(runtime, 'ready')
      this.log(runtime, 'info', `插件已绑定 [${session.transport}] ${session.target}`)
      void this.drain(runtime)
      return clone(runtime.status)
    } catch (error) {
      await this.stopRuntime(runtime, 'error', errorMessage(error))
      throw error
    }
  }

  private context(runtime: Runtime): PluginContext {
    return {
      config: runtime.instance.config,
      session: runtime.session,
      autoEnabled: runtime.instance.autoEnabled,
      signal: runtime.controller.signal,
      stream: {
        write: (data, options) => this.streamWrite(runtime, data, options),
        exchange: (data, options) => this.streamExchange(runtime, data, options)
      },
      log: (level, message) => this.log(runtime, level, message),
      state: (value) => this.publishState(runtime, value)
    }
  }

  private publishState(runtime: Runtime, value: unknown): void {
    if (runtime.stopping || this.runtimes.get(runtime.instance.id) !== runtime) return
    try {
      const text = this.redact(runtime, JSON.stringify(value) ?? 'null')
      if (text.length > 16_384) throw new Error('插件状态超过16KiB')
      runtime.status = { ...runtime.status, value: JSON.parse(text) }
      this.statuses.set(runtime.instance.id, runtime.status)
      this.emitEvent(runtime.session.panelId, 'status', clone(runtime.status))
      this.emitEvent('plugin-catalog', 'status', clone(runtime.status))
    } catch (error) { this.log(runtime, 'warn', '忽略无效插件状态：' + errorMessage(error)) }
  }

  private callHost(runtime: Runtime, method: string, input: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!runtime.host) return Promise.reject(new Error('插件进程未启动'))
    const id = 'call-' + (++runtime.nextCall)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { runtime.pending.delete(id); reject(new Error('插件调用超时：' + method)) }, timeoutMs)
      runtime.pending.set(id, { resolve, reject, timer })
      try { runtime.host!.postMessage({ type: 'call', id, method, input }) }
      catch (error) { clearTimeout(timer); runtime.pending.delete(id); reject(error as Error) }
    })
  }

  private hostMessage(runtime: Runtime, value: unknown): void {
    if (!value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    if (message.type === 'result' && typeof message.id === 'string') {
      const pending = runtime.pending.get(message.id)
      if (!pending) return
      runtime.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(this.redact(runtime, String(message.error || '插件调用失败'))))
    } else if (runtime.stopping || this.runtimes.get(runtime.instance.id) !== runtime) {
      return
    } else if (message.type === 'request') {
      void this.hostRequest(runtime, message)
    } else if (message.type === 'log') {
      const level = ['debug', 'info', 'warn', 'error'].includes(String(message.level)) ? message.level as PluginLogEntry['level'] : 'info'
      this.log(runtime, level, String(message.message ?? ''))
    } else if (message.type === 'state') this.publishState(runtime, message.value)
    else if (message.type === 'fatal') void this.stopRuntime(runtime, 'error', String(message.error || '插件进程异常'))
  }

  private async hostRequest(runtime: Runtime, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== 'string' || !Array.isArray(message.args)) return
    try {
      this.check(runtime)
      let result: unknown
      if (message.method === 'stream.write') result = await this.streamWrite(runtime, message.args[0] as PluginWriteData, (message.args[1] ?? {}) as PluginWriteOptions)
      else if (message.method === 'stream.exchange') result = await this.streamExchange(runtime, message.args[0] as PluginWriteData, message.args[1] as PluginExchangeOptions)
      else throw new Error('不支持的宿主API')
      runtime.host?.postMessage({ type: 'response', id: message.id, ok: true, result })
    } catch (error) {
      try { runtime.host?.postMessage({ type: 'response', id: message.id, ok: false, error: this.redact(runtime, errorMessage(error)) }) } catch {}
    }
  }

  private async ensureLease(runtime: Runtime): Promise<StreamLease> {
    this.check(runtime)
    if (!runtime.operation) throw new Error('流写入必须在run或onData回调内等待完成')
    if (!runtime.descriptor.capabilities.includes('stream.write')) throw new Error('插件未声明stream.write')
    if (runtime.lease) return runtime.lease
    runtime.leasePromise ??= runtime.bridge.acquire(runtime.session.panelId, 'plugin:' + runtime.instance.id, runtime.controller.signal)
    const lease = await runtime.leasePromise
    try {
      this.check(runtime)
      if (lease.connectionId !== runtime.session.connectionId) throw new Error('会话租约连接已变化')
    } catch (error) { lease.release(); throw error }
    runtime.lease = lease
    return lease
  }

  private releaseLease(runtime: Runtime): void {
    runtime.lease?.release()
    runtime.lease = undefined
    runtime.leasePromise = undefined
  }

  private bytes(runtime: Runtime, data: PluginWriteData, options: PluginWriteOptions = {}): Buffer {
    if (!options || typeof options !== 'object') throw new Error('发送选项无效')
    if (options.encoding !== undefined && options.encoding !== 'utf8' && options.encoding !== 'hex') throw new Error('encoding须为utf8或hex')
    if (options.secret !== undefined && typeof options.secret !== 'boolean') throw new Error('secret须为boolean')
    let bytes: Buffer
    if (typeof data === 'string') {
      if (options.encoding === 'hex') {
        const hex = data.replace(/\s+/g, '')
        if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('HEX内容无效')
        bytes = Buffer.from(hex, 'hex')
      } else bytes = Buffer.from(data, 'utf8')
    } else if (Array.isArray(data) && data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) bytes = Buffer.from(data)
    else throw new Error('发送数据须为字符串或字节数组')
    if (!bytes.length || bytes.length > MAX_DATA_BYTES) throw new Error('单次发送须为1至65536字节')
    if (options.secret) {
      const text = bytes.toString('utf8').trimEnd()
      if (text && !runtime.secrets.includes(text)) {
        if (runtime.secrets.length >= 64) throw new Error('秘密值数量达到上限，请重新绑定插件')
        runtime.secrets.push(text)
      }
    }
    return bytes
  }

  private async streamWrite(runtime: Runtime, data: PluginWriteData, options: PluginWriteOptions = {}): Promise<{ bytes: number }> {
    if (runtime.ioBusy) throw new Error('同一实例的流事务须顺序await')
    runtime.ioBusy = true
    try {
      const bytes = this.bytes(runtime, data, options)
      const lease = await this.ensureLease(runtime)
      await lease.write(bytes, { secret: options.secret })
      this.check(runtime)
      return { bytes: bytes.length }
    } finally { runtime.ioBusy = false }
  }

  private async streamExchange(runtime: Runtime, data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult> {
    if (runtime.ioBusy) throw new Error('同一实例的流事务须顺序await')
    if (!options || typeof options.match !== 'string' || !options.match || options.match.length > 4096) throw new Error('exchange.match须为非空字符串')
    const timeoutMs = options.timeoutMs ?? 5000
    const maxBytes = options.maxBytes ?? MAX_DATA_BYTES
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new Error('exchange.timeoutMs须为10至30000')
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_QUEUE_BYTES) throw new Error('exchange.maxBytes须为1至262144')
    if (!runtime.descriptor.capabilities.includes('stream.read')) throw new Error('插件未声明stream.read')
    runtime.ioBusy = true
    try {
      const bytes = this.bytes(runtime, data, options)
      const lease = await this.ensureLease(runtime)
      return await new Promise<PluginExchangeResult>((resolve, reject) => {
        let settled = false
        let text = ''
        const received: number[] = []
        let unsubscribe = (): void => {}
        const finish = (error?: Error, result?: PluginExchangeResult): void => {
          if (settled) return
          settled = true; clearTimeout(timer); unsubscribe()
          runtime.controller.signal.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve(result!)
        }
        const onAbort = (): void => finish(new Error('插件事务已取消'))
        const timer = setTimeout(() => finish(new Error('等待设备响应超时')), timeoutMs)
        runtime.controller.signal.addEventListener('abort', onAbort, { once: true })
        unsubscribe = runtime.bridge.subscribe(runtime.session.panelId, (event) => {
          if (event.connectionId !== runtime.session.connectionId) return
          if (event.type === 'closed') { finish(new Error('会话已断开')); return }
          received.push(...event.bytes); text += event.text
          if (received.length > maxBytes) { finish(new Error('设备响应超过缓冲上限')); return }
          const haystack = options.encoding === 'hex' ? Buffer.from(received).toString('hex') : text
          const needle = options.encoding === 'hex' ? options.match.replace(/\s+/g, '').toLowerCase() : options.match
          if (haystack.includes(needle)) finish(undefined, { text, bytes: received, receivedAt: event.receivedAt })
        }, 'plugin:' + runtime.instance.id)
        void lease.write(bytes, { secret: options.secret }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
      })
    } finally { runtime.ioBusy = false }
  }

  private receive(runtime: Runtime, event: StreamEvent): void {
    if (event.connectionId !== runtime.session.connectionId || runtime.stopping) return
    if (event.type === 'closed') { void this.stopRuntime(runtime, 'stopped', event.reason ?? '会话已断开'); return }
    if (!runtime.instance.autoEnabled || !runtime.descriptor.autoRespond || !runtime.descriptor.capabilities.includes('stream.read')) return
    runtime.queue.push(event)
    runtime.queueBytes += event.bytes.length
    if (runtime.queue.length > MAX_EVENTS || runtime.queueBytes > MAX_QUEUE_BYTES) {
      void this.stopRuntime(runtime, 'error', '自动应答处理积压超过上限，已停止插件以避免丢帧后误应答')
      return
    }
    void this.drain(runtime)
  }

  private async drain(runtime: Runtime): Promise<void> {
    if (runtime.draining || runtime.operation || !runtime.hasOnData || runtime.stopping) return
    runtime.draining = true
    try {
      while (runtime.queue.length && !runtime.stopping) {
        this.check(runtime)
        const event = runtime.queue.shift()!
        runtime.queueBytes -= event.bytes.length
        runtime.operation = true
        try {
          if (runtime.plugin) await runtime.plugin.onData?.(event)
          else await this.callHost(runtime, 'onData', event, AUTO_CALLBACK_TIMEOUT_MS)
        } finally { runtime.operation = false; this.releaseLease(runtime) }
      }
    } catch (error) {
      const detail = errorMessage(error)
      await this.stopRuntime(runtime, 'error', detail.includes('调用超时')
        ? '自动应答回调超时（30秒），实例已安全停止；请检查插件阻塞、设备响应和协议超时后手动重新绑定'
        : detail)
    } finally { runtime.draining = false }
  }

  private async run(panelId: string, id: string, actionId: string, args: unknown): Promise<unknown> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.session.panelId !== panelId) throw new Error('请先将此实例绑定当前会话')
    this.check(runtime)
    if (!runtime.descriptor.actions.some((action) => action.id === actionId)) throw new Error('插件动作不存在')
    if (runtime.operation || runtime.draining) throw new Error('插件正在执行其他动作，请稍后重试')
    if (JSON.stringify(args ?? null).length > MAX_DATA_BYTES) throw new Error('动作参数过大')
    runtime.operation = true
    this.setStatus(runtime, 'running')
    try {
      if (!runtime.builtin?.managesStreamLease && runtime.descriptor.capabilities.includes('stream.write')) await this.ensureLease(runtime)
      const result = runtime.plugin
        ? await runtime.plugin.run?.(actionId, args)
        : await this.callHost(runtime, 'run', { actionId, args }, 60_000)
      this.check(runtime)
      this.setStatus(runtime, 'ready')
      return result
    } catch (error) {
      if (!runtime.stopping) await this.stopRuntime(runtime, 'error', errorMessage(error))
      throw error
    } finally {
      runtime.operation = false
      this.releaseLease(runtime)
      if (!runtime.stopping) void this.drain(runtime)
    }
  }

  private stopRuntime(runtime: Runtime, state: 'stopped' | 'error', error?: string): Promise<void> {
    if (runtime.stopping) return runtime.stopping
    let resolveStop!: () => void
    runtime.stopping = new Promise<void>((resolve) => { resolveStop = resolve })
    if (this.runtimes.get(runtime.instance.id) === runtime) this.runtimes.delete(runtime.instance.id)
    runtime.controller.abort(new Error(error || '插件已停止'))
    runtime.unsubscribe()
    runtime.queue = []; runtime.queueBytes = 0
    this.releaseLease(runtime)
    for (const pending of runtime.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(error || '插件已停止')) }
    runtime.pending.clear()
    this.setStatus(runtime, state, error)
    if (error) this.log(runtime, state === 'error' ? 'error' : 'info', error, true)
    void (async () => {
      try {
        if (runtime.plugin?.dispose) {
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([Promise.resolve().then(() => runtime.plugin!.dispose!()), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) })])
          } finally { if (timer) clearTimeout(timer) }
        }
        if (runtime.host) {
          try {
            runtime.host.postMessage({ type: 'cancel' })
            await this.callHost(runtime, 'dispose', undefined, 1000)
          } catch {}
          try { runtime.host.kill() } catch {}
          runtime.host = undefined
        }
      } finally { resolveStop() }
    })()
    return runtime.stopping
  }

  async dispose(panelId: string): Promise<void> {
    if (panelId === '*') {
      for (const pluginId of [...this.watchers.keys()]) this.closeWatcher(pluginId)
    }
    const targets = [...this.runtimes.values()].filter((runtime) => panelId === '*' || runtime.session.panelId === panelId)
    await Promise.all(targets.map((runtime) => this.stopRuntime(runtime, 'stopped')))
  }
}
