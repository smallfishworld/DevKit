/** Versioned device extension SDK (API v2). External JS plugins are trusted local code. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type StreamTransport = 'serial' | 'ssh' | 'net' | 'pty'
export type PluginCapability = 'stream.read' | 'stream.write' | 'stream.exclusive' | 'auth.session'

export interface VisibleWhenRule {
  field: string
  equals?: unknown
  notEquals?: unknown
  in?: unknown[]
}

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
  'x-visibleWhen'?: VisibleWhenRule
  [key: string]: unknown
}

export interface PluginActionDescriptor {
  id: string
  label: string
  description?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 2
  entry: string
  description?: string
  minHostVersion?: string
  transports: StreamTransport[]
  configSchema: PluginConfigSchema
  actions: PluginActionDescriptor[]
  autoRespond: boolean
  capabilities: PluginCapability[]
}

export interface PluginInstallSource {
  name: string
  url: string
}

export interface PluginDescriptor extends PluginManifest {
  builtin: boolean
  path?: string
  watchDir?: string
  installSource?: PluginInstallSource
}

export interface PluginInstance {
  id: string
  pluginId: string
  label: string
  config: Record<string, unknown>
  enabled: boolean
  autoEnabled: boolean
  configVersion: 2
}

export interface PluginRuntimeStatus {
  instanceId: string
  panelId: string
  transport?: StreamTransport
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

export interface StreamSessionInfo {
  panelId: string
  connectionId: string
  transport: StreamTransport
  target: string
  encoding: 'utf8' | 'gbk'
}

export type StreamEvent =
  | { type: 'data'; connectionId: string; bytes: number[]; text: string; receivedAt: number; sequence: number }
  | { type: 'closed'; connectionId: string; reason?: string }

export interface StreamLease {
  connectionId: string
  write(bytes: Uint8Array, options?: { secret?: boolean }): Promise<void>
  release(): void
}

export interface StreamSessionBridge {
  readonly transport: StreamTransport
  describe(panelId: string): StreamSessionInfo | undefined
  subscribe(panelId: string, listener: (event: StreamEvent) => void, owner?: string): () => void
  acquire(panelId: string, owner: string, signal: AbortSignal): Promise<StreamLease>
  /** Optional terminal-input hold; currently implemented by serial sessions. */
  beginHold?(panelId: string, owner: string, options: Required<PluginHoldOptions>): void
  endHold?(panelId: string, owner: string): Uint8Array[]
}

export type PluginWriteData = string | number[]
export interface PluginWriteOptions {
  encoding?: 'utf8' | 'hex'
  secret?: boolean
}
export interface PluginExchangeOptions extends PluginWriteOptions {
  match: string
  timeoutMs?: number
  maxBytes?: number
}
export interface PluginExchangeResult {
  text: string
  bytes: number[]
  receivedAt: number
}

/** 独占流事务期间的写入句柄；必须显式 release，宿主在停止时也会释放。 */
export interface PluginStreamLeaseHandle {
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
  session: StreamSessionInfo
  autoEnabled: boolean
  signal: AbortSignal
  stream: {
    write(data: PluginWriteData, options?: PluginWriteOptions): Promise<{ bytes: number }>
    exchange(data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult>
    /** Immediate RX subscription; install before sending a protocol request. */
    subscribe(listener: (event: Extract<StreamEvent, { type: 'data' }>) => void): () => void
    /** Explicit transaction may span callbacks; release it after the protocol completes. */
    acquire(): Promise<PluginStreamLeaseHandle>
    /** Serial sessions only: temporarily buffer terminal input. */
    hold(options?: PluginHoldOptions): Promise<void>
    releaseHold(replay: boolean): Promise<void>
  }
  auth?: {
    login(options: PluginAuthLoginOptions): Promise<void>
    request(options: PluginAuthRequestOptions): Promise<PluginAuthResponse>
  }
  log(level: PluginLogEntry['level'], message: string): void
  state(value: unknown): void
}

export interface PluginModuleInstance {
  run?(actionId: string, args?: unknown): Promise<unknown> | unknown
  onData?(event: Extract<StreamEvent, { type: 'data' }>): Promise<void> | void
  dispose?(): Promise<void> | void
}

export interface BuiltinPluginDefinition {
  manifest: PluginManifest
  managesStreamLease?: boolean
  activate(context: PluginContext): Promise<PluginModuleInstance> | PluginModuleInstance
}

export interface PluginSourceEntry {
  id: string
  name: string
  version: string
  url: string
  sha256: string
  apiVersion: 2
  transports?: StreamTransport[]
  minHostVersion?: string
  deprecated?: string
  yanked?: boolean
}

export interface PluginSource {
  id: string
  name: string
  url: string
  enabled: boolean
  official?: boolean
  entries: PluginSourceEntry[]
  refreshedAt?: number
}
