/** Versioned device extension SDK (API v2). External JS plugins are trusted local code. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type StreamTransport = 'serial' | 'ssh' | 'net' | 'pty'
export type PluginCapability = 'stream.read' | 'stream.write'

export interface VisibleWhenRule {
  field: string
  equals?: JsonValue
  notEquals?: JsonValue
  in?: JsonValue[]
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

export interface PluginDescriptor extends PluginManifest {
  builtin: boolean
  path?: string
  watchDir?: string
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

export interface PluginContext {
  config: Record<string, unknown>
  session: StreamSessionInfo
  autoEnabled: boolean
  signal: AbortSignal
  stream: {
    write(data: PluginWriteData, options?: PluginWriteOptions): Promise<{ bytes: number }>
    exchange(data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult>
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
