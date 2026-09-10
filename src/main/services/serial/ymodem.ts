/**
 * YMODEM 协议实现（主进程，串口文件传输）
 * 纯逻辑：通过注入的 readByte/write 与串口交互，可独立单测
 *
 * 发送（设备端运行 ry / ymodem receive / bootloader 的 Ymodem 接收）：
 *   1. 等待接收方发 'C'（CRC 模式）
 *   2. 发块 0（SOH 128B：文件名\0文件大小\0 补 0x00）
 *   3. 等 ACK，再等 'C'
 *   4. 依次发数据块（STX 1024B，不足补 0x1A），每块等 ACK
 *   5. 发 EOT：先收 NAK 重发 EOT 再收 ACK
 *   6. 等 'C' 后发空块 0 结束批次，等 ACK
 *
 * 接收（设备端运行 sy / ymodem send）：
 *   周期发 'C' 触发发送方 → 收块 0 得文件名与大小 → 收数据块 → EOT 握手 → 空块 0 结束
 */

const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const C = 0x43

/** CRC16-CCITT (XMODEM)：多项式 0x1021，初值 0 */
export function crc16(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0
  for (let i = start; i < end; i++) {
    crc ^= buf[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** 传输中断信号 */
export class TransferCancelled extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCancelled'
  }
}

/** 字节队列：串口 data 事件喂数；消费方按字节带超时读取 */
export class ByteQueue {
  private chunks: Buffer[] = []
  private waiter: ((v: boolean) => void) | null = null
  cancelled = false

  feed(chunk: Buffer): void {
    if (this.cancelled || chunk.length === 0) return
    this.chunks.push(chunk)
    const w = this.waiter
    this.waiter = null
    w?.(true)
  }

  cancel(): void {
    this.cancelled = true
    const w = this.waiter
    this.waiter = null
    w?.(false)
  }

  private async waitData(timeout: number): Promise<boolean> {
    if (this.chunks.length > 0) return true
    if (this.cancelled) return false
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        this.waiter = null
        done(false)
      }, timeout)
      this.waiter = done
    })
  }

  /** 读一个字节；超时返回 -1，取消抛 TransferCancelled */
  async readByte(timeout: number): Promise<number> {
    if (!(await this.waitData(timeout))) {
      if (this.cancelled) throw new TransferCancelled()
      return -1
    }
    const first = this.chunks[0]
    const b = first[0]
    if (first.length === 1) this.chunks.shift()
    else this.chunks[0] = first.subarray(1)
    return b
  }

  /** 等待指定控制字符（忽略期间的其他杂散字节）；超时返回 false */
  async expect(code: number, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const b = await this.readByte(Math.max(20, deadline - Date.now()))
      if (b === code) return true
      if (b === CAN) throw new TransferCancelled()
    }
    return false
  }

  /** 丢弃当前缓冲（握手前清杂波） */
  drain(): void {
    this.chunks = []
  }
}

function block(type: number, seq: number, data: Buffer, pad: number): Buffer {
  const body = Buffer.alloc(type === SOH ? 128 : 1024, pad)
  data.copy(body, 0)
  const crc = crc16(body)
  return Buffer.from([type, seq & 0xff, (~seq) & 0xff, ...body, (crc >> 8) & 0xff, crc & 0xff])
}

export interface YmodemProgress {
  (sent: number, total: number): void
}

/**
 * YMODEM 发送一个文件（设备端需先运行接收程序，如 ry）
 */
export async function ymodemSend(
  q: ByteQueue,
  write: (buf: Buffer) => void,
  fileName: string,
  data: Buffer,
  onProgress: YmodemProgress
): Promise<void> {
  // 1. 等待 'C'（接收方请求 CRC 模式），最多 30s
  if (!(await q.expect(C, 30_000))) throw new Error('等待接收方就绪超时（未收到 C）')
  q.drain()

  // 2. 块 0：文件名 + 大小
  const head = Buffer.alloc(128, 0)
  const meta = Buffer.from(`${fileName}\0${data.length}\0`, 'ascii')
  meta.copy(head, 0, 0, Math.min(meta.length, 128))
  write(block(SOH, 0, head, 0))
  if (!(await q.expect(ACK, 10_000))) throw new Error('块 0 未被确认（无 ACK）')
  if (!(await q.expect(C, 10_000))) throw new Error('块 0 后未收到 C')

  // 3. 数据块（STX 1024）
  const total = data.length
  let seq = 1
  for (let off = 0; off < total; off += 1024, seq++) {
    write(block(STX, seq, data.subarray(off, Math.min(off + 1024, total)), 0x1a))
    if (!(await q.expect(ACK, 15_000))) throw new Error(`第 ${seq} 块未被确认（无 ACK）`)
    onProgress(Math.min(off + 1024, total), total)
  }

  // 4. EOT 握手：标准流程接收方先 NAK 再 ACK（要求重发确认）；
  //    兼容直接 ACK 第一包 EOT 的实现
  write(Buffer.from([EOT]))
  const first = await q.readByte(10_000)
  if (first < 0) throw new Error('EOT 后无响应')
  if (first === NAK) {
    write(Buffer.from([EOT]))
    if (!(await q.expect(ACK, 10_000))) throw new Error('EOT 后未收到 ACK')
  } else if (first !== ACK) {
    throw new Error(`EOT 后收到异常字节 0x${first.toString(16)}`)
  }

  // 5. 批次结束：等 'C' 后发空块 0
  if (!(await q.expect(C, 10_000))) throw new Error('结束阶段未收到 C')
  write(block(SOH, 0, Buffer.alloc(0), 0))
  if (!(await q.expect(ACK, 10_000))) throw new Error('结束块未被确认（无 ACK）')
}

export interface YmodemIncomingFile {
  name: string
  size: number
  data: Buffer
}

/**
 * YMODEM 接收（设备端运行 sy / ymodem send）。收到的文件通过 onFile 回调交付
 */
export async function ymodemRecv(
  q: ByteQueue,
  write: (buf: Buffer) => void,
  onProgress: (name: string, received: number, total: number) => void
): Promise<YmodemIncomingFile[]> {
  const files: YmodemIncomingFile[] = []

  // 触发发送方：每秒发一个 'C'，收到 SOH/STX 即开始
  let started = false
  const poke = setInterval(() => {
    if (!started) write(Buffer.from([C]))
  }, 1000)
  try {
    for (;;) {
      // 等待块起始字节
      let b = -1
      const deadline = Date.now() + 60_000
      while (b !== SOH && b !== STX) {
        b = await q.readByte(1000)
        if (b === CAN) throw new TransferCancelled()
        if (b < 0 && files.length > 0) return files // 后续批次超时：结束
        if (b < 0 && Date.now() > deadline) throw new Error('等待发送方开始超时')
      }
      started = true

      // 读块体
      const seq = await q.readByte(5000)
      const nseq = await q.readByte(5000)
      const size = b === SOH ? 128 : 1024
      const body = Buffer.alloc(size)
      for (let i = 0; i < size; i++) {
        const c = await q.readByte(5000)
        if (c < 0) throw new Error('接收数据中断')
        body[i] = c
      }
      const crcHi = await q.readByte(5000)
      const crcLo = await q.readByte(5000)
      const crc = ((crcHi & 0xff) << 8) | (crcLo & 0xff)

      if (crc !== crc16(body) || (seq ^ nseq) !== 0xff) {
        write(Buffer.from([NAK])) // CRC/序号错：要求重发
        started = false
        continue
      }
      write(Buffer.from([ACK]))

      if (seq === 0) {
        // 文件头后补发 C（发送方等 ACK+C 才开始发数据块；末尾空块同样无害）
        write(Buffer.from([C]))
        // 块 0：文件头
        const nameEnd = body.indexOf(0)
        const name = body.subarray(0, nameEnd).toString('utf8').trim()
        if (!name) {
          // 空头：批次结束，再发一个 C 期待可能的下一批（外层会超时返回）
          write(Buffer.from([C]))
          started = false
          continue
        }
        const sizeStr = body.subarray(nameEnd + 1).toString('ascii').split('\0')[0]
        const fsize = parseInt(sizeStr, 10) || 0
        const chunks: Buffer[] = []
        let received = 0
        onProgress(name, 0, fsize)
        // 收数据块
        for (;;) {
          let t = -1
          while (t !== SOH && t !== STX && t !== EOT && t !== CAN) {
            t = await q.readByte(10_000)
            if (t === CAN) throw new TransferCancelled()
            if (t < 0) throw new Error('等待数据块超时')
          }
          if (t === EOT) {
            // EOT 握手：NAK → EOT → ACK（兼容只发一次 EOT 的发送方）
            write(Buffer.from([NAK]))
            const again = await q.readByte(5000)
            if (again >= 0 && again !== EOT) continue
            write(Buffer.from([ACK]))
            write(Buffer.from([C]))
            const data = Buffer.concat(chunks).subarray(0, fsize || undefined)
            files.push({ name, size: data.length, data })
            onProgress(name, data.length, fsize)
            break
          }
          const dseq = await q.readByte(5000)
          const dnseq = await q.readByte(5000)
          const dsize = t === SOH ? 128 : 1024
          const dbody = Buffer.alloc(dsize)
          for (let i = 0; i < dsize; i++) {
            const c = await q.readByte(5000)
            if (c < 0) throw new Error('接收数据中断')
            dbody[i] = c
          }
          const dhi = await q.readByte(5000)
          const dlo = await q.readByte(5000)
          const dcrc = ((dhi & 0xff) << 8) | (dlo & 0xff)
          if (dcrc !== crc16(dbody) || (dseq ^ dnseq) !== 0xff) {
            write(Buffer.from([NAK]))
            continue
          }
          if (dseq === 0) {
            // 下一文件的块 0：极少见的背靠背；按当前实现先终止本文件
            write(Buffer.from([CAN, CAN, CAN]))
            throw new Error('多文件批次未支持')
          }
          chunks.push(dbody)
          received += dsize
          write(Buffer.from([ACK]))
          onProgress(name, Math.min(received, fsize), fsize)
        }
        // 回到外层等下一批（空块 0 结束）
        started = false
      }
    }
  } finally {
    clearInterval(poke)
  }
}
