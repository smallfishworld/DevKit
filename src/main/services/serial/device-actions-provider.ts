import { BrowserWindow, app, session } from 'electron'
import type { Session } from 'electron'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { getMainWindow } from '../../ipc'
import { isDeviceToken } from './device-actions-config'
import type { DeviceActionsConfig } from './device-actions-config'
import { readDeviceActionsFile } from './device-actions-store'

export interface DeviceActionProvider {
  config: DeviceActionsConfig
  authenticate(signal: AbortSignal, onLogin: () => void): Promise<void>
  issue(challenge: string, signal: AbortSignal): Promise<string>
}

/** 取码接口返回登录失效（HTTP 状态或业务 code），由执行器决定是否重登重试。 */
export class LoginExpiredError extends Error {
  constructor(message = '取码时登录已失效，请确认设备状态后重新发起') {
    super(message)
    this.name = 'LoginExpiredError'
  }
}

export interface DeviceActionIssueRequest {
  url: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}
export interface DeviceActionIssueResponse {
  status: number
  text: string
}
export type DeviceActionIssueTransport = (request: DeviceActionIssueRequest) => Promise<DeviceActionIssueResponse>

/** 测试注入点：默认实现用 Node http(s) 发请求（fetch 禁止设置 Origin/Referer，而 PSH 会校验）。 */
export interface DeviceActionProviderDeps {
  issue?: DeviceActionIssueTransport
  cookies?: (url: string) => Promise<string>
}

const MAX_RESPONSE_BYTES = 65_536

const activeLogins = new Set<Session>()

/** Electron fetch 无法设置 Origin/Referer（net::ERR_BLOCKED_BY_CLIENT），取码必须走原生 http(s)。 */
const defaultIssue: DeviceActionIssueTransport = ({ url, headers, body, signal }) => new Promise((resolve, reject) => {
  const target = new URL(url)
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest
  const req = send(target, { method: 'POST', headers, signal }, (response) => {
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
  req.end(body)
})

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('内网接口没有返回内容')
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('内网接口返回内容超限')
      text += decoder.decode(value, { stream: true })
    }
    const value: unknown = JSON.parse(text + decoder.decode())
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    throw new Error('内网接口没有返回预期的 JSON')
  } finally {
    void reader.cancel().catch(() => {})
  }
  throw new Error('内网接口没有返回预期的 JSON')
}

function needsLogin(response: Response): boolean {
  return response.status === 401 || response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 取码失败诊断只描述结构（字段名/长度），绝不输出字段值，避免口令进入界面或日志。 */
function describeIssueFailure(value: Record<string, unknown>): string {
  const top = Object.keys(value).slice(0, 8).join(',') || '-'
  const data = value.data
  const shape = data === undefined ? '无'
    : data === null ? 'null'
      : typeof data === 'string' ? `string(${data.length})`
        : Array.isArray(data) ? `array(${data.length})`
          : typeof data === 'object'
            ? `object{${Object.keys(data as Record<string, unknown>).slice(0, 8).join(',') || '-'}}`
            : typeof data
  const code = String(value.code ?? '').slice(0, 64)
  return `取码接口未返回有效口令（code=${code || '-'}，data=${shape}，顶层=${top}）`
}

export function createDeviceActionProvider(
  config: DeviceActionsConfig, deps: DeviceActionProviderDeps = {}
): DeviceActionProvider {
  const origin = new URL(config.loginUrl).origin
  const origins = new Set([origin, ...config.authOrigins])
  const key = createHash('sha256').update([...origins].sort().join('\n')).digest('hex').slice(0, 24)
  // Cookies belong to Chromium, never to the macro or the company profile.
  const browserSession = session.fromPartition(`persist:devkit-device-actions-${key}`)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const sendIssue = deps.issue ?? defaultIssue
  const cookies = deps.cookies ?? (async (url: string) => {
    const list = await browserSession.cookies.get({ url })
    return list.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  })
  const userAgent = (): string =>
    config.issue.userAgent ??
    (browserSession as unknown as { getUserAgent?: () => string }).getUserAgent?.() ??
    'DevKit'

  async function request(url: string, signal: AbortSignal): Promise<Response | null> {
    try {
      return await browserSession.fetch(url, {
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
      if ((error as Error).message === 'Redirect was cancelled') return null
      const detail = (error as { code?: string }).code ?? (error as Error).message
      throw new Error(`内网接口请求失败或超时${detail ? `（${detail}）` : ''}，请检查公司网络`)
    }
  }

  async function authenticated(signal: AbortSignal): Promise<boolean> {
    const response = await request(config.authCheck.url, signal)
    if (!response) return false
    if (needsLogin(response)) {
      void response.body?.cancel().catch(() => {})
      return false
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`登录检查失败（HTTP ${response.status}）`)
    }
    if (config.authCheck.type === 'http-ok') {
      void response.body?.cancel().catch(() => {})
      return true
    }
    const status = (await readResponse(response))[config.authCheck.field]
    if (typeof status !== 'boolean') throw new Error(`登录检查接口缺少 ${config.authCheck.field} 字段`)
    return status
  }

  return {
    config,
    async authenticate(signal, onLogin) {
      if (await authenticated(signal)) return
      signal.throwIfAborted()
      if (activeLogins.has(browserSession)) throw new Error('另一个串口正在等待 OA 登录，请完成后重试')
      const win = new BrowserWindow({
        width: 980, height: 720, title: 'DevKit · OA 登录',
        parent: getMainWindow() ?? undefined,
        webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      const closed = new AbortController()
      win.once('closed', () => closed.abort(new Error('OA 登录窗口已关闭')))
      const blocked = new AbortController()
      function restrictNavigation(event: Electron.Event & { url: string; isMainFrame?: boolean }): void {
        // 只限制主框架：SSO 登录页里的第三方 iframe 不应中止整个登录流程。
        if (event.isMainFrame === false) return
        if (origins.has(new URL(event.url).origin)) return
        event.preventDefault()
        blocked.abort(new Error('OA 登录跳转到未配置的来源'))
      }
      win.webContents.on('will-frame-navigate', restrictNavigation)
      win.webContents.on('will-redirect', restrictNavigation)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const loginSignal = AbortSignal.any([
        signal, closed.signal, blocked.signal, AbortSignal.timeout(180_000)
      ])
      activeLogins.add(browserSession)
      try {
        onLogin()
        void win.loadURL(config.loginUrl).catch((error: { code?: string }) => {
          if (!loginSignal.aborted && error.code !== 'ERR_ABORTED') {
            blocked.abort(new Error('无法打开 OA 登录页面，请检查公司网络'))
          }
        })
        for (;;) {
          await delay(750, undefined, { signal: loginSignal })
          if (await authenticated(loginSignal)) break
        }
      } catch (error) {
        if (loginSignal.aborted) {
          if (loginSignal.reason?.name === 'TimeoutError') throw new Error('等待 OA 登录超时')
          throw loginSignal.reason
        }
        throw error
      } finally {
        activeLogins.delete(browserSession)
        if (!win.isDestroyed()) win.destroy()
      }
    },
    async issue(challenge, signal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)])
      const body = JSON.stringify(Object.fromEntries(
        Object.entries(config.issue.body).map(([name, template]) => [
          name, template.split('$challenge').join(challenge)
        ])
      ))
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': new URL(config.issue.url).origin,
        'Referer': config.loginUrl,
        'User-Agent': userAgent()
      }
      const cookie = await cookies(config.issue.url)
      if (cookie) headers.Cookie = cookie
      let response: DeviceActionIssueResponse
      try {
        response = await sendIssue({ url: config.issue.url, headers, body, signal: deadline })
      } catch (error) {
        signal.throwIfAborted()
        const detail = (error as { code?: string }).code ?? (error as Error).message
        throw new Error(`内网接口请求失败或超时${detail ? `（${detail}）` : ''}，请检查公司网络`)
      }
      if (config.issue.loginExpiredHttp.includes(response.status)) throw new LoginExpiredError()
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`取码接口拒绝请求（HTTP ${response.status}）`)
      }
      let value: unknown
      try { value = JSON.parse(response.text) } catch { throw new Error('内网接口没有返回预期的 JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('内网接口没有返回预期的 JSON')
      }
      const object = value as Record<string, unknown>
      if (config.issue.loginExpiredCodes.includes(String(object.code ?? ''))) throw new LoginExpiredError()
      let code = readPath(object, config.issue.responsePath)
      // 与 AutoPSH 一致：口令可能包在 data.data，也可能直接是 data。
      // 仅当配置路径没命中、且其父级本身就是字符串时才回退，避免误取包装对象。
      const separator = config.issue.responsePath.lastIndexOf('.')
      if (code === undefined && separator > 0) {
        const parent = readPath(object, config.issue.responsePath.slice(0, separator))
        if (typeof parent === 'string') code = parent
      }
      if (object.ok === false || !isDeviceToken(code)) throw new Error(describeIssueFailure(object))
      return code
    }
  }
}

export async function loadDeviceActionProvider(): Promise<DeviceActionProvider> {
  const info = await readDeviceActionsFile(app.getPath('userData'))
  if (!info.config) {
    throw new Error(info.error ?? '请在 DevKit 用户数据目录配置 device-actions.json')
  }
  return createDeviceActionProvider(info.config)
}
