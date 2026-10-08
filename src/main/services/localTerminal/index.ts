import { app, dialog } from 'electron'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import {
  DEFAULT_LOCAL_TERMINAL_CONFIG,
  normalizeLocalTerminalProfileId,
  type LocalTerminalConfig,
  type LocalTerminalStartPayload,
  type ShellProfile
} from '../../../shared/local-terminal'
import { getSection, setSection } from '../macro/configStore'
import { detectWindowsShellProfiles } from './shellProfiles'

interface LocalTerminalSession {
  proc: IPty
  profile: ShellProfile
  cwd: string
  /** 待合并的输出片段（16ms 窗口拼成单次 IPC，对齐串口/SSH 的批量模式） */
  pending: string[]
  flushTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, LocalTerminalSession>()

/** 批量合并窗口：32ms ≈ 30fps；ConPTY 高吞吐时每帧可能派发数十个小片段，
 *  直通会让渲染端每片段解析一次；32ms 兼顾打印顺滑与解析次数减半 */
const FLUSH_MS = 32

function normalizedEnv(profile: ShellProfile): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  if (profile.kind === 'git-bash') env.CHERE_INVOKING = '1'
  return env
}

function validCwd(input?: string): string {
  const value = input?.trim()
  if (value) {
    try {
      if (existsSync(value) && statSync(value).isDirectory()) return value
    } catch {
      // fall through
    }
  }
  return homedir() || process.cwd()
}

function clampSize(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback
  return Math.max(2, Math.min(max, n))
}

class LocalTerminalService implements ToolService {
  private emit(panelId: string, type: string, payload?: unknown): void {
    emitToolEvent('local-terminal', panelId, type, payload)
  }

  private profiles(): ShellProfile[] {
    return process.platform === 'win32' ? detectWindowsShellProfiles() : []
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'attach':
        return this.attach(panelId)
      case 'profiles':
        return this.profiles()
      case 'config:get':
        return getSection<LocalTerminalConfig>('localTerminal', DEFAULT_LOCAL_TERMINAL_CONFIG)
      case 'config:set':
        return setSection('localTerminal', payload as LocalTerminalConfig).then(() => ({ ok: true }))
      case 'start':
        return this.start(panelId, payload as LocalTerminalStartPayload)
      case 'restart':
        return this.restart(panelId, payload as LocalTerminalStartPayload)
      case 'write':
        return this.write(panelId, (payload as { text?: string })?.text ?? '')
      case 'resize':
        return this.resize(panelId, payload as { cols?: number; rows?: number })
      case 'kill':
        return this.kill(panelId)
      case 'cwd:pick':
        return this.pickCwd()
      default:
        throw new Error(`未知本地终端操作: ${action}`)
    }
  }

  private async attach(panelId: string): Promise<unknown> {
    const config = await getSection<LocalTerminalConfig>('localTerminal', DEFAULT_LOCAL_TERMINAL_CONFIG)
    const profiles = this.profiles()
    const normalizedConfig: LocalTerminalConfig = {
      ...config,
      defaultProfileId: normalizeLocalTerminalProfileId(config.defaultProfileId, profiles)
    }
    const current = sessions.get(panelId)
    return {
      config: normalizedConfig,
      profiles,
      running: !!current,
      activeProfileId: current?.profile.id,
      cwd: current?.cwd
    }
  }

  private start(panelId: string, payload: LocalTerminalStartPayload): unknown {
    if (process.platform !== 'win32') {
      return { ok: false, error: '本地终端当前仅支持 Windows' }
    }

    const profiles = this.profiles()
    const requestedProfileId = normalizeLocalTerminalProfileId(payload.profileId, profiles)
    const profile = profiles.find((item) => item.id === requestedProfileId && item.available)
    if (!profile) {
      return { ok: false, error: `Shell 不可用：${payload.profileId}` }
    }

    this.kill(panelId)
    const cwd = validCwd(payload.cwd)
    const cols = clampSize(payload.cols, 120, 500)
    const rows = clampSize(payload.rows, 30, 200)

    try {
      const proc = pty.spawn(profile.command, profile.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: normalizedEnv(profile)
      })
      const session: LocalTerminalSession = { proc, profile, cwd, pending: [], flushTimer: null }
      sessions.set(panelId, session)

      proc.onData((text) => {
        const cur = sessions.get(panelId)
        if (cur?.proc !== proc) return
        cur.pending.push(text)
        if (!cur.flushTimer) {
          cur.flushTimer = setTimeout(() => {
            const s = sessions.get(panelId)
            if (s) s.flushTimer = null
            this.flushData(panelId)
          }, FLUSH_MS)
        }
      })
      proc.onExit(({ exitCode, signal }) => {
        const cur = sessions.get(panelId)
        if (cur?.proc !== proc) return
        if (cur.flushTimer) {
          clearTimeout(cur.flushTimer)
          cur.flushTimer = null
        }
        // 先冲掉尾部输出再报 exit，渲染端按序写入「进程已退出」提示
        this.flushData(panelId)
        sessions.delete(panelId)
        this.emit(panelId, 'exit', { exitCode, signal, profileId: profile.id })
        this.emit(panelId, 'status', { running: false, profileId: profile.id, cwd })
      })

      this.emit(panelId, 'status', {
        running: true,
        profileId: profile.id,
        profileName: profile.name,
        cwd,
        pid: proc.pid
      })
      return { ok: true, profile, cwd, pid: proc.pid }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private restart(panelId: string, payload: LocalTerminalStartPayload): unknown {
    this.kill(panelId)
    return this.start(panelId, payload)
  }

  private write(panelId: string, text: string): unknown {
    const session = sessions.get(panelId)
    if (!session) return { ok: false, error: '终端未运行' }
    session.proc.write(text)
    return { ok: true }
  }

  private resize(panelId: string, payload: { cols?: number; rows?: number }): unknown {
    const session = sessions.get(panelId)
    if (!session) return { ok: false }
    try {
      session.proc.resize(clampSize(payload.cols, 120, 500), clampSize(payload.rows, 30, 200))
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  /** 把 16ms 窗口内攒的输出片段拼成单次 data 事件发出 */
  private flushData(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s || s.pending.length === 0) return
    const text = s.pending.join('')
    s.pending = []
    this.emit(panelId, 'data', { text })
  }

  private kill(panelId: string): { ok: boolean } {
    const session = sessions.get(panelId)
    if (!session) return { ok: true }
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // 不冲 flush：kill 也用于「重启/切换 Shell」，旧进程尾部输出不应进入新会话
    sessions.delete(panelId)
    try {
      session.proc.kill()
    } catch {
      // process may already be gone
    }
    return { ok: true }
  }

  private async pickCwd(): Promise<unknown> {
    const result = await dialog.showOpenDialog({
      title: '选择终端工作目录',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  }

  dispose(panelId: string): void {
    if (panelId === '*') {
      for (const id of [...sessions.keys()]) this.kill(id)
      return
    }
    this.kill(panelId)
  }
}

export const localTerminalService = new LocalTerminalService()
