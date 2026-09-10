/**
 * ZMODEM 传输包装：基于 zmodem.js（Sentry 检测 + 会话收发）
 * 设备端用法：rz 接收（面板发文件）/ sz 发送（面板收文件）
 *
 * 会话期间所有串口数据经 rawConsumer 直通 Sentry，不走 80ms 批量通道。
 * API 要点（源自 zmodem.js 源码）：
 *   - Sentry 构造需 to_terminal / on_detect / on_retract / sender 四个回调
 *   - on_detect 收到 Detection，须 confirm() 激活会话
 *   - 发送：Session.Send 由 Sentry 检测 ZRINIT 后创建，用 send_offer() 逐文件
 *     （Node 端无 Browser.send_files，它是浏览器 FileReader 专用）
 *   - 接收：session.start() 发 ZRINIT；offer 事件 → accept() → 完成时 spool 数组
 */
import Zmodem from 'zmodem.js'

export interface ZFile {
  name: string
  data: Buffer
}

type Consume = (chunk: Buffer) => void

/** 会话建立超时秒数 */
const SESSION_TIMEOUT_MS = 30_000

/** 用 Sentry 等待一个 ZMODEM 会话。返回 { session, sentry }；feed 由调用方接线 */
function waitSession(
  feed: (consume: Consume) => void,
  write: (buf: Buffer) => void,
  role: 'send' | 'recv',
  extra: {
    on_detect?: (det: any) => void
    on_retract?: () => void
  } = {}
): Promise<{ session: any; sentry: any }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 ZMODEM 会话建立超时')), SESSION_TIMEOUT_MS)
    const sentry = new (Zmodem as any).Sentry({
      to_terminal: () => {}, // 会话期间不向终端回显协议字节
      on_detect: (det: any) => {
        extra.on_detect?.(det)
        const session = det.confirm()
        clearTimeout(timer)
        resolve({ session, sentry })
      },
      on_retract: () => extra.on_retract?.(),
      sender: (octets: number[]) => write(Buffer.from(octets))
    })
    // 角色标记仅用于诊断：Sentry 按帧内容判定会话方向
    void role
    feed((chunk) => sentry.consume(new Uint8Array(chunk)))
  })
}

/** 发送文件（远端先运行 rz）：等 ZRINIT → send_offer → Transfer.send/end → close */
export async function zmodemSend(
  feed: (consume: Consume) => void,
  write: (buf: Buffer) => void,
  fileName: string,
  data: Buffer,
  onProgress: (bytes: number, total: number) => void
): Promise<void> {
  const { session } = await waitSession(feed, write, 'send')

  let done = false
  try {
    const xfer = await session.send_offer({ name: fileName, size: data.length })
    if (!xfer) throw new Error('远端拒绝了文件（ZSKIP）')
    // 分块发送：Transfer.send 同步入队，分块可在 UI 报进度
    const CHUNK = 16 * 1024
    for (let off = 0; off < data.length; off += CHUNK) {
      const piece = data.subarray(off, Math.min(off + CHUNK, data.length))
      xfer.send(new Uint8Array(piece))
      onProgress(Math.min(off + piece.length, data.length), data.length)
    }
    if (data.length === 0) onProgress(0, 0)
    await xfer.end()
    onProgress(data.length, data.length)
    await session.close()
    done = true
  } finally {
    // 异常中断时发中止序列通知远端；正常关闭不再 abort
    if (!done) {
      try {
        session.abort()
      } catch {
        /* 已结束则忽略 */
      }
    }
  }
}

/** 接收文件（远端先运行 sz）：收完全部文件后返回 */
export async function zmodemRecv(
  feed: (consume: Consume) => void,
  write: (buf: Buffer) => void,
  onProgress: (name: string, bytes: number, total: number) => void
): Promise<ZFile[]> {
  // 远端 sz 主动发 ZRQINIT，Sentry 检出 Receive 会话
  const { session } = await waitSession(feed, write, 'recv')
  const files: ZFile[] = []

  return new Promise<ZFile[]>((resolve, reject) => {
    let ended = false
    session.on('offer', (xfer: any) => {
      const acceptP = (async () => {
        const det = xfer.get_details()
        let got = 0
        const chunks: Buffer[] = []
        // on_input 逐包回调：自收 payload + 实时进度（函数模式下库不聚合）
        await xfer.accept({
          on_input: (payload: Uint8Array) => {
            chunks.push(Buffer.from(payload))
            got += payload.length
            onProgress(det.name, Math.min(got, det.size), det.size)
          }
        })
        const data = Buffer.concat(chunks)
        if (data.length === 0 && det.size > 0) throw new Error('接收数据丢失')
        files.push({ name: det.name, data })
        onProgress(det.name, data.length, det.size)
      })()
      acceptP.catch((err: unknown) => {
        if (!ended) {
          ended = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    session.on('session_end', () => {
      // 远端 ZFIN：批次结束。等在途 accept 完成后返回
      ended = true
      setTimeout(() => resolve(files), 50)
    })
    session
      .start()
      .then((offer: unknown) => {
        // 单文件且立即可用时 offer 非空；会话结束时为 undefined。
        // 结束检测交给 session_end 事件，这里只兜底异常
        void offer
      })
      .catch((err: unknown) => {
        if (!ended) {
          ended = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
  })
}
