/**
 * SSH 终端服务（多实例：panelId -> 会话）
 * ssh2 纯 JS 实现（无原生模块）；输出与串口相同按 32ms 批量合并推送防卡 UI
 */
import { Client, type ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SshConfig, SshParams } from '../../../shared/ssh'
import { DEFAULT_SSH_CONFIG } from '../../../shared/ssh'
import { getSection, setSection } from '../macro/configStore'
import { TerminalRuntime } from '../terminal/runtime'

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
  pendingBytes: number
}

const sessions = new Map<string, SshSession>()
/** 批量合并窗口：32ms ≈ 30fps，打印刷新依旧顺滑；解析与重绘调用次数较 16ms 减半，仍合并吸收网络碎片包 */
const FLUSH_MS = 32
function sshLogDir(): string {
  return join(app.getPath('userData'), 'ssh-logs')
}

class SshService implements ToolService {
  private runtime = new TerminalRuntime('ssh')
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('ssh', panelId, type, payload)
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
    s.pendingBytes = 0
    this.runtime.data(panelId, text)
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    if (this.runtime.handles(action)) return this.runtime.invoke(panelId, action, payload)
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
        return this.runtime.tasks.run(panelId, () => this.connect(panelId, payload as SshParams))
      case 'close':
        return this.runtime.tasks.run(panelId, () => this.close(panelId))
      case 'write':
        return this.write(panelId, (payload as { text: string }).text)
      case 'resize':
        return this.resize(panelId, payload as { cols: number; rows: number })
      case 'log:mem-save':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG).then((c) => this.runtime.export(panelId, c.logDir || sshLogDir()))
      case 'log:mem-clear':
        this.runtime.resetOutput(panelId)
        return { ok: true }
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

  async dispose(panelId: string): Promise<void> {
    const ids = panelId === '*' ? [...new Set([...sessions.keys(), ...this.runtime.ids])] : [panelId]
    await Promise.all(ids.map((id) => this.runtime.tasks.run(id, async () => {
      try { await this.close(id) } finally { await this.runtime.dispose(id) }
    })))
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
      let setup: Promise<void> | undefined
      const fail = (error: string): void => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          /* 忽略 */
        }
        // Keep the panel task pending until asynchronous log creation has unwound.
        // Otherwise a queued dispose/reconnect can finish before setup installs a history.
        void (setup ?? Promise.resolve()).catch(() => {}).then(() => resolve({ ok: false, error }))
      }
      client.on('error', (err: Error) => fail(err.message))
      client.on('close', () => {
        fail('连接已关闭')
        void this.runtime.tasks.run(panelId, async () => {
          if (sessions.get(panelId)?.client === client) await this.close(panelId)
        }).catch(() => {})
      })
      client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
        // 部分服务器要求 keyboard-interactive 认证：直接用密码应答
        finish([params.password])
      })
      client.on('ready', () => {
        if (settled) return
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            fail(err.message)
            return
          }
          if (settled) { stream.destroy(); return }
          setup = this.setupSession(panelId, client, stream, { ...params, host, port }, () => settled)
          void setup
            .then(() => {
              if (settled) return
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
    params: SshParams,
    cancelled: () => boolean
  ): Promise<void> {
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    if (cancelled() || stream.destroyed) throw new Error('连接已关闭')
    stream.pause()
    const session: SshSession = {
      client, stream, params, rxBytes: 0, txBytes: 0, pending: [], pendingBytes: 0,
      decoder: new StringDecoder('utf8'), flushTimer: null
    }
    await this.runtime.start(panelId, {
      dir: cfg.logDir || sshLogDir(), name: `${params.host}-${params.port}`, temporary: !cfg.autoLog,
      pause: (paused) => {
        if (sessions.get(panelId) !== session) return
        if (paused) { stream.pause(); stream.stderr?.pause() }
        else { stream.resume(); stream.stderr?.resume() }
      },
      fatal: () => { void this.runtime.tasks.run(panelId, () => this.close(panelId)).catch(() => {}) },
      stats: () => ({ rxBytes: session.rxBytes, txBytes: session.txBytes })
    })
    if (cancelled() || stream.destroyed) { await this.runtime.dispose(panelId); throw new Error('连接已关闭') }
    sessions.set(panelId, session)
    const receive = (chunk: Buffer): void => {
      if (sessions.get(panelId) !== session) return
      session.rxBytes += chunk.length
      session.pending.push({ buf: chunk, time: Date.now() })
      session.pendingBytes += chunk.length
      if (session.pendingBytes >= 64 * 1024) {
        if (session.flushTimer) clearTimeout(session.flushTimer)
        session.flushTimer = null
        this.flush(panelId)
      } else if (!session.flushTimer) {
        session.flushTimer = setTimeout(() => {
          session.flushTimer = null
          if (sessions.get(panelId) === session) this.flush(panelId)
        }, FLUSH_MS)
      }
    }
    stream.on('data', receive)
    stream.stderr?.on('data', receive)
    stream.on('close', () => client.end())
    this.runtime.note(panelId, `===== 连接 ${params.username}@${params.host}:${params.port} =====`)
    stream.resume()
    this.emitStatus(panelId)
  }

  private async close(panelId: string): Promise<{ ok: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: true }
    if (s.flushTimer) clearTimeout(s.flushTimer)
    s.flushTimer = null
    this.flush(panelId)
    const tail = s.decoder.end()
    if (tail) this.runtime.data(panelId, tail)
    sessions.delete(panelId)
    this.runtime.note(panelId, '===== 断开 =====')
    s.stream.destroy()
    s.client.end()
    await this.runtime.close(panelId)
    this.emitStatus(panelId)
    return { ok: true }
  }

  private write(panelId: string, text: string): { ok: boolean; error?: string } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: 'SSH 未连接' }
    if (!text) return { ok: false, error: '发送内容为空' }
    const buf = Buffer.from(text, 'utf8')
    s.stream.write(buf)
    s.txBytes += buf.length
    this.runtime.note(panelId, text)
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
