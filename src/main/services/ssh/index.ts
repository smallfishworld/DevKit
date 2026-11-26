/**
 * SSH 终端服务（多实例：panelId -> 会话）
 * ssh2 纯 JS 实现（无原生模块）；输出与串口相同按 32ms 批量合并推送防卡 UI
 */
import { Client, type ClientChannel } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { app, dialog, safeStorage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SshConfig, SshParams } from '../../../shared/ssh'
import { DEFAULT_SSH_CONFIG } from '../../../shared/ssh'
import type { StreamEvent, StreamSessionBridge } from '../../../shared/plugins'
import { getSection, setSection } from '../macro/configStore'
import { decodeSshConfigFromStorage, encodeSshConfigForStorage } from './secret'
import { TerminalRuntime } from '../terminal/runtime'
import { IPC_RESULT_CODES, type IpcResultCode } from '../../../shared/ipc-result'
import { mainText } from '../../app-locale'

interface RxPiece {
  buf: Buffer
  time: number
}

interface SshSession {
  connectionId: string
  pluginDecoder: StringDecoder
  pluginSequence: number
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
  private warnedEncryptionUnavailable = false

  private async readConfig(): Promise<SshConfig> {
    const raw = await getSection<unknown>('ssh', DEFAULT_SSH_CONFIG)
    return decodeSshConfigFromStorage(raw, safeStorage)
  }

  private async writeConfig(config: SshConfig): Promise<void> {
    const encoded = encodeSshConfigForStorage(config, safeStorage, () => {
      if (this.warnedEncryptionUnavailable) return
      this.warnedEncryptionUnavailable = true
      console.warn('[ssh] 系统安全存储不可用，已跳过保存 SSH 密码')
    })
    await setSection('ssh', encoded)
  }
  private readonly pluginListeners = new Map<string, Set<{ receive: (event: StreamEvent) => void; owner?: string }>>()
  private readonly pluginOwners = new Map<string, string>()

  readonly pluginBridge: StreamSessionBridge = {
    transport: 'ssh',
    describe: (panelId) => {
      const s = sessions.get(panelId)
      if (!s || s.stream.destroyed) return undefined
      return {
        panelId,
        connectionId: s.connectionId,
        transport: 'ssh',
        target: `${s.params.username}@${s.params.host}:${s.params.port}`,
        encoding: 'utf8'
      }
    },
    subscribe: (panelId, receive, owner) => {
      if (!this.pluginBridge.describe(panelId)) throw new Error('SSH 会话不可绑定')
      const existing = this.pluginListeners.get(panelId)
      const listeners = existing ?? new Set()
      if (!existing) this.pluginListeners.set(panelId, listeners)
      const sub = { receive, owner }
      listeners.add(sub)
      return () => {
        listeners.delete(sub)
        if (listeners.size === 0 && this.pluginListeners.get(panelId) === listeners) this.pluginListeners.delete(panelId)
      }
    },
    acquire: async (panelId, owner, signal) => {
      signal.throwIfAborted()
      const s = sessions.get(panelId)
      if (!s || s.stream.destroyed) throw new Error('SSH 未连接')
      const active = this.pluginOwners.get(panelId)
      if (active && active !== owner) throw new Error('SSH 写入租约正被其他插件占用')
      this.pluginOwners.set(panelId, owner)
      return {
        connectionId: s.connectionId,
        write: async (bytes) => {
          if (sessions.get(panelId) !== s || s.stream.destroyed) throw new Error('SSH 连接已断开')
          await new Promise<void>((resolve, reject) => {
            s.stream.write(Buffer.from(bytes), (err?: Error | null) => (err ? reject(err) : resolve()))
          })
          s.txBytes += bytes.length
        },
        release: () => {
          if (this.pluginOwners.get(panelId) === owner) this.pluginOwners.delete(panelId)
        }
      }
    }
  }

  private publishPluginData(panelId: string, session: SshSession, chunk: Buffer, receivedAt: number): void {
    const listeners = this.pluginListeners.get(panelId)
    if (!listeners?.size) return
    const text = session.pluginDecoder.write(chunk)
    const activeOwner = this.pluginOwners.get(panelId)
    const event: StreamEvent = {
      type: 'data',
      connectionId: session.connectionId,
      bytes: [...chunk],
      text,
      receivedAt,
      sequence: ++session.pluginSequence
    }
    for (const listener of [...listeners]) {
      if (!activeOwner || listener.owner === activeOwner) listener.receive(event)
    }
  }

  private closePluginSession(panelId: string, session: SshSession, reason: string): void {
    this.pluginOwners.delete(panelId)
    const listeners = this.pluginListeners.get(panelId)
    this.pluginListeners.delete(panelId)
    for (const listener of listeners ?? []) listener.receive({ type: 'closed', connectionId: session.connectionId, reason })
  }
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
        return this.readConfig().then((config) => ({
          config,
          open: sessions.has(panelId)
        }))
      case 'config:get':
        return this.readConfig()
      case 'config:set':
        return this.writeConfig(payload as SshConfig).then(() => ({ ok: true }))
      case 'connect':
        return this.runtime.tasks.run(panelId, () => this.connect(panelId, payload as SshParams))
      case 'close':
        return this.runtime.tasks.run(panelId, () => this.close(panelId))
      case 'write':
        return this.write(panelId, (payload as { text: string }).text)
      case 'resize':
        return this.resize(panelId, payload as { cols: number; rows: number })
      case 'log:mem-save':
        return this.readConfig().then((c) => this.runtime.export(panelId, c.logDir || sshLogDir()))
      case 'log:mem-clear':
        this.runtime.resetOutput(panelId)
        return { ok: true }
      case 'log:set-dir':
        return this.setLogDir()
      case 'log:get-dir':
        return this.readConfig().then((c) => ({ dir: c.logDir || sshLogDir() }))
      case 'pick-key':
        return this.pickKeyFile()
      case 'log:open-dir':
        return this.readConfig()
          .then(async (c) => {
            // 优先打开用户设置的保存路径；未设置时打开默认自动日志目录
            const dir = c.logDir || sshLogDir()
            await fs.mkdir(dir, { recursive: true })
            void shell.openPath(dir)
            return { ok: true }
          })
          .catch(() => ({ ok: false, error: mainText('logDirCreateFailed') }))
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
    if (!host) return { ok: false, error: mainText('sshHostRequired') }
    if (!params.username.trim()) return { ok: false, error: mainText('sshUserRequired') }
    const port = Number(params.port) || 22

    // 密钥认证：先读私钥文件
    let privateKey: Buffer | undefined
    if (params.authType === 'key') {
      if (!params.privateKeyPath) return { ok: false, error: mainText('sshKeyRequired') }
      try {
        privateKey = await fs.readFile(params.privateKeyPath)
      } catch (err) {
        return { ok: false, error: mainText('sshKeyReadFailed', { error: err instanceof Error ? err.message : String(err) }) }
      }
    } else if (!params.password) {
      return { ok: false, error: mainText('sshPasswordRequired') }
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
        fail(mainText('sshClosed'))
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
    const cfg = await this.readConfig()
    if (cancelled() || stream.destroyed) throw new Error('连接已关闭')
    stream.pause()
    const session: SshSession = {
      connectionId: randomUUID(),
      pluginDecoder: new StringDecoder('utf8'),
      pluginSequence: 0,
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
      const receivedAt = Date.now()
      session.rxBytes += chunk.length
      this.publishPluginData(panelId, session, chunk, receivedAt)
      session.pending.push({ buf: chunk, time: receivedAt })
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
    this.closePluginSession(panelId, s, 'SSH 已断开')
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
      title: mainText('selectPrivateKey'),
      properties: ['openFile'],
      filters: [
        { name: mainText('privateKeys'), extensions: ['pem', 'key', 'ppk', 'id_rsa'] },
        { name: mainText('allFiles'), extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  /** 设置手动「存日志」的保存目录（目录选择框，重启记忆） */
  private async setLogDir(): Promise<{ ok: boolean; dir?: string; code?: IpcResultCode; error?: string }> {
    const cfg = await this.readConfig()
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: mainText('selectLogDirectory'),
      defaultPath: cfg.logDir || sshLogDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return { ok: false, code: IPC_RESULT_CODES.CANCELLED, error: mainText('cancelled') }
    cfg.logDir = filePaths[0]
    await this.writeConfig(cfg)
    return { ok: true, dir: filePaths[0] }
  }

}

export const sshService = new SshService()
