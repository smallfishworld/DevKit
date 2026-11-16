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
}
export type PluginWriteData = string | number[]
export interface PluginWriteOptions { encoding?: 'utf8' | 'hex'; secret?: boolean }
export interface PluginExchangeOptions extends PluginWriteOptions { match: string; timeoutMs?: number; maxBytes?: number }
export interface PluginExchangeResult { text: string; bytes: number[]; receivedAt: number }
export interface PluginContext {
  config: Record<string, unknown>
  session: PluginSessionInfo
  autoEnabled: boolean
  /** In-process built-ins only; external JS must clean up when dispose is called. */
  signal: AbortSignal
  serial: {
    write(data: PluginWriteData, options?: PluginWriteOptions): Promise<{ bytes: number }>
    exchange(data: PluginWriteData, options: PluginExchangeOptions): Promise<PluginExchangeResult>
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
