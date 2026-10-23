/**
 * 串口助手服务（多实例：panelId -> 会话）
 * 高波特率防卡 UI：主进程按 32ms 批量合并接收数据后一次性推送
 */
import { SerialPort } from 'serialport'
import { StringDecoder } from 'node:string_decoder'
import * as iconv from 'iconv-lite'
import { dialog, app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SerialConfig, SerialEncoding, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { DEFAULT_SERIAL_CONFIG } from '../../../shared/serial'
import { getSection, setSection } from '../macro/configStore'
import { ByteQueue, TransferCancelled, ymodemRecv, ymodemSend } from './ymodem'
import { zmodemRecv, zmodemSend } from './zmodem'
import { TerminalRuntime } from '../terminal/runtime'

interface RxPiece {
  buf: Buffer
  time: number
}

/** 解码器统一接口：StringDecoder 与 iconv-lite 流式解码器同形（write/end），收发编码热切换时整只替换 */
interface TextDecoderLike {
  write(buf: Buffer): string
  end(): string | undefined
}

/** 按编码建流式解码器：跨批的多字节序列（GBK 双字节汉字 / UTF-8 续字节）滞留在解码器内部，
 *  不会把半个汉字拆到两批各自变成替换字符 */
function makeDecoder(encoding: SerialEncoding): TextDecoderLike {
  return encoding === 'gbk' ? iconv.getDecoder('gbk') : new StringDecoder('utf8')
}

interface SerialSession {
  port: SerialPort
  params: SerialParams
  rxBytes: number
  txBytes: number
  pending: RxPiece[]
  decoder: TextDecoderLike
  /** 本会话收发编码（开串口时从配置定档；工具栏切换编码时热替换 decoder 与此值） */
  encoding: SerialEncoding
  flushTimer: NodeJS.Timeout | null
  rawConsumer: ((chunk: Buffer) => void) | null
  pendingBytes: number
}

/** 进行中的传输（每面板最多一个） */
interface ActiveTransfer {
  protocol: TransferProtocol
  dir: 'send' | 'recv'
  cancel: () => void
}

const sessions = new Map<string, SerialSession>()
const transfers = new Map<string, ActiveTransfer>()
const FLUSH_MS = 32

/** 自动日志目录：userData/serial-logs/ */
function serialLogDir(): string {
  return join(app.getPath('userData'), 'serial-logs')
}

class SerialService implements ToolService {
  private runtime = new TerminalRuntime('serial')
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('serial', panelId, type, payload)
  }

  private emitStatus(panelId: string, extra: Record<string, unknown> = {}): void {
    const s = sessions.get(panelId)
    this.emit(panelId, 'status', {
      open: !!s,
      path: s?.params.path ?? '',
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
        return getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG).then((config) => ({
          config,
          open: sessions.has(panelId)
        }))
      case 'list':
        return SerialPort.list().then((ports) =>
          ports.map((p) => ({
            path: p.path,
            friendlyName: p.friendlyName ?? p.manufacturer ?? '',
            serialNumber: p.serialNumber ?? ''
          }))
        )
      case 'config:get':
        return getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG)
      case 'config:set':
        return setSection('serial', payload).then(() => ({ ok: true }))
      case 'encoding:set':
        return this.setEncoding(panelId, (payload as { encoding: SerialEncoding }).encoding)
      case 'open':
        return this.runtime.tasks.run(panelId, () => this.open(panelId, payload as SerialParams))
      case 'close':
        return this.runtime.tasks.run(panelId, () => this.close(panelId))
      case 'write':
        return this.write(panelId, payload as { mode: 'ascii' | 'hex'; text: string; newline: 'none' | 'crlf' | 'lf' | 'cr' })
      case 'dtr':
        return this.setFlow(panelId, { dtr: Boolean((payload as { on: boolean }).on) })
      case 'rts':
        return this.setFlow(panelId, { rts: Boolean((payload as { on: boolean }).on) })
      case 'signals':
        return this.signals(panelId)
      case 'log:mem-save':
        return getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG).then((c) => this.runtime.export(panelId, c.logDir || serialLogDir()))
      case 'log:mem-clear':
        this.runtime.resetOutput(panelId)
        return { ok: true }
      case 'log:set-dir':
        return this.setLogDir()
      case 'log:get-dir':
        return getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG).then((c) => ({ dir: c.logDir || serialLogDir() }))
      case 'log:open-dir':
        return getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG)
          .then(async (c) => {
            // 优先打开用户设置的保存路径；未设置时打开默认自动日志目录
            const dir = c.logDir || serialLogDir()
            await fs.mkdir(dir, { recursive: true })
            void shell.openPath(dir)
            return { ok: true }
          })
          .catch(() => ({ ok: false, error: '无法创建日志目录' }))
      case 'file:pick':
        return this.pickFile()
      case 'file:pick-dir':
        return this.pickDir()
      case 'file:send':
        return this.fileSend(panelId, payload as { protocol: TransferProtocol; path: string })
      case 'file:recv':
        return this.fileRecv(panelId, payload as { protocol: TransferProtocol; dir: string })
      case 'file:cancel':
        return this.fileCancel(panelId)
      default:
        throw new Error(`serial 服务未知操作: ${action}`)
    }
  }

  /** 面板关闭时断开串口（ipc dispose 分支调用） */
  async dispose(panelId: string): Promise<void> {
    const ids = panelId === '*' ? [...new Set([...sessions.keys(), ...this.runtime.ids])] : [panelId]
    await Promise.all(ids.map((id) => this.runtime.tasks.run(id, async () => {
      try { await this.close(id) } finally { await this.runtime.dispose(id) }
    })))
  }

  private async open(panelId: string, params: SerialParams): Promise<{ ok: boolean; error?: string }> {
    await this.close(panelId)
    if (!params.path) return { ok: false, error: '未选择串口' }
    // 波特率下拉允许手输（allow-create 可能给字符串），统一强转并校验
    const baudRate = Number(params.baudRate)
    if (!Number.isFinite(baudRate) || baudRate < 1 || baudRate > 12_000_000) {
      return { ok: false, error: `波特率无效: ${params.baudRate}` }
    }
    const normParams: SerialParams = { ...params, baudRate }
    // 自动日志开关（配置项，默认开启）
    const cfg = await getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG)
    let openErr = await this.tryOpen(panelId, normParams, cfg)
    if (openErr && /SetCommState/.test(openErr.message)) {
      // CH340 驱动毛刺：以相同波特率关闭后立刻重开，SetCommState 报错误 31。
      // 先用一个不同波特率开关一次复位驱动内部状态，再按目标参数重试
      await this.probeReset(normParams.path, baudRate)
      openErr = await this.tryOpen(panelId, normParams, cfg)
    }
    return openErr ? { ok: false, error: openErr.message } : { ok: true }
  }

  /** 打开串口并建立会话；成功返回 null，失败返回错误 */
  private async tryOpen(panelId: string, params: SerialParams, cfg: SerialConfig): Promise<Error | null> {
    const port = new SerialPort({ ...params, autoOpen: false })
    const session: SerialSession = {
      port, params, rxBytes: 0, txBytes: 0, pending: [], pendingBytes: 0,
      decoder: makeDecoder(cfg.encoding ?? 'utf8'), encoding: cfg.encoding ?? 'utf8',
      flushTimer: null, rawConsumer: null
    }
    try {
      await this.runtime.start(panelId, {
        dir: cfg.logDir || serialLogDir(), name: params.path, temporary: !cfg.autoLog,
        pause: (paused) => {
          // Without RTS/CTS, keep capturing to disk; pausing the host cannot stop the device.
          if (sessions.get(panelId) !== session || !params.rtscts) return
          if (paused) port.pause(); else port.resume()
        },
        fatal: () => { void this.runtime.tasks.run(panelId, () => this.close(panelId)).catch(() => {}) },
        stats: () => ({ rxBytes: session.rxBytes, txBytes: session.txBytes })
      })
      sessions.set(panelId, session)
      port.on('error', (err: Error) => this.emit(panelId, 'error', { message: err.message }))
      port.on('data', (chunk: Buffer) => {
        if (sessions.get(panelId) !== session) return
        session.rxBytes += chunk.length
        if (session.rawConsumer) { session.rawConsumer(chunk); return }
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
      })
      port.on('close', () => {
        void this.runtime.tasks.run(panelId, async () => {
          if (sessions.get(panelId) === session) await this.close(panelId)
        }).catch(() => {})
      })
      await new Promise<void>((resolve, reject) => port.open((err) => err ? reject(err) : resolve()))
      this.runtime.note(panelId, `===== 打开 ${params.path} @ ${params.baudRate} =====`)
      this.emitStatus(panelId)
      return null
    } catch (error) {
      if (sessions.get(panelId) === session) sessions.delete(panelId)
      if (port.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()))
      await this.runtime.dispose(panelId)
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  /** CH340 驱动复位探测：用一个与目标不同的波特率打开后立即关闭（尽力而为，2 秒兜底） */
  private async probeReset(path: string, targetBaud: number): Promise<void> {
    const probeBaud = targetBaud === 9600 ? 19200 : 9600
    const probe = new SerialPort({ path, baudRate: probeBaud, autoOpen: false }, () => {})
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      probe.open((err) => {
        if (err) {
          done()
          return
        }
        probe.close(() => done())
      })
      setTimeout(done, 2000)
    })
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
    this.fileCancel(panelId)
    s.rawConsumer = null
    await new Promise<void>((resolve) => {
      if (!s.port.isOpen) resolve()
      else s.port.close(() => resolve())
    })
    await this.runtime.close(panelId)
    this.emitStatus(panelId)
    return { ok: true }
  }

  private write(
    panelId: string,
    p: { mode: 'ascii' | 'hex'; text: string; newline: 'none' | 'crlf' | 'lf' | 'cr' }
  ): { ok: boolean; error?: string; bytes?: number } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    // 与渲染端相同的组包规则（主进程兜底解析）
    const nl = p.newline === 'crlf' ? '\r\n' : p.newline === 'lf' ? '\n' : p.newline === 'cr' ? '\r' : ''
    let buf: Buffer
    if (p.mode === 'hex') {
      const compact = p.text.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
      if (compact.length === 0) return { ok: false, error: 'HEX 内容为空' }
      if (compact.length % 2 !== 0) return { ok: false, error: 'HEX 长度须为偶数' }
      buf = Buffer.from(compact, 'hex')
    } else {
      // TX 编码：GBK 设备按 GBK 下发（设备按 UTF-8 解释 GBK 字节时中文变 ？）
      buf = s.encoding === 'gbk' ? iconv.encode(p.text + nl, 'gbk') : Buffer.from(p.text + nl, 'utf8')
    }
    if (buf.length === 0) return { ok: false, error: '发送内容为空' }
    s.port.write(buf)
    s.txBytes += buf.length
    // HEX 发送按字节审计记录（二进制过 toString('utf8') 会把 0x1b 当 ANSI 剥掉、非法字节变 U+FFFD）
    // ASCII 发送记录解码前文本（buf 可能是 GBK 编码，toString('utf8') 会乱码；hex 模式不存在多字节问题）
    const auditText = p.mode === 'hex' ? buf.toString('hex').replace(/../g, '$& ').trim() : p.text + nl
    this.runtime.note(panelId, auditText)
    this.emit(panelId, 'tx', {
      text: auditText,
      bytes: buf.length,
      time: Date.now(),
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
    return { ok: true, bytes: buf.length }
  }

  /** 热切换收发编码：只影响之后的线上字节；切换前已按旧编码解码的显示/日志不回溯。
   *  替换整个流式解码器——旧解码器里滞留的多字节尾巴按新编码解释必然错位 */
  private setEncoding(panelId: string, encoding: SerialEncoding): { ok: boolean } {
    const s = sessions.get(panelId)
    if (s) {
      s.encoding = encoding
      s.decoder = makeDecoder(encoding)
    }
    return { ok: true }
  }

  private setFlow(panelId: string, bits: { dtr?: boolean; rts?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s) return Promise.resolve({ ok: false, error: '串口未打开' })
    return new Promise((resolve) => {
      s.port.set(bits, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
    })
  }

  private async signals(panelId: string): Promise<{ ok: boolean; error?: string; cts?: boolean; dsr?: boolean; dcd?: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    return new Promise((resolve) => {
      s.port.get((err, status) => {
        if (err || !status) resolve({ ok: false, error: err?.message ?? '读取失败' })
        else resolve({ ok: true, cts: status.cts, dsr: status.dsr, dcd: status.dcd })
      })
    })
  }

  /** 设置手动「存日志」的保存目录（目录选择框，重启记忆） */
  private async setLogDir(): Promise<{ ok: boolean; dir?: string; error?: string }> {
    const cfg = await getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG)
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择日志保存目录',
      defaultPath: cfg.logDir || serialLogDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return { ok: false, error: '已取消' }
    cfg.logDir = filePaths[0]
    await setSection('serial', cfg)
    return { ok: true, dir: filePaths[0] }
  }

  // ---------- 文件传输（YMODEM / ZMODEM） ----------

  private async pickFile(): Promise<{ ok: boolean; path?: string }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要发送的文件',
      properties: ['openFile']
    })
    if (canceled || !filePaths[0]) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  private async pickDir(): Promise<{ ok: boolean; path?: string }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择接收目录',
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  private tr(panelId: string, e: SerialTransferEvt): void {
    this.emit(panelId, 'transfer', e)
  }

  private async fileSend(panelId: string, p: { protocol: TransferProtocol; path: string }): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    if (transfers.has(panelId)) return { ok: false, error: '已有传输进行中' }
    let data: Buffer
    try {
      data = await fs.readFile(p.path)
    } catch (err) {
      return { ok: false, error: `读取文件失败：${err instanceof Error ? err.message : String(err)}` }
    }
    const name = basename(p.path)
    const write = (buf: Buffer): void => {
      s.port.write(buf)
      s.txBytes += buf.length
    }
    this.tr(panelId, { state: 'start', protocol: p.protocol, dir: 'send', name, bytes: 0, total: data.length })

    // 取消通道：fileCancel 触发，令协议 Promise 立刻以"已取消"结束
    let cancelReject: (() => void) | null = null
    const cancelPromise = new Promise<never>((_resolve, reject) => {
      cancelReject = reject
    })
    const q = new ByteQueue()
    transfers.set(panelId, {
      protocol: p.protocol,
      dir: 'send',
      cancel: () => {
        q.cancel()
        cancelReject?.()
      }
    })

    const work = (async () => {
      if (p.protocol === 'ymodem') {
        s.rawConsumer = (chunk) => q.feed(chunk)
        await ymodemSend(q, write, name, data, (bytes, total) =>
          this.tr(panelId, { state: 'progress', protocol: p.protocol, dir: 'send', name, bytes, total })
        )
      } else {
        await zmodemSend(
          (consume) => {
            s.rawConsumer = consume
          },
          write,
          name,
          data,
          (bytes, total) =>
            this.tr(panelId, { state: 'progress', protocol: p.protocol, dir: 'send', name, bytes, total })
        )
      }
    })()

    try {
      await Promise.race([work, cancelPromise])
      this.tr(panelId, { state: 'done', protocol: p.protocol, dir: 'send', name, bytes: data.length, total: data.length })
      return { ok: true }
    } catch (err) {
      const cancelled = err instanceof TransferCancelled
      this.tr(panelId, {
        state: cancelled ? 'cancel' : 'error',
        protocol: p.protocol,
        dir: 'send',
        name,
        bytes: 0,
        total: data.length,
        error: cancelled ? undefined : err instanceof Error ? err.message : String(err)
      })
      return { ok: false, error: cancelled ? '已取消' : err instanceof Error ? err.message : String(err) }
    } finally {
      s.rawConsumer = null
      transfers.delete(panelId)
    }
  }

  private async fileRecv(panelId: string, p: { protocol: TransferProtocol; dir: string }): Promise<{ ok: boolean; error?: string; saved?: string[] }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    if (transfers.has(panelId)) return { ok: false, error: '已有传输进行中' }
    const write = (buf: Buffer): void => {
      s.port.write(buf)
      s.txBytes += buf.length
    }
    this.tr(panelId, { state: 'start', protocol: p.protocol, dir: 'recv', name: '', bytes: 0, total: 0 })

    let cancelReject: (() => void) | null = null
    const cancelPromise = new Promise<never>((_resolve, reject) => {
      cancelReject = reject
    })
    const q = new ByteQueue()
    transfers.set(panelId, {
      protocol: p.protocol,
      dir: 'recv',
      cancel: () => {
        q.cancel()
        cancelReject?.()
      }
    })

    const work = (async () => {
      if (p.protocol === 'ymodem') {
        s.rawConsumer = (chunk) => q.feed(chunk)
        return ymodemRecv(q, write, (name, bytes, total) =>
          this.tr(panelId, { state: 'progress', protocol: p.protocol, dir: 'recv', name, bytes, total })
        )
      }
      return zmodemRecv(
        (consume) => {
          s.rawConsumer = consume
        },
        write,
        (name, bytes, total) =>
          this.tr(panelId, { state: 'progress', protocol: p.protocol, dir: 'recv', name, bytes, total })
      )
    })()

    try {
      const files = (await Promise.race([work, cancelPromise])) as { name: string; data: Buffer }[]
      // 收到的文件去重命名后写入目标目录
      const saved: string[] = []
      for (const f of files) {
        const safe = f.name.replace(/[/\\]/g, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/^\./, '_') || `recv-${Date.now()}`
        let target = join(p.dir, safe)
        let n = 1
        // 重名自动加 -1 / -2 …
        for (;;) {
          try {
            await fs.access(target)
            const dot = safe.lastIndexOf('.')
            target = join(p.dir, dot > 0 ? `${safe.slice(0, dot)}-${n}${safe.slice(dot)}` : `${safe}-${n}`)
            n++
          } catch {
            break
          }
        }
        await fs.writeFile(target, f.data)
        saved.push(target)
      }
      this.tr(panelId, {
        state: 'done',
        protocol: p.protocol,
        dir: 'recv',
        name: saved.map((x) => basename(x)).join(', '),
        bytes: saved.length,
        total: saved.length
      })
      return { ok: true, saved }
    } catch (err) {
      const cancelled = err instanceof TransferCancelled
      this.tr(panelId, {
        state: cancelled ? 'cancel' : 'error',
        protocol: p.protocol,
        dir: 'recv',
        name: '',
        bytes: 0,
        total: 0,
        error: cancelled ? undefined : err instanceof Error ? err.message : String(err)
      })
      return { ok: false, error: cancelled ? '已取消' : err instanceof Error ? err.message : String(err) }
    } finally {
      s.rawConsumer = null
      transfers.delete(panelId)
    }
  }

  private fileCancel(panelId: string): { ok: boolean } {
    const t = transfers.get(panelId)
    if (!t) return { ok: false }
    t.cancel()
    // 附加 CAN×8 通知远端放弃
    const s = sessions.get(panelId)
    if (s) {
      s.port.write(Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]))
    }
    return { ok: true }
  }
}

export const serialService = new SerialService()
