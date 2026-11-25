/**
 * auth.session 宿主能力：插件登录窗口与带 Cookie 的 HTTP 请求。
 * Cookie 只保存在 Chromium 的独立持久分区（按登录来源哈希区分），
 * 不写入插件配置、宏或日志；插件只能拿到请求的状态码与响应文本。
 */
import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { getMainWindow } from '../../ipc'
import { applyWindowsAppDetails, getWindowIconPath } from '../../branding'
import type {
  PluginAuthCheck, PluginAuthLoginOptions, PluginAuthRequestOptions, PluginAuthResponse
} from '../../../shared/plugins'

const MAX_RESPONSE_BYTES = 65_536
const MAX_HEADER_VALUE = 2048
const MAX_BODY = 65_536
const MAX_TIMEOUT = 300_000
const FIELD_PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,3}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const FORBIDDEN_HEADERS = new Set(['cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'expect', 'upgrade'])
const activeLogins = new Set<string>()

interface Scope { login: URL; origins: Set<string> }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(label + '无效')
  }
  return value.trim()
}

function httpsUrl(value: unknown, label: string): URL {
  let url: URL
  try { url = new URL(text(value, label, 2048)) } catch { throw new Error(label + '不是有效地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(label + '必须是有效的 HTTPS 地址')
  }
  return url
}

function originOf(value: unknown): string {
  let url: URL
  try { url = new URL(text(value, 'authOrigins', 2048)) } catch { throw new Error('authOrigins 不是有效地址') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username || url.password || url.hash || url.pathname !== '/' || url.search) {
    throw new Error('authOrigins 只能包含 http(s) 协议、主机和端口')
  }
  return url.origin
}

function scope(value: Record<string, unknown>): Scope {
  const login = httpsUrl(value.loginUrl, 'loginUrl')
  const raw = value.authOrigins
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 16)) throw new Error('authOrigins 须为最多 16 个来源')
  const origins = new Set([login.origin, ...(raw ?? []).map(originOf)])
  return { login, origins }
}

function timeoutOf(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT) {
    throw new Error(`timeoutMs 须为 1000 至 ${MAX_TIMEOUT} 的整数`)
  }
  return value
}

function checkOf(value: unknown, scopeValue: Scope): PluginAuthCheck {
  const raw = record(value, 'authCheck')
  if (raw.type === 'http-ok') {
    const url = httpsUrl(raw.url, 'authCheck.url')
    if (url.origin !== scopeValue.login.origin) throw new Error('登录检查接口必须与登录入口同源')
    return { type: 'http-ok', url: url.href }
  }
  if (raw.type === 'json') {
    const url = httpsUrl(raw.url, 'authCheck.url')
    if (url.origin !== scopeValue.login.origin) throw new Error('登录检查接口必须与登录入口同源')
    const field = raw.field === undefined ? 'authenticated' : String(raw.field)
    if (!FIELD_PATH.test(field)) throw new Error('authCheck.field 无效')
    return { type: 'json', url: url.href, field }
  }
  throw new Error('authCheck.type 须为 json 或 http-ok')
}

export interface NormalizedLogin {
  scope: Scope
  check: PluginAuthCheck
  title: string
  timeoutMs: number
  partitionKey: string
}

export function parseAuthLogin(value: unknown): NormalizedLogin {
  const raw = record(value, '登录参数')
  const parsed = scope(raw)
  const title = raw.title === undefined ? 'DevKit · 插件登录' : text(raw.title, 'title', 64)
  return {
    scope: parsed,
    check: checkOf(raw.check, parsed),
    title,
    timeoutMs: timeoutOf(raw.timeoutMs, 180_000),
    partitionKey: partitionKey(parsed)
  }
}

export interface NormalizedRequest {
  scope: Scope
  url: URL
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  partitionKey: string
}

export function parseAuthRequest(value: unknown): NormalizedRequest {
  const raw = record(value, '请求参数')
  const parsed = scope(raw)
  const url = httpsUrl(raw.url, 'request.url')
  if (url.origin !== parsed.login.origin) throw new Error('业务接口必须与登录入口同源')
  const method = raw.method === undefined ? 'POST' : raw.method
  if (method !== 'GET' && method !== 'POST') throw new Error('request.method 须为 GET 或 POST')
  const headers: Record<string, string> = {}
  if (raw.headers !== undefined) {
    const entries = Object.entries(record(raw.headers, 'request.headers'))
    if (entries.length > 32) throw new Error('request.headers 最多 32 项')
    for (const [name, headerValue] of entries) {
      const lower = name.toLowerCase()
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower)) throw new Error('不允许的请求头：' + name)
      if (typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE || /[\r\n]/.test(headerValue)) {
        throw new Error('请求头值无效：' + name)
      }
      headers[name] = headerValue
    }
  }
  const body = raw.body === undefined ? undefined : String(raw.body)
  if (body !== undefined && Buffer.byteLength(body) > MAX_BODY) throw new Error('请求体超过 64KiB')
  if (method === 'GET' && body) throw new Error('GET 请求不能包含请求体')
  return {
    scope: parsed, url, method, headers,
    ...(body === undefined ? {} : { body }),
    timeoutMs: timeoutOf(raw.timeoutMs, 8000),
    partitionKey: partitionKey(parsed)
  }
}

function partitionKey(value: Scope): string {
  return createHash('sha256').update([...value.origins].sort().join('\n')).digest('hex').slice(0, 24)
}

function browserSession(partitionKey: string): Session {
  const current = session.fromPartition(`persist:devkit-device-actions-${partitionKey}`)
  current.setPermissionCheckHandler(() => false)
  current.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  return current
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('登录检查接口没有返回内容')
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('登录检查接口返回内容超限')
      text += decoder.decode(value, { stream: true })
    }
    const value: unknown = JSON.parse(text + decoder.decode())
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    throw new Error('登录检查接口没有返回预期的 JSON')
  } finally {
    void reader.cancel().catch(() => {})
  }
  throw new Error('登录检查接口没有返回预期的 JSON')
}

async function checkAuthenticated(current: Session, check: PluginAuthCheck, signal: AbortSignal): Promise<boolean> {
  let response: Response
  try {
    response = await current.fetch(check.url, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      credentials: 'include', redirect: 'manual'
    })
  } catch (error) {
    signal.throwIfAborted()
    // Electron 的 session.fetch 遇到 redirect:'manual' 的跳转时直接抛
    // “Redirect was cancelled”，不会返回 opaqueredirect。业务页未登录时
    // 通常 302 到 SSO，因此这里按“需要登录”处理，而不是网络故障。
    if ((error as Error).message === 'Redirect was cancelled') return false
    const detail = (error as { code?: string }).code ?? (error as Error).message
    throw new Error(`登录检查请求失败或超时${detail ? `（${detail}）` : ''}，请检查公司网络`)
  }
  if (response.status === 401 || response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {})
    return false
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`登录检查失败（HTTP ${response.status}）`)
  }
  if (check.type === 'http-ok') {
    void response.body?.cancel().catch(() => {})
    return true
  }
  const status = readPath(await readResponse(response), check.field!)
  if (typeof status !== 'boolean') throw new Error(`登录检查接口缺少 ${check.field} 字段`)
  return status
}

function nativeRequest(
  options: NormalizedRequest, headers: Record<string, string>, signal: AbortSignal
): Promise<PluginAuthResponse> {
  return new Promise((resolve, reject) => {
    const send = options.url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = send(options.url, { method: options.method, headers, signal }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('内网接口返回内容超限'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

export class PluginAuthHost {
  async login(input: unknown, signal: AbortSignal): Promise<void> {
    const options = parseAuthLogin(input)
    const current = browserSession(options.partitionKey)
    if (await checkAuthenticated(current, options.check, signal)) return
    signal.throwIfAborted()
    if (activeLogins.has(options.partitionKey)) throw new Error('另一个会话正在等待同一登录来源的登录，请完成后重试')
    const win = new BrowserWindow({
      width: 980, height: 720, title: options.title,
      icon: getWindowIconPath(),
      show: false,
      parent: getMainWindow() ?? undefined,
      webPreferences: { session: current, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const closed = new AbortController()
    win.once('closed', () => closed.abort(new Error('登录窗口已关闭')))
    const blocked = new AbortController()
    function restrictNavigation(event: Electron.Event & { url: string; isMainFrame?: boolean }): void {
      // 只限制主框架：SSO 登录页里的第三方 iframe 不应中止整个登录流程。
      if (event.isMainFrame === false) return
      let origin: string
      try { origin = new URL(event.url).origin } catch { return }
      if (options.scope.origins.has(origin)) return
      event.preventDefault()
      blocked.abort(new Error('登录跳转到未配置的来源'))
    }
    win.webContents.on('will-frame-navigate', restrictNavigation)
    win.webContents.on('will-redirect', restrictNavigation)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const loginSignal = AbortSignal.any([
      signal, closed.signal, blocked.signal, AbortSignal.timeout(options.timeoutMs)
    ])
    activeLogins.add(options.partitionKey)
    try {
      applyWindowsAppDetails(win)
      win.show()
      void win.loadURL(options.scope.login.href).catch((error: { code?: string }) => {
        if (!loginSignal.aborted && error.code !== 'ERR_ABORTED') {
          blocked.abort(new Error('无法打开登录页面，请检查网络'))
        }
      })
      for (;;) {
        await delay(750, undefined, { signal: loginSignal })
        if (await checkAuthenticated(current, options.check, loginSignal)) break
      }
    } catch (error) {
      if (loginSignal.aborted) {
        if ((loginSignal.reason as Error | undefined)?.name === 'TimeoutError') throw new Error('等待登录超时')
        throw loginSignal.reason
      }
      throw error
    } finally {
      activeLogins.delete(options.partitionKey)
      if (!win.isDestroyed()) win.destroy()
    }
  }

  async request(input: unknown, signal: AbortSignal): Promise<PluginAuthResponse> {
    const options = parseAuthRequest(input)
    const current = browserSession(options.partitionKey)
    const headers: Record<string, string> = { ...options.headers }
    const sent = Object.fromEntries(Object.keys(headers).map((name) => [name.toLowerCase(), name]))
    const cookie = (await current.cookies.get({ url: options.url.href }))
      .map((entry) => `${entry.name}=${entry.value}`).join('; ')
    if (cookie) headers[sent.cookie ?? 'Cookie'] = cookie
    if (!sent['origin']) headers.Origin = options.url.origin
    if (!sent['referer']) headers.Referer = options.scope.login.href
    if (!sent['user-agent']) {
      headers['User-Agent'] =
        (current as unknown as { getUserAgent?: () => string }).getUserAgent?.() ?? 'DevKit'
    }
    if (options.body !== undefined && !sent['content-type']) headers['Content-Type'] = 'application/json'
    try {
      return await nativeRequest(options, headers, AbortSignal.any([
        signal, AbortSignal.timeout(options.timeoutMs)
      ]))
    } catch (error) {
      signal.throwIfAborted()
      const detail = (error as { code?: string }).code ?? (error as Error).message
      throw new Error(`内网接口请求失败或超时${detail ? `（${detail}）` : ''}，请检查公司网络`)
    }
  }
}
