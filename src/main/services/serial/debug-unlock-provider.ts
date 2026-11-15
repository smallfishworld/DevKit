import { BrowserWindow, app, session } from 'electron'
import type { Session } from 'electron'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getMainWindow } from '../../ipc'
import { DEBUG_UNLOCK_CONFIG_FILE, isDebugToken, parseDebugUnlockConfig } from './debug-unlock-config'
import type { DebugUnlockConfig } from './debug-unlock-config'

export interface DebugUnlockProvider {
  config: DebugUnlockConfig
  authenticate(signal: AbortSignal, onLogin: () => void): Promise<void>
  issue(challenge: string, signal: AbortSignal): Promise<string>
}

const activeLogins = new Set<Session>()

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
      if (bytes > 16_384) throw new Error('内网接口返回内容超限')
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

export function createDebugUnlockProvider(config: DebugUnlockConfig): DebugUnlockProvider {
  const origin = new URL(config.loginUrl).origin
  const origins = new Set([origin, ...config.authOrigins])
  const key = createHash('sha256').update([...origins].sort().join('\n')).digest('hex').slice(0, 24)
  // Cookies belong to Chromium, never to the macro or the company profile.
  const browserSession = session.fromPartition(`persist:devkit-debug-unlock-${key}`)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  async function request(url: string, signal: AbortSignal, body?: string): Promise<Response> {
    try {
      return await browserSession.fetch(url, {
        method: body === undefined ? 'GET' : 'POST', body,
        headers: body === undefined ? { 'Cache-Control': 'no-cache' } : { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        credentials: 'include', redirect: 'manual'
      })
    } catch {
      signal.throwIfAborted()
      throw new Error('内网接口请求失败或超时，请检查公司网络')
    }
  }

  async function authenticated(signal: AbortSignal): Promise<boolean> {
    const response = await request(config.statusUrl, signal)
    if (needsLogin(response)) {
      void response.body?.cancel().catch(() => {})
      return false
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`登录检查失败（HTTP ${response.status}）`)
    }
    const status = (await readResponse(response)).authenticated
    if (typeof status !== 'boolean') throw new Error('登录检查接口缺少 authenticated 字段')
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
      function restrictNavigation(event: Electron.Event & { url: string }): void {
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
      const response = await request(config.issueUrl, signal, JSON.stringify({ [config.challengeField]: challenge }))
      if (needsLogin(response) || !response.ok) {
        void response.body?.cancel().catch(() => {})
        if (needsLogin(response)) throw new Error('取码时登录已失效，请确认设备状态后重新发起')
        throw new Error(`取码接口拒绝请求（HTTP ${response.status}）`)
      }
      const value = await readResponse(response)
      const code = value[config.responseField]
      if (value.ok === false || !isDebugToken(code)) throw new Error('取码接口未返回有效口令')
      return code
    }
  }
}

export async function loadDebugUnlockProvider(): Promise<DebugUnlockProvider> {
  let contents: string
  try { contents = await readFile(join(app.getPath('userData'), DEBUG_UNLOCK_CONFIG_FILE), 'utf8') } catch {
    throw new Error('请在 DevKit 用户数据目录配置 debug-unlock.json')
  }
  if (contents.length > 65_536) throw new Error('debug-unlock.json 内容超限')
  let value: unknown
  try { value = JSON.parse(contents) } catch { throw new Error('debug-unlock.json 不是有效 JSON') }
  return createDebugUnlockProvider(parseDebugUnlockConfig(value))
}
