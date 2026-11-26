/**
 * SSH 密码本地加密编解码（基于 Electron safeStorage）
 * - 落盘对象仅保存 passwordEncrypted（base64），绝不写明文 password 字段
 * - 读取时仅从 passwordEncrypted 解密还原；旧明文、缺失或损坏密文一律视为空串
 * - safeStorage 不可用时不回退明文，直接置空
 */
import type { SshConfig, SshParams, SshSessionInfo } from '../../../shared/ssh'
import { DEFAULT_SSH_CONFIG, DEFAULT_SSH_PARAMS } from '../../../shared/ssh'

export interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type StoredSshParams = Omit<SshParams, 'password'> & {
  passwordEncrypted?: string
}

export interface StoredSshSessionInfo {
  name: string
  params: StoredSshParams
}

export type StoredSshConfig = Omit<SshConfig, 'last' | 'sessions'> & {
  last: StoredSshParams
  sessions: StoredSshSessionInfo[]
}

export function encryptSshPassword(
  password: string,
  storage: SecretStorage,
  onUnavailable?: () => void
): string | undefined {
  if (!password) return undefined
  if (!storage.isEncryptionAvailable()) {
    onUnavailable?.()
    return undefined
  }
  try {
    return storage.encryptString(password).toString('base64')
  } catch {
    return undefined
  }
}

export function decryptSshPassword(encrypted: unknown, storage: SecretStorage): string {
  if (typeof encrypted !== 'string' || !encrypted) return ''
  if (!storage.isEncryptionAvailable()) return ''
  try {
    return storage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

function encodeParams(
  params: SshParams | undefined,
  storage: SecretStorage,
  onUnavailable?: () => void
): StoredSshParams {
  const { password, ...rest } = { ...DEFAULT_SSH_PARAMS, ...params }
  const passwordEncrypted = encryptSshPassword(password, storage, onUnavailable)
  return passwordEncrypted ? { ...rest, passwordEncrypted } : rest
}

function decodeParams(raw: unknown, storage: SecretStorage): SshParams {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    host: typeof rec.host === 'string' ? rec.host : DEFAULT_SSH_PARAMS.host,
    port: typeof rec.port === 'number' && Number.isFinite(rec.port) ? rec.port : DEFAULT_SSH_PARAMS.port,
    username: typeof rec.username === 'string' ? rec.username : DEFAULT_SSH_PARAMS.username,
    authType: rec.authType === 'key' ? 'key' : 'password',
    password: decryptSshPassword(rec.passwordEncrypted, storage),
    privateKeyPath: typeof rec.privateKeyPath === 'string' ? rec.privateKeyPath : DEFAULT_SSH_PARAMS.privateKeyPath
  }
}

export function encodeSshConfigForStorage(
  config: SshConfig,
  storage: SecretStorage,
  onUnavailable?: () => void
): StoredSshConfig {
  const sessions = Array.isArray(config.sessions)
    ? config.sessions.map((item) => ({
        name: item.name,
        params: encodeParams(item.params, storage, onUnavailable)
      }))
    : []
  return {
    ...config,
    last: encodeParams(config.last, storage, onUnavailable),
    sessions
  }
}

export function decodeSshConfigFromStorage(raw: unknown, storage: SecretStorage): SshConfig {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sessions: SshSessionInfo[] = Array.isArray(rec.sessions)
    ? rec.sessions
        .filter((item): item is { name: string; params?: unknown } => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
        .map((item) => ({
          name: item.name,
          params: decodeParams(item.params, storage)
        }))
    : []
  return {
    ...DEFAULT_SSH_CONFIG,
    termFont: typeof rec.termFont === 'string' ? rec.termFont : DEFAULT_SSH_CONFIG.termFont,
    termFontSize: typeof rec.termFontSize === 'number' ? rec.termFontSize : DEFAULT_SSH_CONFIG.termFontSize,
    logDir: typeof rec.logDir === 'string' ? rec.logDir : DEFAULT_SSH_CONFIG.logDir,
    autoLog: typeof rec.autoLog === 'boolean' ? rec.autoLog : DEFAULT_SSH_CONFIG.autoLog,
    showTime: typeof rec.showTime === 'boolean' ? rec.showTime : DEFAULT_SSH_CONFIG.showTime,
    sidebarWidth: typeof rec.sidebarWidth === 'number' ? rec.sidebarWidth : DEFAULT_SSH_CONFIG.sidebarWidth,
    ...(typeof rec.sidebarHidden === 'boolean' ? { sidebarHidden: rec.sidebarHidden } : {}),
    last: decodeParams(rec.last, storage),
    sessions
  }
}
