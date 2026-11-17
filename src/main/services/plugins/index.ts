import { app, dialog, utilityProcess } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emitToolEvent } from '../../ipc'
import type { ToolService } from '../../ipc'
import type {
  BuiltinPluginDefinition, PluginContext, PluginDescriptor, PluginExchangeOptions, PluginExchangeResult,
  PluginHoldOptions, PluginInstance, PluginLogEntry, PluginModuleInstance, PluginRuntimeStatus,
  PluginSerialBridge, PluginCatalog, PluginSerialEvent, PluginSerialLease,
  PluginSessionInfo, PluginSourceInfo, PluginWriteData, PluginWriteOptions
} from '../../../shared/plugins'
import { PluginAuthHost } from './auth'
import { applyDefaults } from './schema'
import {
  downloadSourceBundle, fetchSourceCatalog, normalizeSourceUrl, packageSources, sourceItems
} from './source'
import { PluginStore, parseJson, safePackagePath } from './store'
export type { BuiltinPluginDefinition } from '../../../shared/plugins'

export interface PluginHostProcess {
  postMessage(message: unknown): void
  on(event: string, listener: (...args: any[]) => void): unknown
  kill(): unknown
}
export interface PluginServiceOptions {
  userData?: string
  hostPath?: string
  hostFactory?: (path: string) => PluginHostProcess
  emit?: (panelId: string, type: string, payload: unknown) => void
}
type DataEvent = Extract<PluginSerialEvent, { type: 'data' }>
type PendingCall = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Runtime {
  instance: PluginInstance
  descriptor: PluginDescriptor
  session: PluginSessionInfo
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
  lease?: PluginSerialLease
  leasePromise?: Promise<PluginSerialLease>
  /** serial.exclusive：跨回调持有的串口事务。 */
  exclusive?: PluginSerialLease
  /** serial.subscribe：宿主数据流到插件进程的转发。 */
  streams: Map<string, () => void>
  secrets: string[]
  stopping?: Promise<void>
}
const AUTO_CALLBACK_TIMEOUT_MS = 30_000
/** auth.session 插件允许等待 OA 登录窗口（120 秒）与重登重试。 */
const AUTH_CALLBACK_TIMEOUT_MS = 600_000
const MAX_HOLD_BYTES = 1_048_576
const MAX_HOLD_MS = 300_000
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
  private readonly hostPath: string
  private readonly hostFactory: (path: string) => PluginHostProcess
  private readonly emitEvent: NonNullable<PluginServiceOptions['emit']>
  private readonly auth = new PluginAuthHost()
  private readonly builtins = new Map<string, BuiltinPluginDefinition>()
  private descriptors = new Map<string, PluginDescriptor>()
  private instances: PluginInstance[] = []
  private runtimes = new Map<string, Runtime>()
  private statuses = new Map<string, PluginRuntimeStatus>()
  private logs: PluginLogEntry[] = []
  private initialized?: Promise<void>
  private mutations: Promise<unknown> = Promise.resolve()
  private legacyImported = false
  private legacyMigrationError = ''
  private sourceUrl: string | undefined
  private sourceCatalog: PluginCatalog | undefined
  private sourceCheckedAt = 0
  private sourceCache: PluginSourceInfo['items'] = []
  private sourceFetch?: Promise<PluginSourceInfo>
  private sourceFetchUrl: string | undefined
  private sourceInstalling?: Promise<unknown>

  constructor(private readonly bridge: PluginSerialBridge, builtins: BuiltinPluginDefinition[] = [], options: PluginServiceOptions = {}) {
    this.store = new PluginStore(options.userData ?? app.getPath('userData'))
    this.hostPath = options.hostPath ?? join(__dirname, 'plugin-host.js')
    this.hostFactory = options.hostFactory ?? ((path) => utilityProcess.fork(path, [], { stdio: 'ignore', serviceName: 'DevKit Device Extension' }) as unknown as PluginHostProcess)
    this.emitEvent = options.emit ?? ((panelId, type, payload) => emitToolEvent('plugins', panelId, type, payload))
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
        case 'list': return { ok: true, plugins: clone([...this.descriptors.values()]) }
        case 'instance:list':
          if (!this.legacyImported) await this.mutate(() => this.importLegacy())
          return { ok: true, instances: clone(this.instances) }
        case 'legacy:retry': return { ok: await this.mutate(() => this.importLegacy()), error: this.legacyMigrationError || undefined }
        case 'status': return { ok: true, statuses: clone([...this.statuses.values()]), logs: clone(this.logs) }
        case 'instance:save': return await this.mutate(() => this.saveInstance(panelId, object(p.instance)))
        case 'instance:delete': return await this.mutate(() => this.deleteInstance(panelId, string(p.instanceId, 'instanceId')))
        case 'install': return await this.mutate(() => this.install(panelId, p.path))
        case 'remove': return await this.mutate(() => this.remove(panelId, string(p.pluginId, 'pluginId')))
        case 'source:get': return { ok: true, source: this.sourceInfo() }
        case 'source:save': return { ok: true, source: await this.saveSource(p.url), plugins: clone([...this.descriptors.values()]) }
        case 'source:clear': return { ok: true, source: await this.clearSource() }
        case 'source:refresh': return { ok: true, source: await this.refreshSource() }
        case 'source:install': return await this.installFromSource(panelId, p)
        case 'bind': return { ok: true, status: await this.mutate(() => this.bind(panelId, string(p.instanceId, 'instanceId'))) }
        case 'unbind': case 'stop': {
          const id = string(p.instanceId, 'instanceId')
          const runtime = this.runtimes.get(id)
          if (runtime && runtime.session.panelId !== panelId) throw new Error('实例绑定在其他串口，请在对应面板停止')
          if (runtime) await this.stopRuntime(runtime, 'stopped')
          return { ok: true }
        }
        case 'run': {
          // Serialize admission, not the long command: disable/stop must still cancel it.
          const launched = await this.mutate(async () => ({ task: this.run(panelId, string(p.instanceId, 'instanceId'), string(p.actionId, 'actionId'), p.args) }))
          return { ok: true, result: await launched.task }
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
      this.legacyImported = state.legacyImported
      try { this.sourceUrl = await this.store.readSourceUrl() } catch { this.sourceUrl = undefined }
      for (const descriptor of await this.store.listInstalled()) this.descriptors.set(descriptor.id, descriptor)
      for (const builtin of this.builtins.values()) this.descriptors.set(builtin.manifest.id, { ...builtin.manifest, builtin: true })
      await this.importLegacy()
    })()
  }
  private async importLegacy(): Promise<boolean> {
    // OA 解锁现在由 DevKit-Plugins 中的外部插件提供；只有安装后才迁移旧配置。
    if (this.legacyImported || !this.descriptors.has('devkit.oa-debug')) return true
    try {
      let legacy: Record<string, unknown> | undefined
      try {
        const raw = await fs.readFile(join(this.store.root, 'device-actions.json'), 'utf8')
        if (Buffer.byteLength(raw) > MAX_QUEUE_BYTES) throw new Error('旧设备动作配置超过256KiB')
        legacy = object(parseJson(raw))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const next = [...this.instances]
      if (legacy) {
        if (!Array.isArray(legacy.profiles) || legacy.profiles.length > 32) throw new Error('旧设备动作profiles无效')
        for (const rawProfile of legacy.profiles) {
          const profile = object(rawProfile)
          const profileId = string(profile.id, '旧profile.id')
          const id = 'legacy-' + profileId
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error('旧profile.id无法迁移')
          if (next.some((item) => item.id === id)) continue
          next.push({
            id, pluginId: 'devkit.oa-debug', label: (typeof profile.label === 'string' ? profile.label : profileId).slice(0,128),
            config: { deviceActions: clone(legacy), profileId }, enabled: true, autoEnabled: false, configVersion: 1
          })
        }
      }
      if (next.length > 128) throw new Error('迁移后实例超过128个')
      await this.store.writeState(next, true)
      this.instances = next
      this.legacyImported = true
      this.legacyMigrationError = ''
      return true
    } catch (error) {
      const message = '旧设备动作尚未迁移，其他插件仍可使用：' + errorMessage(error)
      if (message !== this.legacyMigrationError) {
        this.legacyMigrationError = message
        this.logs.push({ timestamp: Date.now(), instanceId: 'legacy-migration', panelId: '*', level: 'warn', message })
      }
      return false
    }
  }
  private changed(panelId: string): void { this.emitEvent(panelId, 'changed', {}) }
  private setStatus(runtime: Runtime, state: PluginRuntimeStatus['state'], error?: string): void {
    runtime.status = { ...runtime.status, state, bound: state !== 'stopped' && state !== 'error', error }
    this.statuses.set(runtime.instance.id, runtime.status)
    this.emitEvent(runtime.session.panelId, 'status', clone(runtime.status))
  }
  private redact(runtime: Runtime, text: string): string {
    let result = text
    for (const secret of runtime.secrets) if (secret) result = result.split(secret).join('[口令已隐藏]')
    return result
  }
  private log(runtime: Runtime, level: PluginLogEntry['level'], message: string, duringStop = false): void {
    if (!duringStop && (runtime.stopping || this.runtimes.get(runtime.instance.id) !== runtime)) return
    const entry: PluginLogEntry = { timestamp: Date.now(), instanceId: runtime.instance.id, panelId: runtime.session.panelId, level, message: this.redact(runtime, message).slice(0, 4096) }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    this.emitEvent(runtime.session.panelId, 'log', entry)
  }
  private check(runtime: Runtime): void {
    runtime.controller.signal.throwIfAborted()
    if (this.runtimes.get(runtime.instance.id) !== runtime || this.bridge.describe(runtime.session.panelId)?.connectionId !== runtime.session.connectionId) throw new Error('串口连接已变化，插件需要重新绑定')
  }
  /** OA 登录窗口可能等待数分钟；普通插件继续使用较短的超时以尽早发现阻塞。 */
  private callbackTimeout(runtime: Runtime): number {
    return runtime.descriptor.capabilities.includes('auth.session') ? AUTH_CALLBACK_TIMEOUT_MS : AUTO_CALLBACK_TIMEOUT_MS
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
      id, pluginId, label: string(raw.label || descriptor.name, 'label').slice(0,128), config,
      enabled: raw.enabled !== false, autoEnabled: raw.autoEnabled === true, configVersion: 1
    }
    if (instance.autoEnabled && !descriptor.autoRespond) throw new Error('插件不支持自动应答')
    const next = this.instances.filter((item) => item.id !== id).concat(instance)
    if (next.length > 128) throw new Error('最多128个插件实例')
    if (runtime && stopping) await this.stopRuntime(runtime, 'stopped')
    await this.store.writeState(next, this.legacyImported)
    this.instances = next
    if (runtime) {
      const boundPanel = runtime.session.panelId
      await this.stopRuntime(runtime, 'stopped')
      if (instance.enabled && this.bridge.describe(boundPanel)) await this.bind(boundPanel, id)
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
    await this.store.writeState(next, this.legacyImported)
    this.instances = next
    this.statuses.delete(id)
    this.changed(panelId)
    return { ok: true }
  }
  private async install(panelId: string, value: unknown): Promise<unknown> {
    let path: string
    if (value === undefined || value === '') {
      const result = await dialog.showOpenDialog({ title: '选择可信的本地插件目录', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消安装' }
      path = result.filePaths[0]
    } else path = string(value, 'path')
    const blocked = new Set(this.builtins.keys())
    for (const runtime of this.runtimes.values()) blocked.add(runtime.instance.pluginId)
    const descriptor = await this.store.install(path, blocked)
    this.descriptors.set(descriptor.id, descriptor)
    this.changed(panelId)
    return { ok: true, plugin: clone(descriptor) }
  }
  private sourceInfo(): PluginSourceInfo {
    return {
      ...(this.sourceUrl === undefined ? {} : { url: this.sourceUrl }),
      ...(this.sourceCheckedAt ? { checkedAt: this.sourceCheckedAt } : {}),
      items: clone(this.sourceCache)
    }
  }
  private installedVersions(): Map<string, string> {
    return new Map([...this.descriptors.values()].map((descriptor) => [descriptor.id, descriptor.version]))
  }
  private async saveSource(value: unknown): Promise<PluginSourceInfo> {
    if (this.sourceInstalling) throw new Error('插件源安装进行中，请稍后修改插件源')
    const url = normalizeSourceUrl(typeof value === 'string' ? value : '')
    await this.mutate(async () => {
      await this.store.writeSourceUrl(url)
      this.sourceUrl = url
      this.sourceCatalog = undefined
      this.sourceCheckedAt = 0
      this.sourceCache = []
    })
    return await this.refreshSource()
  }
  private async clearSource(): Promise<PluginSourceInfo> {
    if (this.sourceInstalling) throw new Error('插件源安装进行中，请稍后解绑')
    await this.mutate(() => this.store.writeSourceUrl(undefined))
    this.sourceUrl = undefined
    this.sourceCatalog = undefined
    this.sourceCheckedAt = 0
    this.sourceCache = []
    return this.sourceInfo()
  }
  /** 网络读取不占用 mutate 队列，绑定/停止等操作仍可立即执行。 */
  private async refreshSource(): Promise<PluginSourceInfo> {
    const url = this.sourceUrl
    if (!url) throw new Error('尚未绑定插件源')
    if (this.sourceFetch) {
      if (this.sourceFetchUrl === url) return this.sourceFetch
      // 旧地址的检查可能仍在进行；忽略其结果，再按新地址刷新。
      await this.sourceFetch.catch(() => {})
    }
    const task = (async (): Promise<PluginSourceInfo> => {
      const catalog = await fetchSourceCatalog(url)
      if (this.sourceUrl !== url) throw new Error('插件源已变更，请重新检查更新')
      this.sourceCatalog = catalog
      this.sourceCache = sourceItems(catalog, this.installedVersions())
      this.sourceCheckedAt = Date.now()
      return this.sourceInfo()
    })()
    this.sourceFetch = task
    this.sourceFetchUrl = url
    try { return await task } finally {
      if (this.sourceFetch === task) { this.sourceFetch = undefined; this.sourceFetchUrl = undefined }
    }
  }
  private async installFromSource(panelId: string, payload: Record<string, unknown>): Promise<unknown> {
    const pluginId = string(payload.pluginId, 'pluginId')
    const version = string(payload.version, 'version')
    if (this.sourceInstalling) throw new Error('已有插件源安装任务正在进行')
    const task = this.executeSourceInstall(panelId, pluginId, version)
    this.sourceInstalling = task
    try { return await task } finally { this.sourceInstalling = undefined }
  }
  private async executeSourceInstall(panelId: string, pluginId: string, version: string): Promise<unknown> {
    const url = this.sourceUrl
    if (!url) throw new Error('尚未绑定插件源')
    let entry = this.sourceCatalog?.plugins.find((item) => item.id === pluginId && item.version === version)
    if (!entry) {
      await this.refreshSource()
      entry = this.sourceCatalog?.plugins.find((item) => item.id === pluginId && item.version === version)
      if (!entry) throw new Error('插件目录中找不到该插件版本，请刷新后重试')
    }
    if (this.sourceUrl !== url) throw new Error('插件源已变更，请重新检查更新')
    const bytes = await downloadSourceBundle(packageSources(url, entry))
    const directory = join(this.store.root, 'plugins', 'downloads')
    const temp = join(directory, randomUUID() + '.json')
    try {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(temp, bytes, { mode: 0o600 })
      const result = await this.mutate(() => this.install(panelId, temp)) as { plugin?: PluginDescriptor }
      if (result.plugin) {
        this.sourceCache = this.sourceCache.map((item) => item.id === result.plugin!.id
          ? { ...item, version: result.plugin!.version, installedVersion: result.plugin!.version, updateAvailable: false }
          : item)
      }
      return { ok: true, plugin: result.plugin, source: this.sourceInfo() }
    } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  private async remove(panelId: string, id: string): Promise<unknown> {
    if (this.builtins.has(id)) throw new Error('内置插件不能卸载')
    const active = [...this.runtimes.values()].filter((runtime) => runtime.instance.pluginId === id)
    await Promise.all(active.map((runtime) => this.stopRuntime(runtime, 'stopped')))
    // Keep instances and their IDs so reinstall restores configuration and macro references.
    await this.store.remove(id)
    this.descriptors.delete(id)
    this.changed(panelId)
    return { ok: true }
  }
  private async bind(panelId: string, id: string): Promise<PluginRuntimeStatus> {
    const instance = this.instances.find((item) => item.id === id)
    if (!instance?.enabled) throw new Error('实例不存在或未启用')
    const descriptor = this.descriptors.get(instance.pluginId)
    if (!descriptor) throw new Error('实例对应的插件未安装')
    const session = this.bridge.describe(panelId)
    if (!session) throw new Error('串口未打开')
    const existing = this.runtimes.get(id)
    if (existing) {
      if (existing.session.panelId !== panelId) throw new Error('实例已绑定其他串口，请先解除绑定')
      if (existing.session.connectionId === session.connectionId) return clone(existing.status)
      await this.stopRuntime(existing, 'stopped')
    }
    const snapshot = clone(instance)
    snapshot.config = applyDefaults(snapshot.config, descriptor.configSchema)
    const runtime: Runtime = {
      instance: snapshot, descriptor, session: clone(session), controller: new AbortController(),
      status: { instanceId: id, panelId, connectionId: session.connectionId, state: 'starting', bound: true },
      unsubscribe: () => {}, builtin: this.builtins.get(descriptor.id), pending: new Map(), nextCall: 0,
      queue: [], queueBytes: 0, operation: true, ioBusy: false, draining: false, hasOnData: false,
      streams: new Map(), secrets: []
    }
    this.runtimes.set(id, runtime)
    this.setStatus(runtime, 'starting')
    runtime.unsubscribe = this.bridge.subscribe(panelId, (event) => this.receive(runtime, event), 'plugin:' + runtime.instance.id)
    try {
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
      this.log(runtime, 'info', '插件已绑定 ' + session.path)
      void this.drain(runtime)
      return clone(runtime.status)
    } catch (error) {
      await this.stopRuntime(runtime, 'error', errorMessage(error))
      throw error
    }
  }
  private context(runtime: Runtime): PluginContext {
    return {
      config: runtime.instance.config, session: runtime.session, autoEnabled: runtime.instance.autoEnabled, signal: runtime.controller.signal,
      serial: {
        write: (data, options) => this.serialWrite(runtime, data, options),
        exchange: (data, options) => this.serialExchange(runtime, data, options),
        subscribe: (listener) => {
          if (typeof listener !== 'function') throw new Error('serial.subscribe 需要函数')
          this.requireCapability(runtime, 'serial.read')
          const key = 'in-process-' + randomUUID()
          const owner = 'plugin:' + runtime.instance.id
          const unsubscribe = this.bridge.subscribe(runtime.session.panelId, (event) => {
            if (event.type !== 'data' || event.connectionId !== runtime.session.connectionId || runtime.stopping) return
            listener(event)
          }, owner)
          runtime.streams.set(key, unsubscribe)
          return () => { runtime.streams.delete(key); unsubscribe() }
        },
        acquire: () => this.serialAcquire(runtime).then((lease) => ({
          connectionId: lease.connectionId,
          write: (data, options) => this.leaseWrite(runtime, lease, data, options),
          release: async () => {
            if (runtime.exclusive === lease) this.releaseExclusive(runtime)
            else lease.release()
          }
        })),
        hold: async (options) => { this.serialHold(runtime, options) },
        releaseHold: (replay) => this.serialReleaseHold(runtime, replay === true)
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
      const level = ['debug','info','warn','error'].includes(String(message.level)) ? message.level as PluginLogEntry['level'] : 'info'
      this.log(runtime, level, String(message.message ?? ''))
    } else if (message.type === 'state') this.publishState(runtime, message.value)
    else if (message.type === 'fatal') void this.stopRuntime(runtime, 'error', String(message.error || '插件进程异常'))
  }
  private async hostRequest(runtime: Runtime, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== 'string' || !Array.isArray(message.args)) return
    try {
      this.check(runtime)
      let result: unknown = null
      switch (message.method) {
        case 'serial.write':
          result = await this.serialWrite(runtime, message.args[0] as PluginWriteData, (message.args[1] ?? {}) as PluginWriteOptions)
          break
        case 'serial.exchange':
          result = await this.serialExchange(runtime, message.args[0] as PluginWriteData, message.args[1] as PluginExchangeOptions)
          break
        case 'serial.lease.write': {
          const lease = this.exclusive(runtime)
          result = await this.leaseWrite(runtime, lease, message.args[0] as PluginWriteData, (message.args[1] ?? {}) as PluginWriteOptions)
          break
        }
        case 'serial.lease.release':
          this.releaseExclusive(runtime)
          break
        case 'serial.subscribe':
          result = this.serialSubscribe(runtime, message.args[0])
          break
        case 'serial.unsubscribe':
          this.serialUnsubscribe(runtime, message.args[0])
          break
        case 'serial.acquire': {
          const lease = await this.serialAcquire(runtime)
          result = { connectionId: lease.connectionId }
          break
        }
        case 'serial.hold':
          this.serialHold(runtime, message.args[0])
          break
        case 'serial.releaseHold':
          await this.serialReleaseHold(runtime, message.args[0] === true)
          break
        case 'auth.login':
          this.requireCapability(runtime, 'auth.session')
          await this.auth.login(message.args[0], runtime.controller.signal)
          break
        case 'auth.request':
          this.requireCapability(runtime, 'auth.session')
          result = await this.auth.request(message.args[0], runtime.controller.signal)
          break
        default:
          throw new Error('不支持的宿主API')
      }
      runtime.host?.postMessage({ type: 'response', id: message.id, ok: true, result })
    } catch (error) {
      try { runtime.host?.postMessage({ type: 'response', id: message.id, ok: false, error: this.redact(runtime, errorMessage(error)) }) } catch {}
    }
  }
  private requireCapability(runtime: Runtime, capability: string): void {
    if (!runtime.descriptor.capabilities.includes(capability)) throw new Error('插件未声明 ' + capability)
  }
  private exclusive(runtime: Runtime): PluginSerialLease {
    if (!runtime.exclusive) throw new Error('插件尚未取得串口事务')
    return runtime.exclusive
  }
  /** 取得跨回调的串口事务；同一实例重复调用返回同一租约。 */
  private async serialAcquire(runtime: Runtime): Promise<PluginSerialLease> {
    this.requireCapability(runtime, 'serial.exclusive')
    this.check(runtime)
    if (runtime.exclusive) return runtime.exclusive
    const lease = await this.bridge.acquire(runtime.session.panelId, 'plugin:' + runtime.instance.id, runtime.controller.signal)
    try {
      this.check(runtime)
      if (lease.connectionId !== runtime.session.connectionId) throw new Error('串口租约连接已变化')
    } catch (error) { lease.release(); throw error }
    runtime.exclusive = lease
    return lease
  }
  private releaseExclusive(runtime: Runtime): void {
    const lease = runtime.exclusive
    runtime.exclusive = undefined
    // Discard any input held for this owner; a stopped plugin must not replay it later.
    try { this.bridge.endHold(runtime.session.panelId, 'plugin:' + runtime.instance.id) } catch { /* the session may be closing */ }
    lease?.release()
  }
  private serialSubscribe(runtime: Runtime, value: unknown): string {
    this.requireCapability(runtime, 'serial.read')
    if (typeof value !== 'string' || !/^stream-[0-9]{1,9}$/.test(value)) throw new Error('订阅标识无效')
    if (runtime.streams.has(value)) return value
    const owner = 'plugin:' + runtime.instance.id
    const unsubscribe = this.bridge.subscribe(runtime.session.panelId, (event) => {
      if (event.type !== 'data' || event.connectionId !== runtime.session.connectionId) return
      if (runtime.stopping) return
      try { runtime.host?.postMessage({ type: 'data', stream: value, event }) } catch { /* the process may be exiting */ }
    }, owner)
    runtime.streams.set(value, unsubscribe)
    return value
  }
  private serialUnsubscribe(runtime: Runtime, value: unknown): void {
    if (typeof value !== 'string') return
    runtime.streams.get(value)?.()
    runtime.streams.delete(value)
  }
  private serialHold(runtime: Runtime, value: unknown): void {
    this.requireCapability(runtime, 'serial.exclusive')
    const options = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    const integer = (key: string, fallback: number, min: number, max: number): number => {
      const item = options[key]
      if (item === undefined) return fallback
      if (!Number.isInteger(item) || (item as number) < min || (item as number) > max) {
        throw new Error(`${key} 须为 ${min} 至 ${max} 的整数`)
      }
      return item as number
    }
    this.bridge.beginHold(runtime.session.panelId, 'plugin:' + runtime.instance.id, {
      maxBytes: integer('maxBytes', 4096, 256, MAX_HOLD_BYTES),
      maxMs: integer('maxMs', 15_000, 1000, MAX_HOLD_MS)
    })
  }
  private async serialReleaseHold(runtime: Runtime, replay: boolean): Promise<void> {
    const chunks = this.bridge.endHold(runtime.session.panelId, 'plugin:' + runtime.instance.id)
    if (!replay || !chunks.length) return
    const lease = runtime.exclusive
    if (!lease) return
    for (const chunk of chunks) {
      if (runtime.stopping) return
      await lease.write(chunk)
    }
  }
  private async ensureLease(runtime: Runtime): Promise<PluginSerialLease> {
    this.check(runtime)
    if (!runtime.operation) throw new Error('串口写入必须在run或onData回调内等待完成')
    if (!runtime.descriptor.capabilities.includes('serial.write')) throw new Error('插件未声明serial.write')
    if (runtime.exclusive) return runtime.exclusive
    if (runtime.lease) return runtime.lease
    runtime.leasePromise ??= this.bridge.acquire(runtime.session.panelId, 'plugin:' + runtime.instance.id, runtime.controller.signal)
    const lease = await runtime.leasePromise
    try {
      this.check(runtime)
      if (lease.connectionId !== runtime.session.connectionId) throw new Error('串口租约连接已变化')
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
  private async serialWrite(runtime: Runtime, data: PluginWriteData, options: PluginWriteOptions = {}): Promise<{ bytes: number }> {
    const lease = await this.ensureLease(runtime)
    return this.leaseWrite(runtime, lease, data, options)
  }
  /** 显式租约写入：不要求当前位于 run/onData 回调内，供订阅式协议流程使用。 */
  private async leaseWrite(
    runtime: Runtime, lease: PluginSerialLease, data: PluginWriteData, options: PluginWriteOptions = {}
  ): Promise<{ bytes: number }> {
    if (runtime.ioBusy) throw new Error('同一实例的串口事务须顺序await')
    runtime.ioBusy = true
    try {
      const bytes = this.bytes(runtime, data, options)
      await lease.write(bytes, { secret: options.secret })
      this.check(runtime)
      return { bytes: bytes.length }
    } finally { runtime.ioBusy = false }
  }
  private async serialExchange(runtime: Runtime, data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult> {
    if (runtime.ioBusy) throw new Error('同一实例的串口事务须顺序await')
    if (!options || typeof options.match !== 'string' || !options.match || options.match.length > 4096) throw new Error('exchange.match须为非空字符串')
    const timeoutMs = options.timeoutMs ?? 5000
    const maxBytes = options.maxBytes ?? MAX_DATA_BYTES
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new Error('exchange.timeoutMs须为10至30000')
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_QUEUE_BYTES) throw new Error('exchange.maxBytes须为1至262144')
    if (!runtime.descriptor.capabilities.includes('serial.read')) throw new Error('插件未声明serial.read')
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
        unsubscribe = this.bridge.subscribe(runtime.session.panelId, (event) => {
          if (event.connectionId !== runtime.session.connectionId) return
          if (event.type === 'closed') { finish(new Error('串口已断开')); return }
          received.push(...event.bytes); text += event.text
          if (received.length > maxBytes) { finish(new Error('设备响应超过缓冲上限')); return }
          const haystack = options.encoding === 'hex' ? Buffer.from(received).toString('hex') : text
          const needle = options.encoding === 'hex' ? options.match.replace(/\s+/g, '').toLowerCase() : options.match
          if (haystack.includes(needle)) finish(undefined, { text, bytes: received, receivedAt: event.receivedAt })
        }, 'plugin:' + runtime.instance.id)
        // Subscription is installed before write, so immediate device replies cannot be lost.
        void lease.write(bytes, { secret: options.secret }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
      })
    } finally { runtime.ioBusy = false }
  }
  private receive(runtime: Runtime, event: PluginSerialEvent): void {
    if (event.connectionId !== runtime.session.connectionId || runtime.stopping) return
    if (event.type === 'closed') { void this.stopRuntime(runtime, 'stopped', event.reason ?? '串口已断开'); return }
    if (runtime.host && runtime.streams.size) {
      for (const stream of runtime.streams.keys()) {
        try { runtime.host.postMessage({ type: 'data', stream, event }) } catch { /* the process may be exiting */ }
      }
    }
    // 订阅式插件自己处理实时数据，不进入自动应答队列；否则只订阅不实现 onData 会无限积压。
    if (!runtime.hasOnData) return
    if (!runtime.instance.autoEnabled || !runtime.descriptor.autoRespond) return
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
          else await this.callHost(runtime, 'onData', event, this.callbackTimeout(runtime))
        } finally { runtime.operation = false; this.releaseLease(runtime) }
      }
    } catch (error) {
      // Do not auto-restart: replaying device commands after a timeout may be unsafe.
      const detail = errorMessage(error)
      const seconds = Math.round(this.callbackTimeout(runtime) / 1000)
      await this.stopRuntime(runtime, 'error', detail.includes('调用超时')
        ? `自动应答回调超时（${seconds}秒），实例已安全停止；请检查插件阻塞、设备响应和协议超时后手动重新绑定`
        : detail)
    }
    finally { runtime.draining = false }
  }
  private async run(panelId: string, id: string, actionId: string, args: unknown): Promise<unknown> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.session.panelId !== panelId) throw new Error('请先将此实例绑定当前串口')
    this.check(runtime)
    if (!runtime.descriptor.actions.some((action) => action.id === actionId)) throw new Error('插件动作不存在')
    if (runtime.operation || runtime.draining) throw new Error('插件正在执行其他动作，请稍后重试')
    if (JSON.stringify(args ?? null).length > MAX_DATA_BYTES) throw new Error('动作参数过大')
    runtime.operation = true
    this.setStatus(runtime, 'running')
    try {
      // serial.exclusive 插件自行取得/释放跨回调事务；宿主不再预占串口。
      if (!runtime.builtin?.managesSerialLease && !runtime.descriptor.capabilities.includes('serial.exclusive') &&
        runtime.descriptor.capabilities.includes('serial.write')) await this.ensureLease(runtime)
      const result = runtime.plugin
        ? await runtime.plugin.run?.(actionId, args)
        : await this.callHost(runtime, 'run', { actionId, args }, this.callbackTimeout(runtime))
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
    // Set stopping synchronously before abort/dispose can fire process callbacks.
    let resolveStop!: () => void
    runtime.stopping = new Promise<void>((resolve) => { resolveStop = resolve })
    if (this.runtimes.get(runtime.instance.id) === runtime) this.runtimes.delete(runtime.instance.id)
    runtime.controller.abort(new Error(error || '插件已停止'))
    runtime.unsubscribe()
    for (const unsubscribe of runtime.streams.values()) unsubscribe()
    runtime.streams.clear()
    runtime.queue = []; runtime.queueBytes = 0
    this.releaseLease(runtime)
    this.releaseExclusive(runtime)
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
    const targets = [...this.runtimes.values()].filter((runtime) => panelId === '*' || runtime.session.panelId === panelId)
    await Promise.all(targets.map((runtime) => this.stopRuntime(runtime, 'stopped')))
  }
}