/**
 * 远程管理客户端：连到远端机器的管理端口，收发 JSON 行协议命令。
 * 断开不自动重连——事件回抛给面板，由用户手动点「连接」。
 */
import * as net from 'node:net'
import {
  packCommand,
  splitLines,
  unpackLine,
  type BridgeChannelStatus,
  type BridgeSharedStatus
} from '../../../shared/bridge-protocol'

export interface RemoteClientHandlers {
  connected: () => void
  disconnected: () => void
  statusPush: (channels: BridgeChannelStatus[], shared: BridgeSharedStatus | null) => void
  portsPush: (ports: string[]) => void
  response: (ok: boolean, message: string) => void
  log: (text: string) => void
  error: (text: string) => void
}

export class RemoteClient {
  private sock: net.Socket | null = null
  running = false

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly handlers: RemoteClientHandlers
  ) {}

  /** 连接远端；失败返回 false（事件经 handlers 抛出） */
  connect(): Promise<boolean> {
    if (this.running) return Promise.resolve(true)
    const sock = new net.Socket()
    this.sock = sock
    return new Promise((resolve) => {
      sock.setTimeout(5000)
      sock.once('connect', () => {
        sock.setTimeout(0)
        this.running = true
        this.handlers.connected()
        this.handlers.log(`已连接到管理服务端: ${this.host}:${this.port}`)
        let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
        sock.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk])
          const [lines, rest] = splitLines(buf)
          buf = rest
          for (const line of lines) {
            const msg = unpackLine(line)
            if (!msg) continue
            this.processResponse(msg)
          }
        })
        sock.on('error', (err) => {
          this.handlers.error(`管理连接错误: ${err.message}`)
          this.giveUp()
          resolve(false)
        })
        sock.on('close', () => {
          if (this.running) {
            this.handlers.log('与管理服务端的连接已断开')
            this.giveUp()
          }
        })
        resolve(true)
      })
      sock.once('error', (err) => {
        this.handlers.error(`连接管理服务端失败: ${err.message}`)
        this.handlers.disconnected()
        this.sock = null
        resolve(false)
      })
      sock.connect(this.port, this.host)
    })
  }

  private giveUp(): void {
    this.running = false
    this.sock?.destroy()
    this.sock = null
    this.handlers.disconnected()
  }

  /** 发命令；未连接返回 false */
  send(cmd: string, kv: Record<string, unknown> = {}): boolean {
    if (!this.running || !this.sock) return false
    return this.sock.write(packCommand(cmd, kv))
  }

  private processResponse(msg: Record<string, unknown>): void {
    const cmd = String(msg.cmd ?? '')
    if (cmd === 'channels_status') {
      this.handlers.statusPush(
        (msg.channels as BridgeChannelStatus[]) ?? [],
        (msg.shared_config as BridgeSharedStatus) ?? null
      )
    } else if (cmd === 'ports_list') {
      this.handlers.portsPush((msg.ports as string[]) ?? [])
    } else if (cmd === 'response') {
      this.handlers.response(String(msg.status) === 'ok', String(msg.message ?? ''))
    }
  }

  stop(): void {
    if (this.running) this.handlers.log('已断开管理连接')
    this.running = false
    this.sock?.destroy()
    this.sock = null
  }
}
