/**
 * 串口TCP桥接：单通道（一个实例 = 一路 串口 ⇄ TCP 监听 双向透传）。
 * 串口读 → 广播给所有已连接 TCP 客户端；TCP 客户端 → 写串口（经 IAC 解析）。
 * 事件驱动（serialport data 事件 + node:net），无线程。
 */
import { SerialPort } from 'serialport'
import * as net from 'node:net'
import {
  TelnetIacParser,
  type BridgeSharedFormat,
  type BridgeChannelParams
} from '../../../shared/bridge-protocol'

export type BridgeEventType = 'status' | 'log' | 'error' | 'client' | 'client_close'

export interface BridgeEventHandlers {
  /** 运行状态变化（"运行中" / "已停止"） */
  status: (text: string) => void
  /** 普通日志行 */
  log: (text: string) => void
  /** 错误日志行 */
  error: (text: string) => void
  /** TCP 客户端接入（addr） */
  client: (addr: string) => void
  /** TCP 客户端断开（addr） */
  clientClose: (addr: string) => void
  /** 状态变化通知（触发远程广播/界面刷新） */
  stateChanged: () => void
}

/** 单客户端模式踢旧连接前等待的时间，0 = 立即 */
export class BridgeChannel {
  private port: SerialPort | null = null
  private server: net.Server | null = null
  private clients = new Map<net.Socket, { addr: string; parser: TelnetIacParser }>()
  running = false
  rxBytes = 0
  txBytes = 0
  /** 启动时的参数快照（远程查询/状态推送用） */
  config: BridgeChannelParams | null = null

  constructor(private readonly handlers: BridgeEventHandlers) {}

  /**
   * 启动：先开串口再开 TCP 监听；失败清理并返回错误消息（与 Python 版一致返回 string）。
   * listen 是异步的，故整体 async，由调用方 await。
   * @param allowMulti false = 单客户端模式（新连接踢旧连接）
   * @param telnetMode true = TCP→串口方向过 IAC 解析（break 支持）
   */
  async start(
    params: BridgeChannelParams,
    shared: BridgeSharedFormat,
    tcpPort: number,
    allowMulti: boolean,
    telnetMode: boolean
  ): Promise<true | string> {
    if (this.running) return '通道已在运行'
    this.config = params
    this.rxBytes = 0
    this.txBytes = 0
    this.clients.clear()

    // 1) 打开串口（autoOpen:false — 构造器回调会被静默丢弃，必须 port.open(cb)）
    const ser = new SerialPort(
      {
        path: params.port,
        baudRate: params.baudRate,
        dataBits: shared.dataBits,
        parity: shared.parity,
        stopBits: shared.stopBits,
        xonxoff: shared.flowCtrl === 'xonxoff',
        rtscts: shared.flowCtrl === 'rtscts',
        autoOpen: false
      },
      () => {}
    )
    const serErr = await new Promise<string | null>((resolve) => ser.open((err) => resolve(err?.message ?? null)))
    if (serErr) {
      this.handlers.error(`打开串口失败: ${serErr}`)
      return `打开串口失败: ${serErr}`
    }
    this.port = ser

    // 2) TCP 监听（异步，回调里判错）
    const server = net.createServer()
    const listenErr = await new Promise<string | null>((resolve) => {
      server.once('error', (err) => resolve(err.message))
      server.listen(tcpPort, '0.0.0.0', () => resolve(null))
    })
    if (listenErr) {
      ser.close()
      this.port = null
      this.handlers.error(`TCP 监听失败: ${listenErr}`)
      return `TCP 监听失败: ${listenErr}`
    }
    this.server = server

    // 3) 串口读 → 广播（写失败的客户端剔除）
    ser.on('data', (chunk: Buffer) => {
      this.rxBytes += chunk.length
      for (const [sock, info] of this.clients) {
        if (!sock.write(chunk)) {
          // 写失败（连接已断）剔除，不阻塞其他客户端
          this.dropClient(sock, info.addr)
        }
      }
    })
    ser.on('error', (err) => this.handlers.error(`串口错误: ${err.message}`))

    // 4) 客户端接入 → (可选踢旧) 注册读处理
    server.on('connection', (sock) => {
      const addr = `${sock.remoteAddress ?? '?'}:${sock.remotePort ?? 0}`
      if (!allowMulti) {
        for (const [old, oldInfo] of this.clients) {
          old.destroy()
          this.clients.delete(old)
          this.handlers.clientClose(oldInfo.addr)
        }
      }
      this.clients.set(sock, { addr, parser: new TelnetIacParser() })
      this.handlers.client(addr)
      this.handlers.stateChanged()
      sock.on('data', (chunk: Buffer) => {
        if (!this.running || !this.port) return
        if (telnetMode) {
          const { data, events } = this.clients.get(sock)?.parser.feed(chunk) ?? {
            data: chunk,
            events: []
          }
          for (const ev of events) {
            if (ev === 'break') {
              this.handlers.log('收到 telnet BREAK, 发送串口 break')
              this.sendBreak()
            }
          }
          if (!data.length) return
          chunk = data
        }
        this.txBytes += chunk.length
        this.port.write(chunk)
      })
      sock.on('error', () => this.dropClient(sock, addr))
      sock.on('close', () => this.dropClient(sock, addr))
    })

    this.running = true
    this.handlers.status('运行中')
    this.handlers.log(
      `已启动: 串口 ${params.port} @ ${params.baudRate}, TCP 0.0.0.0:${tcpPort}`
    )
    this.handlers.stateChanged()
    return true
  }

  private dropClient(sock: net.Socket, addr: string): void {
    const info = this.clients.get(sock)
    this.clients.delete(sock)
    sock.destroy()
    if (info) this.handlers.clientClose(info.addr)
    this.handlers.stateChanged()
  }

  /** 停止：关 server（解 accept 阻塞）→ destroy 客户端 → 关串口 */
  stop(): void {
    if (!this.running) return
    this.running = false
    const server = this.server
    this.server = null
    server?.close()
    for (const [sock] of this.clients) sock.destroy()
    this.clients.clear()
    this.port?.close(() => {})
    this.port = null
    this.handlers.status('已停止')
    this.handlers.log('已停止')
    this.handlers.stateChanged()
  }

  /** 发送串口 break：TX 拉低一帧以上（node-serialport 无 sendBreak(duration)，用 set 翻转） */
  sendBreak(): boolean {
    const ser = this.port
    if (!ser || !this.running) return false
    ser.set({ brk: true }, () => {})
    setTimeout(() => ser.set({ brk: false }, () => {}), 300)
    return true
  }

  /** 当前客户端数 */
  get clientCount(): number {
    return this.clients.size
  }

  dispose(): void {
    this.stop()
  }
}
