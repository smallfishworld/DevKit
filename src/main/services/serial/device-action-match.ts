import { isDeviceToken } from './device-actions-config'
import type { DeviceActionDetect, DeviceActionResultLine } from './device-actions-config'

/** Base64 行的字符集（标准 base64，含 padding） */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * 判断一行设备输出是否为挑战码。命中返回挑战码本身。
 * prefix 命中但码格式不合法时抛错（与旧行为一致：明确报格式错误而不是静默等超时）；
 * base64-line 只做形状过滤，不抛错（串口里的普通 base64 输出很常见）。
 */
export function matchChallengeLine(detect: DeviceActionDetect, line: string): string | undefined {
  if (detect.type === 'prefix') {
    if (!line.startsWith(detect.prefix)) return
    const value = line.slice(detect.prefix.length).trim()
    if (!isDeviceToken(value)) throw new Error('设备返回的挑战码格式不匹配')
    return value
  }
  const value = line.trim()
  if (!BASE64_LINE.test(value)) return
  if (value.length >= detect.shortMin && value.length <= detect.shortMax && value.endsWith('=')) return value
  if (value.length >= detect.longMin && value.length <= 4096) {
    if (Buffer.from(value, 'base64').length >= detect.longMinDecoded) return value
  }
}

/** 显式成功/失败行判定（精确整行匹配） */
export function matchResultLine(result: DeviceActionResultLine, line: string): 'unlocked' | 'rejected' | undefined {
  if (line === result.successLine) return 'unlocked'
  if (line === result.failureLine) return 'rejected'
}

/** 设备重新索要口令（prompt-repeat 判定） */
export function isPromptLine(line: string, promptText: string): boolean {
  return line.trim().startsWith(promptText)
}

/**
 * 输入回显是否为触发词：允许行首提示符（#>$%）与空白，整行等于触发词（大小写敏感）。
 * 与 AutoPSH 的 DEBUG_TRIGGER_REGEX 语义一致。
 */
export function isTriggerWord(line: string, words: readonly string[]): boolean {
  if (!words.length) return false
  const text = line.trim().replace(/^[#>$%]\s*/, '')
  return words.includes(text)
}
