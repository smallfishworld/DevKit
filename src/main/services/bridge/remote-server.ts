/**
 * 远程管理服务端：监听管理端口，处理客户端的 JSON 行协议命令。
 * 命令：get_channels / update_config /
 * start_channel / stop_channel / start_all / stop_all / get_ports / send_break。
 */
import * as net from 'node:net'
import {
  packCommand,
  splitLines,
  unpackLine,
  type BridgeChannelStatus,
  type BridgeSharedStatus
} from '../../../shared/bridge-protocol'

/** 服务端实现方须提供的操作（BridgeService 实现并传入） */
export interface RemoteServerHost {
  /** 全部通道状态快照 */
  getChannelsStatus(): BridgeChannelStatus[]
  /** 共享配置快照 */
  getSharedStatus(): BridgeSharedStatus
  /** 应用远端推送的配置（cid 1~8；start=true 时随后启动） */
  applyRemoteConfig(msg: Record<string, unknown>): void
  startChannel(cid: number): void
  stopChannel(cid: number): void
  startAll(): void
  stopAll(): void
  /** 串口显示名列表（如 "COM3  (USB-Serial)"） */
  listPorts(): string[]
  sendBreak(cid: number): boolean
}

export class RemoteServer {
  private server: net.Server | null = null
  private clients = new Set<net.Socket>()
  running = false

  constructor(
    private readonly host: RemoteServerHost,
    private readonly log: (text: string) => void,
    private readonly onError: (text: string) => void
  ) {}

  /** 启动监听；成功返回 true */
  async start(port: number): Promise<boolean> {
    if (this.running) return true
    const server = net.createServer()
    const err = await new Promise<string | null>((resolve) => {
      server.once('error', (e) => resolve(e.message))
      server.listen(port, '0.0.0.0', () => resolve(null))
    })
    if (err) {
      this.onError(`管理端口监听失败: ${err}`)
      return false
    }
    this.server = server
    this.running = true
    server.on('connection', (sock) => {
      const addr = `${sock.remoteAddress ?? '?'}:${sock.remotePort ?? 0}`
      this.log(`管理客户端连接: ${addr}`)
      this.clients.add(sock)
      // 新客户端立即收到一份当前状态
      this.sendTo(sock, {
        cmd: 'channels_status',
        channels: this.host.getChannelsStatus(),
        shared_config: this.host.getSharedStatus()
      })
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        const [lines, rest] = splitLines(buf)
        buf = rest
        for (const line of lines) {
          const msg = unpackLine(line)
          if (!msg) continue
          const resp = this.processCommand(sock, msg)
          if (resp) this.sendTo(sock, resp)
          // 状态变化类命令处理后广播所有客户端
          const cmd = String(msg.cmd ?? '')
          if (
            ['start_channel', 'stop_channel', 'start_all', 'stop_all', 'update_config'].includes(cmd)
          ) {
            this.broadcastStatus()
          }
        }
      })
      sock.on('error', () => this.dropClient(sock))
      sock.on('close', () => this.dropClient(sock))
    })
    this.log(`远程管理服务已启动，端口: ${port}`)
    return true
  }

  private dropClient(sock: net.Socket): void {
    this.clients.delete(sock)
    sock.destroy()
  }

  private sendTo(sock: net.Socket, msg: Record<string, unknown>): void {
    const cmd = typeof msg.cmd === 'string' ? msg.cmd : ''
    sock.write(packCommand(cmd, msg), (err) => {
      if (err) this.dropClient(sock)
    })
  }

  /** 状态变化广播（外部状态变化时调用；短时合并由调用方 setTimeout 100ms 处理） */
  broadcastStatus(): void {
    if (!this.running) return
    const msg = {
      cmd: 'channels_status',
      channels: this.host.getChannelsStatus(),
      shared_config: this.host.getSharedStatus()
    }
    for (const sock of this.clients) this.sendTo(sock, msg)
  }

  private processCommand(sock: net.Socket, msg: Record<string, unknown>): Record<string, unknown> | null {
    const cmd = String(msg.cmd ?? '')
    const cid = Number(msg.cid)
    const validCid = Number.isInteger(cid) && cid >= 1 && cid <= 8
    switch (msg.cmd) {
      case 'get_channels':
        return {
          cmd: 'channels_status',
          channels: this.host.getChannelsStatus(),
          shared_config: this.host.getSharedStatus()
        }
      case 'update_config':
        if (!validCid) return { cmd: 'response', status: 'error', message: '无效的通道ID' }
        this.host.applyRemoteConfig(msg)
        return { cmd: 'response', status: 'ok', message: `通道 ${cid} 配置已更新` }
      case 'start_channel':
        if (!validCid) return { cmd: 'response', status: 'error', message: '无效的通道ID' }
        this.host.applyRemoteConfig(msg)
        this.host.startChannel(cid)
        return { cmd: 'response', status: 'ok', message: `通道 ${cid} 启动命令已发送` }
      case 'stop_channel':
        if (!validCid) return { cmd: 'response', status: 'error', message: '无效的通道ID' }
        this.host.stopChannel(cid)
        return { cmd: 'response', status: 'ok', message: `通道 ${cid} 停止命令已发送` }
      case 'start_all':
        this.host.startAll()
        return { cmd: 'response', status: 'ok', message: '全部启动命令已发送' }
      case 'stop_all':
        this.host.stopAll()
        return { cmd: 'response', status: 'ok', message: '全部停止命令已发送' }
      case 'get_ports':
        return { cmd: 'ports_list', ports: this.host.listPorts() }
      case 'send_break':
        if (validCid && this.host.sendBreak(cid)) {
          return { cmd: 'response', status: 'ok', message: 'Break 信号已发送' }
        }
        return { cmd: 'response', status: 'error', message: '通道未运行' }
      default:
        void cmd
        void sock
        return null
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    const server = this.server
    this.server = null
    for (const sock of this.clients) sock.destroy()
    this.clients.clear()
    server?.close()
    this.log('远程管理服务已停止')
  }
}
