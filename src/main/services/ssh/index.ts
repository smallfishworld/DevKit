/**
 * SSH 终端服务（多实例：panelId -> 会话）
 * ssh2 纯 JS 实现（无原生模块）；输出与串口相同按 80ms 批量合并推送防卡 UI
 */
import { Client, type ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SshConfig, SshParams } from '../../../shared/ssh'
import { DEFAULT_SSH_CONFIG } from '../../../shared/ssh'
import { getSection, setSection } from '../macro/configStore'

interface RxPiece {
  buf: Buffer
  time: number
}

interface SshSession {
  client: Client
  stream: ClientChannel
  params: SshParams
  rxBytes: number
  txBytes: number
  pending: RxPiece[]
  decoder: StringDecoder
  flushTimer: NodeJS.Timeout | null
  /** 自动日志：持久句柄 + 内存缓冲批量写（避免每周期 open/close 文件触发杀毒扫描） */
  logHandle: FileHandle | null
  logBuf: string[]
  /** 低流量时周期性落盘（500ms） */
  logTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, SshSession>()
/** 批量合并窗口：16ms ≈ 60fps，视觉流畅；仍合并吸收网络碎片包 */
const FLUSH_MS = 16

function sshLogDir(): string {
  return join(app.getPath('userData'), 'ssh-logs')
}

function fmtLogTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function escapeCtrl(s: string): string {
  return s.replace(/[\r\n\t]/g, (c) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' })[c] ?? c)
}

class SshService implements ToolService {
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('ssh', panelId, type, payload)
  }

  /** 日志入缓冲（真正落盘在 flushLog；写失败静默停日志，不影响收发） */
  private appendLog(s: SshSession, dir: 'RX' | 'TX' | 'INFO', body: string): void {
    if (!s.logHandle) return
    s.logBuf.push(`[${fmtLogTime(Date.now())}] ${dir.padEnd(4)} ${body}\r\n`)
  }

  /** 日志落盘：断开或缓冲超限时把缓冲一次性写入持久句柄 */
  private async flushLog(s: SshSession): Promise<void> {
    if (!s.logHandle || s.logBuf.length === 0) return
    const batch = s.logBuf
    s.logBuf = []
    try {
      await s.logHandle.appendFile(batch.join(''), 'utf8')
    } catch {
      await s.logHandle.close().catch(() => {})
      s.logHandle = null
    }
  }

  private emitStatus(panelId: string, extra: Record<string, unknown> = {}): void {
    const s = sessions.get(panelId)
    this.emit(panelId, 'status', {
      open: !!s,
      host: s?.params.host ?? '',
      params: s?.params ?? null,
      rxBytes: s?.rxBytes ?? 0,
      txBytes: s?.txBytes ?? 0,
      error: extra.error
    })
  }

  private flush(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s || s.pending.length === 0) return
    const pieces = s.pending
    s.pending = []
    const total = Buffer.concat(pieces.map((p) => p.buf))
    const text = s.decoder.write(total)
    if (s.logHandle) {
      this.appendLog(s, 'RX', escapeCtrl(text))
      // 缓冲超限立即落盘，防止长时间刷屏积压内存
      if (s.logBuf.length >= 64) void this.flushLog(s)
    }
    this.emit(panelId, 'data', {
      text,
      bytes: total.length,
      time: pieces[0].time,
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'attach':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG).then((config) => ({
          config,
          open: sessions.has(panelId)
        }))
      case 'config:get':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
      case 'config:set':
        return setSection('ssh', payload).then(() => ({ ok: true }))
      case 'connect':
        return this.connect(panelId, payload as SshParams)
      case 'close':
        return this.close(panelId)
      case 'write':
        return this.write(panelId, (payload as { text: string }).text)
      case 'resize':
        return this.resize(panelId, payload as { cols: number; rows: number })
      case 'log:save':
        return this.saveLog(panelId, payload as { content: string; name?: string })
      case 'log:set-dir':
        return this.setLogDir()
      case 'log:get-dir':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG).then((c) => ({ dir: c.logDir || sshLogDir() }))
      case 'pick-key':
        return this.pickKeyFile()
      case 'log:open-dir':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
          .then(async (c) => {
            // 优先打开用户设置的保存路径；未设置时打开默认自动日志目录
            const dir = c.logDir || sshLogDir()
            await fs.mkdir(dir, { recursive: true })
            void shell.openPath(dir)
            return { ok: true }
          })
          .catch(() => ({ ok: false, error: '无法创建日志目录' }))
      default:
        throw new Error(`ssh 服务未知操作: ${action}`)
    }
  }

  dispose(panelId: string): void {
    if (sessions.has(panelId)) void this.close(panelId)
  }

  private async connect(panelId: string, params: SshParams): Promise<{ ok: boolean; error?: string }> {
    await this.close(panelId)
    const host = (params.host || '').trim()
    if (!host) return { ok: false, error: '未填写主机地址' }
    if (!params.username.trim()) return { ok: false, error: '未填写用户名' }
    const port = Number(params.port) || 22

    // 密钥认证：先读私钥文件
    let privateKey: Buffer | undefined
    if (params.authType === 'key') {
      if (!params.privateKeyPath) return { ok: false, error: '未选择私钥文件' }
      try {
        privateKey = await fs.readFile(params.privateKeyPath)
      } catch (err) {
        return { ok: false, error: `私钥读取失败：${err instanceof Error ? err.message : String(err)}` }
      }
    } else if (!params.password) {
      return { ok: false, error: '未填写密码' }
    }

    const client = new Client()
    return new Promise((resolve) => {
      let settled = false
      const fail = (error: string): void => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          /* 忽略 */
        }
        resolve({ ok: false, error })
      }
      client.on('error', (err: Error) => fail(err.message))
      client.on('close', () => {
        const s = sessions.get(panelId)
        if (s) {
          if (s.flushTimer) {
            clearTimeout(s.flushTimer)
            s.flushTimer = null
          }
          if (s.logTimer) {
            clearInterval(s.logTimer)
            s.logTimer = null
          }
          // 意外断开（网络断/服务器关）：冲掉日志缓冲并释放句柄
          void this.flushLog(s).finally(() => {
            void s.logHandle?.close().catch(() => {})
            s.logHandle = null
          })
        }
        this.flush(panelId)
        sessions.delete(panelId)
        this.emitStatus(panelId)
      })
      client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
        // 部分服务器要求 keyboard-interactive 认证：直接用密码应答
        finish([params.password])
      })
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            fail(err.message)
            return
          }
          void this.setupSession(panelId, client, stream, { ...params, host, port })
            .then(() => {
              settled = true
              resolve({ ok: true })
            })
            .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
        })
      })
      client.connect({
        host,
        port,
        username: params.username.trim(),
        password: params.authType === 'password' ? params.password : undefined,
        privateKey,
        tryKeyboard: true,
        readyTimeout: 15_000
      })
    })
  }

  /** shell 流就绪后：建会话、挂数据转发、写自动日志头 */
  private async setupSession(
    panelId: string,
    client: Client,
    stream: ClientChannel,
    params: SshParams
  ): Promise<void> {
    // 自动日志开关（配置项，默认开启）：持久句柄 + 批量落盘
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    let logHandle: FileHandle | null = null
    if (cfg.autoLog) {
      try {
        await fs.mkdir(sshLogDir(), { recursive: true })
        const logPath = join(
          sshLogDir(),
          `${params.host.replace(/[^a-zA-Z0-9]/g, '')}-${params.port}-${new Date().toISOString().slice(0, 10)}.log`
        )
        logHandle = await fs.open(logPath, 'a')
        await logHandle.appendFile(
          `\r\n[${fmtLogTime(Date.now())}] INFO ===== 连接 ${params.username}@${params.host}:${params.port} =====\r\n`,
          'utf8'
        )
      } catch {
        await logHandle?.close().catch(() => {})
        logHandle = null
      }
    }
    const session: SshSession = {
      client,
      stream,
      params,
      rxBytes: 0,
      txBytes: 0,
      pending: [],
      decoder: new StringDecoder('utf8'),
      flushTimer: null,
      logHandle,
      logBuf: [],
      logTimer: null
    }
    sessions.set(panelId, session)
    // 低流量场景：周期性把日志缓冲落盘
    if (logHandle) {
      session.logTimer = setInterval(() => {
        const cur = sessions.get(panelId)
        if (cur) void this.flushLog(cur)
      }, 500)
    }
    stream.on('data', (chunk: Buffer) => {
      const s = sessions.get(panelId)
      if (!s) return
      s.rxBytes += chunk.length
      s.pending.push({ buf: chunk, time: Date.now() })
      if (!s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          const cur = sessions.get(panelId)
          if (cur) cur.flushTimer = null
          this.flush(panelId)
        }, FLUSH_MS)
      }
    })
    stream.stderr?.on('data', (chunk: Buffer) => {
      const s = sessions.get(panelId)
      if (!s) return
      s.rxBytes += chunk.length
      s.pending.push({ buf: chunk, time: Date.now() })
    })
    stream.on('close', () => {
      try {
        client.end()
      } catch {
        /* 'close' 事件分支会兜底清理 */
      }
    })
    this.emitStatus(panelId)
  }

  private async close(panelId: string): Promise<{ ok: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: true }
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      s.flushTimer = null
    }
    this.flush(panelId)
    this.appendLog(s, 'INFO', '===== 断开 =====')
    // 日志：清定时器、冲缓冲、关句柄
    if (s.logTimer) {
      clearInterval(s.logTimer)
      s.logTimer = null
    }
    await this.flushLog(s)
    await s.logHandle?.close().catch(() => {})
    s.logHandle = null
    sessions.delete(panelId)
    await new Promise<void>((resolve) => {
      try {
        s.stream.end()
        s.client.end()
      } catch {
        /* 忽略 */
      }
      resolve()
    })
    return { ok: true }
  }

  private write(panelId: string, text: string): { ok: boolean; error?: string } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: 'SSH 未连接' }
    if (!text) return { ok: false, error: '发送内容为空' }
    const buf = Buffer.from(text, 'utf8')
    s.stream.write(buf)
    s.txBytes += buf.length
    this.appendLog(s, 'TX', escapeCtrl(text))
    this.emit(panelId, 'tx', {
      text,
      bytes: buf.length,
      time: Date.now(),
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
    return { ok: true }
  }

  private resize(panelId: string, p: { cols: number; rows: number }): { ok: boolean } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false }
    try {
      s.stream.setWindow(Math.max(1, Math.floor(p.rows)), Math.max(1, Math.floor(p.cols)), 0, 0)
    } catch {
      /* 会话关闭竞态 */
    }
    return { ok: true }
  }

  /** 选择私钥文件（渲染端文件系统受限，用主进程对话框） */
  private async pickKeyFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥', extensions: ['pem', 'key', 'ppk', 'id_rsa'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  private async saveLog(panelId: string, p: { content: string; name?: string }): Promise<{ ok: boolean; error?: string }> {
    // 文件名带时分秒，以创建时间为准；目录用记忆的保存目录（重启记忆）
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    const stamp = new Date()
    const p2 = (n: number, w = 2): string => n.toString().padStart(w, '0')
    const defaultName =
      p.name ??
      `ssh-${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.log`
    const baseDir = cfg.logDir || sshLogDir()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存 SSH 日志',
      defaultPath: join(baseDir, defaultName),
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: false, error: '已取消' }
    try {
      await fs.writeFile(filePath, p.content, 'utf8')
      // 记住本次保存目录，下次默认打开这里（重启记忆）
      const dir = dirname(filePath)
      if (dir && dir !== cfg.logDir) {
        cfg.logDir = dir
        await setSection('ssh', cfg)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 设置手动「存日志」的保存目录（目录选择框，重启记忆） */
  private async setLogDir(): Promise<{ ok: boolean; dir?: string; error?: string }> {
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择日志保存目录',
      defaultPath: cfg.logDir || sshLogDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return { ok: false, error: '已取消' }
    cfg.logDir = filePaths[0]
    await setSection('ssh', cfg)
    return { ok: true, dir: filePaths[0] }
  }
}

export const sshService = new SshService()
