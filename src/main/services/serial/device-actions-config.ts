export const DEVICE_ACTIONS_CONFIG_FILE = 'device-actions.json'

/** 设备动作类型：目前支持「挑战应答」（发命令 → 读挑战码 → 换口令 → 验证结果）。
 *  新增同类动作只需在配置里加条目；新增异类流程在这里扩展 kind 后实现对应执行器。 */
export type DeviceActionKind = 'challenge-response'

export interface DeviceActionProfile {
  id: string
  label: string
  /** 显示在步骤选择器里的动作名（如「解锁 Debug」），让一类流程服务多个动作场景 */
  actionLabel: string
  kind: DeviceActionKind
  /** challenge-response：发往设备的起始命令 */
  command: string
  newline: 'cr' | 'lf' | 'crlf'
  challengePrefix: string
  successLine: string
  failureLine: string
  challengeTimeoutMs: number
  challengeTtlMs: number
  resultTimeoutMs: number
}

export interface DeviceActionsConfig {
  loginUrl: string
  statusUrl: string
  issueUrl: string
  authOrigins: string[]
  challengeField: string
  responseField: string
  profiles: DeviceActionProfile[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应为 JSON 对象')
  return value as Record<string, unknown>
}

function field(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 缺失或格式无效`)
  }
  return value.trim()
}

function urlField(value: unknown, label: string, allowLoopback: boolean): URL {
  let url: URL
  try { url = new URL(field(value, label, 2048)) } catch { throw new Error(`${label} 不是有效地址`) }
  const loopback = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error(`${label} 必须是有效的 HTTPS 地址`)
  }
  return url
}

function timeout(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error(`${label} 须为 100 至 300000 毫秒`)
  }
  return value
}

export function parseDeviceActionsConfig(value: unknown, allowLoopback = false): DeviceActionsConfig {
  const cfg = record(value)
  const login = urlField(cfg.loginUrl, 'loginUrl', allowLoopback)
  const status = urlField(cfg.statusUrl, 'statusUrl', allowLoopback)
  const issue = urlField(cfg.issueUrl, 'issueUrl', allowLoopback)
  if (status.origin !== login.origin || issue.origin !== login.origin) throw new Error('业务接口必须与登录入口同源')
  if (cfg.authOrigins !== undefined && (!Array.isArray(cfg.authOrigins) || cfg.authOrigins.length > 16)) {
    throw new Error('authOrigins 须为最多 16 个来源的数组')
  }
  const authOrigins = (cfg.authOrigins as unknown[] | undefined ?? []).map((entry) => {
    const url = urlField(entry, 'authOrigins', allowLoopback)
    if (url.pathname !== '/' || url.search) throw new Error('authOrigins 只能包含协议、主机和端口')
    return url.origin
  })
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length || cfg.profiles.length > 32) {
    throw new Error('profiles 须包含 1 至 32 个设备动作配置')
  }
  const ids = new Set<string>()
  const profiles = cfg.profiles.map((entry: unknown): DeviceActionProfile => {
    const p = record(entry)
    const id = field(p.id, '设备动作 ID', 64)
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || ids.has(id)) throw new Error('设备动作 ID 无效或重复')
    ids.add(id)
    const newline = p.newline ?? 'cr'
    if (newline !== 'cr' && newline !== 'lf' && newline !== 'crlf') throw new Error('newline 须为 cr、lf 或 crlf')
    const successLine = field(p.successLine, 'successLine')
    const failureLine = field(p.failureLine, 'failureLine')
    if (successLine === failureLine) throw new Error('成功与失败提示不能相同')
    return {
      id, label: field(p.label ?? id, '设备动作名称'), actionLabel: field(p.actionLabel ?? '设备动作', 'actionLabel'),
      kind: 'challenge-response', command: field(p.command ?? 'debug', 'command'),
      newline,
      challengePrefix: field(p.challengePrefix, 'challengePrefix'), successLine, failureLine,
      challengeTimeoutMs: timeout(p.challengeTimeoutMs, 'challengeTimeoutMs', 5000),
      challengeTtlMs: timeout(p.challengeTtlMs, 'challengeTtlMs', 30_000),
      resultTimeoutMs: timeout(p.resultTimeoutMs, 'resultTimeoutMs', 5000)
    }
  })
  return {
    loginUrl: login.href, statusUrl: status.href, issueUrl: issue.href,
    authOrigins: [...new Set(authOrigins)].sort(),
    challengeField: field(cfg.challengeField ?? 'challenge', 'challengeField'),
    responseField: field(cfg.responseField ?? 'response', 'responseField'), profiles
  }
}

/** The device contract uses one bounded ASCII token, without terminal control characters. */
export function isDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+\/=\-]{4,256}$/.test(value)
}
