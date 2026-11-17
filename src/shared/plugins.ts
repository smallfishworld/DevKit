/** Versioned device extension SDK. External JS plugins are trusted local code. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface PluginConfigSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, PluginConfigSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: PluginConfigSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  [key: string]: unknown
}
export interface PluginActionDescriptor { id: string; label: string; description?: string }
export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  entry: string
  description?: string
  configSchema: PluginConfigSchema
  actions: PluginActionDescriptor[]
  autoRespond: boolean
  capabilities: string[]
}
export interface PluginDescriptor extends PluginManifest { builtin: boolean; path?: string }
export interface PluginInstance {
  id: string
  pluginId: string
  label: string
  config: Record<string, unknown>
  enabled: boolean
  autoEnabled: boolean
  configVersion: 1
}
export interface PluginRuntimeStatus {
  instanceId: string
  panelId: string
  connectionId?: string
  state: 'idle' | 'starting' | 'ready' | 'running' | 'stopped' | 'error'
  error?: string
  bound: boolean
  value?: unknown
}
export interface PluginLogEntry {
  timestamp: number
  instanceId: string
  panelId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}
/** DevKit-Plugins 仓库标准的 catalog.json；packagePath 相对索引地址解析。 */
export interface PluginCatalogEntry {
  slug: string
  id: string
  name: string
  version: string
  apiVersion: 1
  description?: string
  packagePath: string
  /** 可选：覆盖 packagePath 的绝对下载地址（Release 之外的托管方式）。 */
  packageUrl?: string
  /** 可选：插件包 SHA-256；缺省时读取同目录 SHA256SUMS。 */
  sha256?: string
}
export interface PluginCatalog {
  schemaVersion: 1
  apiVersion: 1
  plugins: PluginCatalogEntry[]
}
export interface PluginSourceItem {
  id: string
  name: string
  description?: string
  /** 目录中的最新版本 */
  version: string
  installedVersion?: string
  updateAvailable: boolean
}
export interface PluginSourceInfo {
  url?: string
  checkedAt?: number
  items: PluginSourceItem[]
}
export interface PluginSessionInfo {
  panelId: string
  connectionId: string
  path: string
  encoding: 'utf8' | 'gbk'
}
export type PluginSerialEvent =
  | { type: 'data'; connectionId: string; bytes: number[]; text: string; receivedAt: number; sequence: number }
  | { type: 'closed'; connectionId: string; reason?: string }
export interface PluginSerialLease {
  connectionId: string
  write(bytes: Uint8Array, options?: { secret?: boolean }): Promise<void>
  release(): void
}
export interface PluginSerialBridge {
  describe(panelId: string): PluginSessionInfo | undefined
  subscribe(panelId: string, listener: (event: PluginSerialEvent) => void, owner?: string): () => void
  acquire(panelId: string, owner: string, signal: AbortSignal): Promise<PluginSerialLease>
  /** 扣住终端发送；已存在同一 owner 的保持时保持不变。 */
  beginHold(panelId: string, owner: string, options: Required<PluginHoldOptions>): void
  /** 结束保持并返回扣住的原始发送；replay 由调用方通过当前租约补发。 */
  endHold(panelId: string, owner: string): Uint8Array[]
}
export type PluginWriteData = string | number[]
export interface PluginWriteOptions { encoding?: 'utf8' | 'hex'; secret?: boolean }
export interface PluginExchangeOptions extends PluginWriteOptions { match: string; timeoutMs?: number; maxBytes?: number }
export interface PluginExchangeResult { text: string; bytes: number[]; receivedAt: number }
/** 独占串口事务期间的写入句柄；必须显式 release，宿主在停止时也会释放。 */
export interface PluginSerialLeaseHandle {
  connectionId: string
  write(data: PluginWriteData, options?: PluginWriteOptions): Promise<{ bytes: number }>
  release(): Promise<void>
}
/** 自动应答期间扣住终端输入；只缓存用户发送，不再交给设备。 */
export interface PluginHoldOptions { maxBytes?: number; maxMs?: number }
export interface PluginAuthCheck { type: 'http-ok' | 'json'; url: string; field?: string }
export interface PluginAuthScope {
  /** 登录入口；业务接口必须与其同源。 */
  loginUrl: string
  /** 登录窗口允许跳转的额外来源。 */
  authOrigins?: string[]
}
export interface PluginAuthLoginOptions extends PluginAuthScope {
  check: PluginAuthCheck
  title?: string
  timeoutMs?: number
}
export interface PluginAuthRequestOptions extends PluginAuthScope {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}
export interface PluginAuthResponse { status: number; text: string }
export interface PluginContext {
  config: Record<string, unknown>
  session: PluginSessionInfo
  autoEnabled: boolean
  /** In-process built-ins only; external JS must clean up when dispose is called. */
  signal: AbortSignal
  serial: {
    write(data: PluginWriteData, options?: PluginWriteOptions): Promise<{ bytes: number }>
    exchange(data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult>
    /** 需要 serial.read：立即接收原始数据，不依赖 autoEnabled/onData 队列。 */
    subscribe(listener: (event: Extract<PluginSerialEvent, { type: 'data' }>) => void): () => void
    /** 需要 serial.exclusive：取得串口事务，其他发送来源在 release 前不得写入。 */
    acquire(): Promise<PluginSerialLeaseHandle>
    /** 需要 serial.exclusive：在授权/取码期间扣住用户输入。 */
    hold(options?: PluginHoldOptions): Promise<void>
    /** replay=true 时按原顺序补发扣住的输入；无论成功失败都会清空。 */
    releaseHold(replay: boolean): Promise<void>
  }
  /** 需要 auth.session：宿主的 OA 登录窗口与带 Cookie 的 HTTP 请求。 */
  auth?: {
    login(options: PluginAuthLoginOptions): Promise<void>
    request(options: PluginAuthRequestOptions): Promise<PluginAuthResponse>
  }
  log(level: PluginLogEntry['level'], message: string): void
  state(value: unknown): void
}
export interface PluginModuleInstance {
  run?(actionId: string, args?: unknown): Promise<unknown> | unknown
  onData?(event: Extract<PluginSerialEvent, { type: 'data' }>): Promise<void> | void
  dispose?(): Promise<void> | void
}
export interface BuiltinPluginDefinition {
  manifest: PluginManifest
  /** Legacy adapters already arbitrate the physical port. */
  managesSerialLease?: boolean
  activate(context: PluginContext): Promise<PluginModuleInstance> | PluginModuleInstance
}
