import { stripAnsi } from '../../../shared/logtext'
import { isDeviceToken } from './device-actions-config'
import type { DeviceActionProfile } from './device-actions-config'
import type { DeviceActionProvider } from './device-actions-provider'

export type DeviceActionStage = 'checking' | 'login' | 'challenge' | 'issue' | 'verify'
export type DeviceActionResult = { ok: true } | { ok: false; error: string }
type ReceivedLine = { value: string; receivedAt: number }
export type Exchange = (
  text: string, secret: boolean, timeoutMs: number, match: (line: string) => string | undefined
) => Promise<ReceivedLine>

/** 设备动作执行器接口：一个 kind 一个实现。runDeviceAction 按 kind 分发。
 *  新增动作类型 = 在这里实现新执行器 + 在 runDeviceAction 注册。 */
export interface DeviceActionRunner {
  (
    provider: DeviceActionProvider, profile: DeviceActionProfile, signal: AbortSignal,
    lock: () => void, exchange: Exchange, setStage: (stage: DeviceActionStage) => void
  ): Promise<void>
}

/** kind → 执行器注册表。新增动作流程时在此追加。 */
const runners: Partial<Record<DeviceActionProfile['kind'], DeviceActionRunner>> = {
  'challenge-response': runChallengeResponse
}

export function runDeviceAction(
  provider: DeviceActionProvider, profile: DeviceActionProfile, signal: AbortSignal,
  lock: () => void, exchange: Exchange, setStage: (stage: DeviceActionStage) => void
): Promise<void> {
  const runner = runners[profile.kind]
  if (!runner) throw new Error(`不支持的设备动作类型：${profile.kind}`)
  return runner(provider, profile, signal, lock, exchange, setStage)
}

/** 挑战应答式设备动作：先经 OA 会话取授权，再发命令 → 读挑战码 → 换口令 → 验证结果。 */
async function runChallengeResponse(
  provider: DeviceActionProvider, profile: DeviceActionProfile, signal: AbortSignal,
  lock: () => void, exchange: Exchange, setStage: (stage: DeviceActionStage) => void
): Promise<void> {
  await provider.authenticate(signal, () => setStage('login'))
  signal.throwIfAborted()
  lock()
  const newline = profile.newline === 'crlf' ? '\r\n' : profile.newline === 'lf' ? '\n' : '\r'
  setStage('challenge')
  const challenge = await exchange(profile.command + newline, false, profile.challengeTimeoutMs, (line) => {
    if (!line.startsWith(profile.challengePrefix)) return
    const value = line.slice(profile.challengePrefix.length).trim()
    if (!isDeviceToken(value)) throw new Error('设备返回的挑战码格式不匹配')
    return value
  })
  signal.throwIfAborted()
  const remaining = Math.min(profile.challengeTtlMs, profile.challengeTtlMs - (Date.now() - challenge.receivedAt))
  if (remaining <= 0) throw new Error('设备挑战码已过期')
  setStage('issue')
  const expires = AbortSignal.timeout(remaining)
  let response: string
  try { response = await provider.issue(challenge.value, AbortSignal.any([signal, expires])) } catch (error) {
    signal.throwIfAborted()
    if (expires.aborted) throw new Error('设备挑战码已过期')
    throw error
  }
  signal.throwIfAborted()
  if (expires.aborted || Date.now() - challenge.receivedAt >= profile.challengeTtlMs) {
    throw new Error('设备挑战码已过期')
  }
  if (!isDeviceToken(response)) throw new Error('取码接口未返回有效口令')
  setStage('verify')
  const result = await exchange(response + newline, true, profile.resultTimeoutMs, (line) => {
    if (line === profile.successLine) return 'unlocked'
    if (line === profile.failureLine) return 'rejected'
  })
  if (result.value === 'rejected') throw new Error('设备明确拒绝了口令')
}

/** Match complete device lines, independent of USB callbacks and renderer batching. */
export class DeviceActionLines {
  private partial = ''
  private oversize = false

  push(text: string, visit: (line: string) => boolean): void {
    const segments = text.split(/[\r\n]/)
    for (const [index, segment] of segments.entries()) {
      if (this.partial.length + segment.length > 4096) {
        this.oversize = true
        this.partial = ''
      }
      if (!this.oversize) this.partial += segment
      if (index === segments.length - 1) return
      const line = this.oversize ? '' : stripAnsi(this.partial).trim()
      this.partial = ''
      this.oversize = false
      if (line && visit(line)) return
    }
  }
}

/** Keep possible token fragments across RX batches, including a late echo after cancel/timeout. */
export class SerialSecretRedactor {
  private secrets = new Map<string, string[]>()
  private count = 0
  private pending = ''
  private pendingAt = 0

  add(secret: string): void {
    const candidates = this.secrets.get(secret[0]) ?? []
    if (candidates.includes(secret)) return
    if (this.count >= 64) throw new Error('本连接的设备动作次数达到上限，请重新连接设备')
    this.count++
    candidates.push(secret)
    candidates.sort((a, b) => b.length - a.length)
    this.secrets.set(secret[0], candidates)
  }

  push(text: string, receivedAt: number, emit: (text: string, receivedAt: number) => void): void {
    const input = this.pending + text
    const pendingLength = this.pending.length
    const pendingAt = this.pendingAt
    this.pending = ''
    let cursor = 0
    let output = ''
    let outputAt = pendingLength ? pendingAt : receivedAt
    while (cursor < input.length) {
      if (cursor >= pendingLength && outputAt !== receivedAt) {
        if (output) emit(output, outputAt)
        output = ''
        outputAt = receivedAt
      }
      const secret = this.secrets.get(input[cursor])?.find((value) => input.startsWith(value, cursor) ||
        (input.length - cursor < value.length && value.startsWith(input.slice(cursor))))
      if (!secret) {
        output += input[cursor++]
        continue
      }
      if (input.length - cursor < secret.length) {
        this.pending = input.slice(cursor)
        this.pendingAt = cursor < pendingLength ? pendingAt : receivedAt
        break
      }
      cursor += secret.length
      output += '[口令已隐藏]'
    }
    if (output) emit(output, outputAt)
  }

  finish(): string {
    if (!this.pending) return ''
    this.pending = ''
    return '[可能的口令片段已隐藏]'
  }
}
