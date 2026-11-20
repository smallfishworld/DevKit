import type { PluginCapability, PluginManifest, StreamTransport } from './types'
import { validateSchema } from './schema'

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/
export const PLUGIN_ACTION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
export const PLUGIN_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/
export const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/

const ALLOWED_TRANSPORTS: readonly StreamTransport[] = ['serial', 'ssh', 'net', 'pty']
const ALLOWED_CAPABILITIES: readonly PluginCapability[] = ['stream.read', 'stream.write']

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('须为JSON对象')
  return value as Record<string, unknown>
}

function short(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(label + '无效')
  }
  return value
}

function fileExt(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

export function parseJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('JSON包含保留字段名')
    return value
  })
}

/** Isomorphic safe package path resolver (browser + Node) rejecting traversal and reserved names. */
export function safePackagePath(root: string, name: string): string {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
    throw new Error('插件文件路径无效')
  }
  const parts = name.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\:*?"<>|\x00-\x1f]|[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error('插件文件路径无效')
    }
  }
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '')
  return cleanRoot + sep + parts.join(sep)
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim())
    if (!match) throw new Error('无效语义版本号：' + v)
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
  }
  const [aMaj, aMin, aPat, aPre] = parse(a)
  const [bMaj, bMin, bPat, bPre] = parse(b)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  if (aPat !== bPat) return aPat - bPat
  if (aPre === bPre) return 0
  if (!aPre) return 1
  if (!bPre) return -1
  return aPre < bPre ? -1 : 1
}

export function satisfiesMinVersion(current: string, minRequired?: string): boolean {
  if (!minRequired) return true
  if (!SEMVER_PATTERN.test(current) || !SEMVER_PATTERN.test(minRequired)) return false
  return compareSemver(current, minRequired) >= 0
}

export function parseManifest(value: unknown): PluginManifest {
  const m = record(value)
  const id = short(m.id, '插件ID', 96)
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('插件ID须使用命名空间，如 company.device-tools')
  const version = short(m.version, 'version', 64)
  if (!SEMVER_PATTERN.test(version)) throw new Error('version须为语义版本号')
  if (m.apiVersion !== 2) throw new Error('插件API版本不兼容；当前要求 apiVersion 为 2')
  let minHostVersion: string | undefined
  if (m.minHostVersion !== undefined) {
    minHostVersion = short(m.minHostVersion, 'minHostVersion', 64)
    if (!SEMVER_PATTERN.test(minHostVersion)) throw new Error('minHostVersion须为语义版本号')
  }
  const entry = short(m.entry, 'entry', 200)
  safePackagePath('/plugin-root', entry)
  if (!['.js', '.cjs', '.mjs'].includes(fileExt(entry))) throw new Error('entry须为预编译JavaScript文件')
  if (!Array.isArray(m.transports) || m.transports.length === 0 ||
    m.transports.some((item) => typeof item !== 'string' || !ALLOWED_TRANSPORTS.includes(item as StreamTransport))) {
    throw new Error('transports须为非空数组，支持 serial、ssh、net、pty')
  }
  validateSchema(m.configSchema)
  if (m.configSchema.type !== 'object') throw new Error('configSchema顶层须为object')
  if (!Array.isArray(m.actions) || m.actions.length > 32) throw new Error('actions须为至多32项数组')
  const seen = new Set<string>()
  const actions = m.actions.map((raw) => {
    const action = record(raw)
    const actionId = short(action.id, 'action.id', 64)
    if (!PLUGIN_ACTION_PATTERN.test(actionId) || seen.has(actionId)) throw new Error('动作ID无效或重复')
    seen.add(actionId)
    return {
      id: actionId,
      label: short(action.label, 'action.label', 128),
      ...(action.description === undefined ? {} : { description: short(action.description, 'action.description', 1024) })
    }
  })
  if (typeof m.autoRespond !== 'boolean') throw new Error('autoRespond须为boolean')
  if (!Array.isArray(m.capabilities) ||
    m.capabilities.some((item) => typeof item !== 'string' || !ALLOWED_CAPABILITIES.includes(item as PluginCapability))) {
    throw new Error('不支持的capabilities；目前支持stream.read和stream.write')
  }
  if (m.autoRespond && !m.capabilities.includes('stream.read')) {
    throw new Error('自动应答须声明stream.read')
  }
  return {
    id,
    name: short(m.name, 'name', 128),
    version,
    apiVersion: 2,
    entry,
    ...(m.description === undefined ? {} : { description: short(m.description, 'description', 2048) }),
    ...(minHostVersion === undefined ? {} : { minHostVersion }),
    transports: [...new Set(m.transports as StreamTransport[])],
    configSchema: m.configSchema,
    actions,
    autoRespond: m.autoRespond,
    capabilities: [...new Set(m.capabilities as PluginCapability[])]
  }
}
