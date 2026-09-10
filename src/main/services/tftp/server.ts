/**
 * TFTP 服务器实现（RFC 1350 + RFC 2347/2348/2349 选项扩展）
 * 主端口只接收 RRQ/WRQ，每个传输会话绑定独立临时端口，支持多客户端并发
 */
import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { TransferDir, TransferInfo } from '../../../shared/types'

export type { TransferDir, TransferInfo }

const OP_RRQ = 1
const OP_WRQ = 2
const OP_DATA = 3
const OP_ACK = 4
const OP_ERROR = 5
const OP_OACK = 6

const ERR_UNDEF = 0
const ERR_NOT_FOUND = 1
const ERR_ACCESS = 2
const ERR_DISK_FULL = 3
const ERR_ILLEGAL_OP = 4
const ERR_FILE_EXISTS = 6

const DEFAULT_BLKSIZE = 512
const MAX_BLKSIZE = 65464
const MAX_RETRIES = 5
const DEFAULT_TIMEOUT_MS = 1000

let nextTransferId = 1

function parseCString(buf: Buffer, offset: number): { value: string; next: number } | null {
  const end = buf.indexOf(0, offset)
  if (end < 0) return null
  return { value: buf.subarray(offset, end).toString('latin1'), next: end + 1 }
}

/** 解析 RRQ/WRQ 包：文件名、模式、选项 */
function parseRequest(buf: Buffer): {
  filename: string
  mode: string
  options: Map<string, string>
} | null {
  let off = 2
  const file = parseCString(buf, off)
  if (!file) return null
  off = file.next
  const mode = parseCString(buf, off)
  if (!mode) return null
  off = mode.next
  const options = new Map<string, string>()
  while (off < buf.length) {
    const key = parseCString(buf, off)
    if (!key) break
    off = key.next
    const val = parseCString(buf, off)
    if (!val) break
    off = val.next
    options.set(key.value.toLowerCase(), val.value)
  }
  return { filename: file.value, mode: mode.value, options }
}

/** 安全路径：限制在根目录内 */
function safePath(root: string, filename: string): string | null {
  const cleaned = filename.replace(/^([a-zA-Z]:)?[\\/]+/, '').replace(/\.\.[\\/]/g, '')
  const full = resolve(root, cleaned)
  const rootResolved = resolve(root)
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null
  return full
}

class Session extends EventEmitter {
  private socket: Socket | null
  private timer: NodeJS.Timeout | null = null
  private retries = 0
  private lastPacket: Buffer | null = null
  private fd: fs.FileHandle | null = null
  private blockNum = 0
  private transferred = 0
  private finished = false
  readonly info: TransferInfo
  private readonly blksize: number
  private readonly timeoutMs: number

  constructor(
    private readonly root: string,
    private readonly req: { opcode: number; filename: string; options: Map<string, string> },
    private readonly peer: RemoteInfo,
    readonly id: number
  ) {
    super()
    this.blksize = this.clampBlksize(req.options.get('blksize'))
    this.timeoutMs = this.clampTimeout(req.options.get('timeout'))
    this.info = {
      id,
      peer: `${peer.address}:${peer.port}`,
      dir: req.opcode === OP_RRQ ? 'rrq' : 'wrq',
      filename: req.filename,
      totalBytes: 0,
      transferred: 0,
      done: false,
      ok: false,
      error: null,
      startedAt: Date.now()
    }
    this.socket = createSocket('udp4')
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo))
    this.socket.on('error', (err) => this.abort(`socket 错误: ${err.message}`))
  }

  private clampBlksize(v?: string): number {
    const n = v ? parseInt(v, 10) : DEFAULT_BLKSIZE
    if (!Number.isFinite(n)) return DEFAULT_BLKSIZE
    return Math.max(8, Math.min(MAX_BLKSIZE, n))
  }

  private clampTimeout(v?: string): number {
    const n = v ? parseInt(v, 10) : NaN
    if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
    return Math.max(100, Math.min(60000, n * 1000))
  }

  async start(): Promise<void> {
    await new Promise<void>((res) => this.socket?.bind(0, () => res()))
    this.emit('log', `会话端口 ${this.socket?.address().port}，客户端 ${this.info.peer}`)

    const path = safePath(this.root, this.req.filename)
    if (!path) {
      this.fail(ERR_ACCESS, '路径越界')
      return
    }

    try {
      if (this.req.opcode === OP_RRQ) {
        const stat = await fs.stat(path)
        if (!stat.isFile()) {
          this.fail(ERR_NOT_FOUND, '不是普通文件')
          return
        }
        this.info.totalBytes = stat.size
        this.fd = await fs.open(path, 'r')
      } else {
        this.fd = await fs.open(path, 'w')
        const tsize = this.req.options.get('tsize')
        if (tsize) this.info.totalBytes = parseInt(tsize, 10) || 0
      }
    } catch {
      this.fail(ERR_NOT_FOUND, `文件打开失败: ${this.req.filename}`)
      return
    }

    const wantsOptions =
      this.req.options.has('blksize') ||
      this.req.options.has('timeout') ||
      this.req.options.has('tsize')

    if (wantsOptions) {
      const opts: string[] = []
      opts.push(`blksize\0${this.blksize}\0`)
      opts.push(`timeout\0${Math.round(this.timeoutMs / 1000)}\0`)
      if (this.req.options.has('tsize')) {
        opts.push(`tsize\0${this.info.totalBytes}\0`)
      }
      const oack = Buffer.concat([Buffer.from([0, OP_OACK]), Buffer.from(opts.join('') + '\0')])
      this.sendWait(oack, 0)
    } else if (this.req.opcode === OP_RRQ) {
      this.sendData(1)
    } else {
      this.sendWait(Buffer.from([0, OP_ACK, 0, 0]), 0)
    }
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    // 校验来源（防外部干扰），只认同一客户端
    if (rinfo.address !== this.peer.address || rinfo.port !== this.peer.port) return
    const op = msg.readUInt16BE(0)
    if (this.finished) return

    if (op === OP_ACK) {
      const block = msg.readUInt16BE(2)
      this.onAck(block)
    } else if (op === OP_DATA) {
      const block = msg.readUInt16BE(2)
      void this.onData(block, msg.subarray(4))
    } else if (op === OP_ERROR) {
      const code = msg.readUInt16BE(2)
      const msgText = parseCString(msg, 4)?.value ?? ''
      this.abort(`客户端错误 ${code}: ${msgText}`)
    }
  }

  private onAck(block: number): void {
    const expected = (this.blockNum + 1) & 0xffff
    if (block === 0 && this.lastPacket && this.lastPacket[1] === OP_OACK) {
      // OACK 确认完成，RRQ 开始传第一块
      this.retries = 0
      this.stopTimer()
      this.blockNum = 0
      if (this.req.opcode === OP_RRQ) this.sendData(1)
      return
    }
    if (block !== ((this.blockNum) & 0xffff)) {
      // 重复 ACK：重发最近 DATA 由重传计时器处理
      return
    }
    // 当前块被确认
    this.retries = 0
    this.stopTimer()
    if (this.lastSentWasFinal) {
      this.complete()
      return
    }
    this.sendData(expected)
  }

  private lastSentWasFinal = false

  private async onData(block: number, data: Buffer): Promise<void> {
    const expected = (this.blockNum + 1) & 0xffff
    if (block !== expected) {
      if (block === this.blockNum) {
        // 重复 DATA：重新 ACK
        this.sendAck(block)
      }
      return
    }
    try {
      if (!this.fd) return
      await this.fd.write(data, 0, data.length, (block - 1) * this.blksize)
    } catch (err) {
      this.fail(ERR_DISK_FULL, `写入失败: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.blockNum = block
    this.transferred = (block - 1) * this.blksize + data.length
    this.info.transferred = this.transferred
    this.retries = 0
    this.stopTimer()
    this.sendAck(block)
    this.emit('progress', { ...this.info })
    if (data.length < this.blksize) {
      this.complete()
    } else {
      this.armTimer()
    }
  }

  private async sendData(block: number): Promise<void> {
    if (!this.fd) return
    try {
      const position = (block - 1) * this.blksize
      const { bytesRead, buffer } = await this.fd.read(
        Buffer.alloc(this.blksize),
        0,
        this.blksize,
        position
      )
      const pkt = Buffer.allocUnsafe(4 + bytesRead)
      pkt.writeUInt16BE(OP_DATA, 0)
      pkt.writeUInt16BE(block & 0xffff, 2)
      buffer.copy(pkt, 4, 0, bytesRead)
      this.blockNum = block
      this.transferred = position + bytesRead
      this.info.transferred = this.transferred
      this.lastSentWasFinal = bytesRead < this.blksize
      this.sendWait(pkt, block)
      this.emit('progress', { ...this.info })
    } catch (err) {
      this.fail(ERR_UNDEF, `读取失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private sendAck(block: number): void {
    const pkt = Buffer.allocUnsafe(4)
    pkt.writeUInt16BE(OP_ACK, 0)
    pkt.writeUInt16BE(block & 0xffff, 2)
    this.sendWait(pkt, block)
  }

  /** 发送并等待对端响应，超时重传 */
  private sendWait(pkt: Buffer, block: number): void {
    this.lastPacket = pkt
    this.socket?.send(pkt, this.peer.port, this.peer.address)
    this.stopTimer()
    this.armTimer()
  }

  private armTimer(): void {
    this.stopTimer()
    this.timer = setTimeout(() => {
      this.retries += 1
      if (this.retries > MAX_RETRIES) {
        this.abort(`重传 ${MAX_RETRIES} 次无响应，放弃`)
        return
      }
      if (this.lastPacket) this.socket?.send(this.lastPacket, this.peer.port, this.peer.address)
      this.armTimer()
    }, this.timeoutMs)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private complete(): void {
    if (this.finished) return
    this.finished = true
    this.stopTimer()
    this.info.done = true
    this.info.ok = true
    this.info.transferred = this.transferred
    this.cleanup()
    this.emit('done', this.info)
  }

  private fail(code: number, message: string): void {
    if (this.finished) return
    const pkt = Buffer.alloc(4 + message.length + 1)
    pkt.writeUInt16BE(OP_ERROR, 0)
    pkt.writeUInt16BE(code, 2)
    pkt.write(message, 4)
    pkt[pkt.length - 1] = 0
    this.socket?.send(pkt, this.peer.port, this.peer.address)
    this.abort(message)
  }

  abort(message: string): void {
    if (this.finished) return
    this.finished = true
    this.stopTimer()
    this.info.done = true
    this.info.ok = false
    this.info.error = message
    this.cleanup()
    this.emit('done', this.info)
  }

  private cleanup(): void {
    this.fd?.close().catch(() => {})
    this.fd = null
    // 延迟关闭：给最后的 ACK/ERROR 留出发送时间，立即 close 会吞掉未刷出的包
    const sock = this.socket
    this.socket = null
    if (sock) {
      setTimeout(() => {
        try {
          sock.close()
        } catch {
          /* already closed */
        }
      }, 300)
    }
  }
}

export class TftpServer extends EventEmitter {
  private socket: Socket | null = null
  private sessions = new Set<Session>()
  public root = ''
  public port = 0

  get running(): boolean {
    return this.socket !== null
  }

  async start(port: number, root: string): Promise<void> {
    if (this.socket) throw new Error('服务器已在运行')
    this.root = resolve(root)
    this.port = port
    await fs.mkdir(this.root, { recursive: true })

    const sock = createSocket('udp4')
    this.socket = sock
    sock.on('message', (msg, rinfo) => void this.onRequest(msg, rinfo))
    sock.on('error', (err) => {
      this.emit('log', `监听错误: ${err.message}`)
    })
    await new Promise<void>((res, rej) => {
      sock.once('error', rej)
      sock.bind(port, () => res())
    })
    this.emit('log', `TFTP 服务器已启动: ${this.root} (UDP :${port})`)
  }

  private async onRequest(msg: Buffer, rinfo: RemoteInfo): Promise<void> {
    if (msg.length < 4) return
    const opcode = msg.readUInt16BE(0)
    if (opcode !== OP_RRQ && opcode !== OP_WRQ) return
    const req = parseRequest(msg)
    if (!req) {
      this.emit('log', `无法解析的请求来自 ${rinfo.address}`)
      return
    }
    const dirText = opcode === OP_RRQ ? '下载(读)' : '上传(写)'
    this.emit('log', `${rinfo.address} 请求${dirText}: ${req.filename}`)

    const session = new Session(this.root, { opcode, ...req }, rinfo, nextTransferId++)
    this.sessions.add(session)
    session.on('log', (line: string) => {
      if (line) this.emit('log', `[${session.info.peer}] ${line}`)
    })
    session.on('progress', (info: TransferInfo) => {
      this.emit('transfer-progress', info)
    })
    session.on('done', (info: TransferInfo) => {
      this.sessions.delete(session)
      this.emit('transfer-done', info)
      this.emit(
        'log',
        `${info.peer} ${info.dir === 'rrq' ? '下载' : '上传'} ${info.filename} ` +
          `${info.ok ? '完成' : `失败: ${info.error}`} · ${info.transferred} 字节 · ` +
          `${Date.now() - info.startedAt}ms`
      )
    })
    this.emit('transfer-start', session.info)
    void session.start()
  }

  stop(): void {
    for (const s of this.sessions) {
      s.abort('服务器已停止')
    }
    this.sessions.clear()
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    this.emit('log', 'TFTP 服务器已停止')
  }
}
