export type ShellProfileKind = 'powershell' | 'cmd' | 'git-bash'

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
  defaultProfileId: 'powershell',
  cwd: '',
  font: 'Consolas',
  fontSize: 13
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
