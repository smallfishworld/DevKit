/**
 * 网络助手三种主机实现（TCP Server / TCP Client / UDP）
 * 纯 Node 逻辑、不依赖 electron，便于独立测试
 */
import * as net from 'node:net'
import * as dgram from 'node:dgram'
import type { NetMode, NetParams } from '../../../shared/net'

export interface PeerInfo {
  id: string
  remote: string
}

export interface HostHandlers {
  onData: (peer: string, buf: Buffer, time: number) => void
  onStatus: (running: boolean, error?: string) => void
  /** 仅 TCP Server：连接列表变化 */
  onClients?: (clients: PeerInfo[]) => void
  onError?: (message: string) => void
}

export interface NetHost {
  readonly mode: NetMode
  start(params: NetParams): Promise<{ ok: boolean; error?: string }>
  /** targetId 仅 TCP Server 有意义：空 = 广播全部客户端 */
  send(data: Buffer, targetId?: string): { ok: boolean; error?: string; bytes?: number }
  stop(): Promise<void>
}

let connSeq = 0
const nextConnId = (): string => `c${++connSeq}`

/** ---------- TCP Server ---------- */
export class TcpServerHost implements NetHost {
  readonly mode: NetMode = 'tcp-server'
  private server: net.Server | null = null
  private clients = new Map<string, { socket: net.Socket; remote: string }>()

  constructor(private h: HostHandlers) {}

  private clientList(): PeerInfo[] {
    return [...this.clients.entries()].map(([id, c]) => ({ id, remote: c.remote }))
  }

  start(params: NetParams): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        const id = nextConnId()
        const remote = `${socket.remoteAddress}:${socket.remotePort}`
        this.clients.set(id, { socket, remote })
        this.h.onClients?.(this.clientList())
        socket.on('data', (buf: Buffer) => this.h.onData(`${remote} [${id}]`, buf, Date.now()))
        socket.on('error', (err: Error) => this.h.onError?.(err.message))
        socket.on('close', () => {
          this.clients.delete(id)
          this.h.onClients?.(this.clientList())
        })
      })
      server.on('error', (err: Error) => {
        if (this.server) {
          this.h.onError?.(err.message)
        } else {
          this.server = null
          resolve({ ok: false, error: err.message })
        }
      })
      server.listen(params.localPort, () => {
        this.server = server
        this.h.onStatus(true)
        resolve({ ok: true })
      })
    })
  }

  send(data: Buffer, targetId?: string): { ok: boolean; error?: string; bytes?: number } {
    const targets = targetId
      ? [this.clients.get(targetId)].filter((c): c is { socket: net.Socket; remote: string } => !!c)
      : [...this.clients.values()]
    if (targets.length === 0) return { ok: false, error: '没有已连接的客户端' }
    for (const t of targets) t.socket.write(data)
    return { ok: true, bytes: data.length }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const { socket } of this.clients.values()) socket.destroy()
    this.clients.clear()
    this.h.onClients?.([])
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.h.onStatus(false)
  }
}

/** ---------- TCP Client ---------- */
export class TcpClientHost implements NetHost {
  readonly mode: NetMode = 'tcp-client'
  private socket: net.Socket | null = null

  constructor(private h: HostHandlers) {}

  start(params: NetParams): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: params.host, port: params.port })
      this.socket = socket
      let settled = false
      socket.on('connect', () => {
        settled = true
        this.h.onStatus(true)
        resolve({ ok: true })
      })
      socket.on('data', (buf: Buffer) => this.h.onData(`${params.host}:${params.port}`, buf, Date.now()))
      socket.on('error', (err: Error) => {
        if (settled) {
          this.h.onError?.(err.message)
        } else {
          settled = true
          this.socket = null
          resolve({ ok: false, error: err.message })
        }
      })
      socket.on('close', () => {
        this.socket = null
        this.h.onStatus(false)
      })
    })
  }

  send(data: Buffer): { ok: boolean; error?: string } {
    if (!this.socket) return { ok: false, error: '未连接' }
    this.socket.write(data)
    return { ok: true }
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.destroy()
    })
    this.h.onStatus(false)
  }
}

/** ---------- UDP ---------- */
export class UdpHost implements NetHost {
  readonly mode: NetMode = 'udp'
  private socket: dgram.Socket | null = null
  private params: NetParams | null = null

  constructor(private h: HostHandlers) {}

  start(params: NetParams): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4')
      this.socket = socket
      this.params = params
      let settled = false
      socket.on('error', (err: Error) => {
        if (settled) {
          this.h.onError?.(err.message)
        } else {
          settled = true
          this.socket = null
          resolve({ ok: false, error: err.message })
        }
      })
      socket.on('message', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
        this.h.onData(`${rinfo.address}:${rinfo.port}`, buf, Date.now())
      })
      socket.bind(params.localPort, () => {
        settled = true
        this.h.onStatus(true)
        resolve({ ok: true })
      })
    })
  }

  send(data: Buffer): { ok: boolean; error?: string } {
    if (!this.socket || !this.params) return { ok: false, error: '未启动' }
    this.socket.send(data, this.params.port, this.params.host)
    return { ok: true }
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.params = null
    if (!socket) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.close()
    })
    this.h.onStatus(false)
  }
}

export function createHost(mode: NetMode, handlers: HostHandlers): NetHost {
  switch (mode) {
    case 'tcp-server':
      return new TcpServerHost(handlers)
    case 'tcp-client':
      return new TcpClientHost(handlers)
    default:
      return new UdpHost(handlers)
  }
}
