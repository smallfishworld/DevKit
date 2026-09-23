export type ShellProfileKind = 'powershell' | 'cmd' | 'git-bash' | 'wsl'

export interface ShellProfile {
  id: string
  name: string
  kind: ShellProfileKind
  command: string
  args: string[]
  available: boolean
  source?: string
}

export interface LocalTerminalConfig {
  defaultProfileId: string
  cwd: string
  font: string
  fontSize: number
}

export const DEFAULT_LOCAL_TERMINAL_CONFIG: LocalTerminalConfig = {
  defaultProfileId: 'powershell-7',
  cwd: '',
  font: 'Consolas',
  fontSize: 13
}

/**
 * 兼容 0.1.6 之前把 PowerShell 7 / Windows PowerShell 合并为 `powershell` 的配置。
 * 新版本将二者拆成独立 Profile，优先迁移到 PowerShell 7，不可用时回退 Windows PowerShell。
 */
export function normalizeLocalTerminalProfileId(profileId: string, profiles: ShellProfile[]): string {
  if (profileId !== 'powershell') return profileId
  if (profiles.some((item) => item.id === 'powershell-7' && item.available)) return 'powershell-7'
  if (profiles.some((item) => item.id === 'windows-powershell' && item.available)) return 'windows-powershell'
  return profileId
}

export interface LocalTerminalStartPayload {
  profileId: string
  cwd?: string
  cols?: number
  rows?: number
}

export interface LocalTerminalAttachResult {
  config: LocalTerminalConfig
  profiles: ShellProfile[]
  running: boolean
  activeProfileId?: string
  cwd?: string
}

export interface LocalTerminalDataEvent {
  text: string
}

export interface LocalTerminalExitEvent {
  exitCode: number
  signal?: number
  profileId: string
}
