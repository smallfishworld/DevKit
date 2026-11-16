import type {
  DeviceActionAuthCheck,
  DeviceActionDetect,
  DeviceActionHold,
  DeviceActionIssue,
  DeviceActionProfile,
  DeviceActionResult,
  DeviceActionTrigger,
  DeviceActionsConfig
} from '../../../shared/device-actions'

export type {
  DeviceActionAuthCheck,
  DeviceActionAuthCheckHttp,
  DeviceActionAuthCheckJson,
  DeviceActionDetect,
  DeviceActionDetectBase64,
  DeviceActionDetectPrefix,
  DeviceActionHold,
  DeviceActionIssue,
  DeviceActionKind,
  DeviceActionProfile,
  DeviceActionResult,
  DeviceActionResultLine,
  DeviceActionResultPrompt,
  DeviceActionTrigger,
  DeviceActionsConfig
} from '../../../shared/device-actions'

export const DEVICE_ACTIONS_CONFIG_FILE = 'device-actions.json'

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

function optionalField(value: unknown, label: string, max = 128): string | undefined {
  if (value === undefined) return undefined
  return field(value, label, max)
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

/** 登录跳转白名单只用于限制登录窗口导航，允许企业 SSO 常见 http 回跳；
 *  业务接口（登录检查、取码）仍由 urlField 强制 HTTPS。 */
function originField(value: unknown, label: string): string {
  let url: URL
  try { url = new URL(field(value, label, 2048)) } catch { throw new Error(`${label} 不是有效地址`) }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username || url.password || url.hash || url.pathname !== '/' || url.search) {
    throw new Error(`${label} 只能包含 http(s) 协议、主机和端口`)
  }
  return url.origin
}

function integer(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`${label} 缺失`)
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 须为 ${min} 至 ${max} 的整数`)
  }
  return value
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} 须为布尔值`)
  return value
}

function key(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_$-]{1,64}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}

function parseDetect(value: unknown): DeviceActionDetect {
  const d = record(value)
  if (d.type === 'prefix') {
    return { type: 'prefix', prefix: field(d.prefix, 'detect.prefix') }
  }
  if (d.type === 'base64-line') {
    const shortMin = integer(d.shortMin, 'detect.shortMin', 8, 256, 20)
    const shortMax = integer(d.shortMax, 'detect.shortMax', shortMin, 512, 21)
    const longMin = integer(d.longMin, 'detect.longMin', shortMax, 8192, 300)
    return {
      type: 'base64-line', shortMin, shortMax, longMin,
      longMinDecoded: integer(d.longMinDecoded, 'detect.longMinDecoded', 16, 8192, 260)
    }
  }
  throw new Error('detect.type 须为 prefix 或 base64-line')
}

function parseResult(value: unknown): DeviceActionResult {
  const r = record(value)
  if (r.type === 'line') {
    const successLine = field(r.successLine, 'result.successLine')
    const failureLine = field(r.failureLine, 'result.failureLine')
    if (successLine === failureLine) throw new Error('成功与失败提示不能相同')
    return { type: 'line', successLine, failureLine }
  }
  if (r.type === 'prompt-repeat') {
    return {
      type: 'prompt-repeat',
      promptText: field(r.promptText ?? 'Password:', 'result.promptText'),
      decisionDelayMs: integer(r.decisionDelayMs, 'result.decisionDelayMs', 0, 2000, 150),
      silenceMs: integer(r.silenceMs, 'result.silenceMs', 100, 30_000, 3000)
    }
  }
  throw new Error('result.type 须为 line 或 prompt-repeat')
}

function parseHold(value: unknown, trigger: DeviceActionTrigger): false | DeviceActionHold {
  if (value === undefined) return trigger === 'auto' ? { maxBytes: 4096, maxMs: 15_000 } : false
  if (value === false) return false
  if (value === true) return { maxBytes: 4096, maxMs: 15_000 }
  const h = record(value)
  return {
    maxBytes: integer(h.maxBytes, 'holdInput.maxBytes', 256, 1_048_576, 4096),
    maxMs: integer(h.maxMs, 'holdInput.maxMs', 1000, 300_000, 15_000)
  }
}

function fieldPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,3}$/.test(value)) throw new Error(`${label} 无效`)
  return value
}

function parseAuthCheck(value: unknown, allowLoopback: boolean): DeviceActionAuthCheck {
  const a = record(value)
  if (a.type === 'json') {
    return {
      type: 'json',
      url: urlField(a.url, 'authCheck.url', allowLoopback).href,
      field: fieldPath(a.field ?? 'authenticated', 'authCheck.field')
    }
  }
  if (a.type === 'http-ok') {
    return { type: 'http-ok', url: urlField(a.url, 'authCheck.url', allowLoopback).href }
  }
  throw new Error('authCheck.type 须为 json 或 http-ok')
}

function parseIssue(value: unknown, allowLoopback: boolean): DeviceActionIssue {
  const i = record(value)
  const bodyValue = i.body === undefined ? { challenge: '$challenge' } : record(i.body)
  const body: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(bodyValue)) {
    const name = key(rawKey, 'issue.body 键名')
    if (typeof rawValue !== 'string' || rawValue.length > 512 || /[\x00-\x1f\x7f]/.test(rawValue)) {
      throw new Error('issue.body 值须为不含控制字符的字符串')
    }
    body[name] = rawValue
  }
  if (!Object.keys(body).length) throw new Error('issue.body 不能为空')
  if (!Object.values(body).some((text) => text.includes('$challenge'))) {
    throw new Error('issue.body 必须包含 $challenge 占位符')
  }
  const responsePath = typeof i.responsePath === 'string' ? i.responsePath : 'response'
  if (!/^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,3}$/.test(responsePath)) {
    throw new Error('issue.responsePath 无效')
  }
  const expiredHttp = i.loginExpiredHttp === undefined ? [401, 403] : i.loginExpiredHttp
  if (!Array.isArray(expiredHttp) || expiredHttp.length > 8 ||
    expiredHttp.some((code) => typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599)) {
    throw new Error('issue.loginExpiredHttp 须为最多 8 个 HTTP 状态码')
  }
  const expiredCodes = i.loginExpiredCodes === undefined ? [] : i.loginExpiredCodes
  if (!Array.isArray(expiredCodes) || expiredCodes.length > 16 ||
    expiredCodes.some((code) => typeof code !== 'string' || !code || code.length > 64 || /[\x00-\x1f\x7f]/.test(code))) {
    throw new Error('issue.loginExpiredCodes 须为最多 16 个短字符串')
  }
  return {
    url: urlField(i.url, 'issue.url', allowLoopback).href,
    body,
    responsePath,
    loginExpiredHttp: [...new Set(expiredHttp)].sort((a, b) => a - b),
    loginExpiredCodes: [...new Set(expiredCodes)],
    retryLoginOnce: boolean(i.retryLoginOnce, 'issue.retryLoginOnce', true),
    userAgent: optionalField(i.userAgent, 'issue.userAgent', 512)
  }
}

function parseTriggerWords(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new Error('triggerWords 须为最多 16 个字符串')
  return [...new Set(value.map((entry) => field(entry, 'triggerWords', 64)))]
}

export function parseDeviceActionsConfig(value: unknown, allowLoopback = false): DeviceActionsConfig {
  const cfg = record(value)
  const login = urlField(cfg.loginUrl, 'loginUrl', allowLoopback)
  const authCheck = parseAuthCheck(cfg.authCheck, allowLoopback)
  const issue = parseIssue(cfg.issue, allowLoopback)
  if (new URL(authCheck.url).origin !== login.origin || new URL(issue.url).origin !== login.origin) {
    throw new Error('业务接口必须与登录入口同源')
  }
  if (cfg.authOrigins !== undefined && (!Array.isArray(cfg.authOrigins) || cfg.authOrigins.length > 16)) {
    throw new Error('authOrigins 须为最多 16 个来源的数组')
  }
  const authOrigins = (cfg.authOrigins as unknown[] | undefined ?? []).map((entry) => {
    return originField(entry, 'authOrigins')
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
    const kind = p.kind ?? 'challenge-response'
    if (kind !== 'challenge-response') throw new Error(`不支持的设备动作类型：${String(kind)}`)
    const trigger = p.trigger ?? 'manual'
    if (trigger !== 'manual' && trigger !== 'auto') throw new Error('trigger 须为 manual 或 auto')
    const newline = p.newline ?? 'cr'
    if (newline !== 'cr' && newline !== 'lf' && newline !== 'crlf') throw new Error('newline 须为 cr、lf 或 crlf')
    const command = optionalField(p.command, 'command')
    if (trigger === 'manual' && !command) throw new Error('manual 设备动作必须配置 command')
    if (p.detect === undefined) throw new Error('设备动作缺少 detect')
    if (p.result === undefined) throw new Error('设备动作缺少 result')
    return {
      id, label: field(p.label ?? id, '设备动作名称'), actionLabel: field(p.actionLabel ?? '设备动作', 'actionLabel'),
      kind, trigger, triggerWords: parseTriggerWords(p.triggerWords),
      detect: parseDetect(p.detect), result: parseResult(p.result), command, newline,
      challengeTimeoutMs: integer(p.challengeTimeoutMs, 'challengeTimeoutMs', 100, 300_000, 5000),
      challengeTtlMs: integer(p.challengeTtlMs, 'challengeTtlMs', 100, 300_000, 30_000),
      resultTimeoutMs: integer(p.resultTimeoutMs, 'resultTimeoutMs', 100, 300_000, 5000),
      holdInput: parseHold(p.holdInput, trigger)
    }
  })
  return {
    loginUrl: login.href,
    authOrigins: [...new Set(authOrigins)].sort(),
    authCheck, issue, profiles
  }
}

/** The device contract uses one bounded ASCII token, without terminal control characters. */
export function isDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+\/=\-]{4,4096}$/.test(value)
}
