/**
 * 串口助手服务（多实例：panelId -> 会话）
 * 高波特率防卡 UI：主进程按 80ms 批量合并接收数据后一次性推送
 */
import { SerialPort } from 'serialport'
import { StringDecoder } from 'node:string_decoder'
import { dialog, app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SerialConfig, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { DEFAULT_SERIAL_CONFIG } from '../../../shared/serial'
import { getSection, setSection } from '../macro/configStore'
import { ByteQueue, TransferCancelled, ymodemRecv, ymodemSend } from './ymodem'
import { zmodemRecv, zmodemSend } from './zmodem'

interface RxPiece {
  buf: Buffer
  time: number
}

interface SerialSession {
  port: SerialPort
  params: SerialParams
  rxBytes: number
  txBytes: number
  pending: RxPiece[]
  decoder: StringDecoder
  flushTimer: NodeJS.Timeout | null
  /** 自动日志：持久句柄 + 内存缓冲批量写（避免每周期 open/close 文件触发杀毒扫描阻塞事件循环） */
  logHandle: FileHandle | null
  logBuf: string[]
  /** 低流量时周期性落盘（500ms），防止日志长时间滞留内存 */
  logTimer: NodeJS.Timeout | null
  /** 文件传输占用时的原始消费方（绕过 80ms 批量通道） */
  rawConsumer: ((chunk: Buffer) => void) | null
}

/** 进行中的传输（每面板最多一个） */
interface ActiveTransfer {
  protocol: TransferProtocol
  dir: 'send' | 'recv'
  cancel: () => void
}

const sessions = new Map<string, SerialSession>()
const transfers = new Map<string, ActiveTransfer>()
/** 批量合并窗口：16ms ≈ 60fps，刷屏视觉流畅；合并仍吸收高波特率的碎片事件 */
const FLUSH_MS = 16

/** 自动日志目录：userData/serial-logs/ */
function serialLogDir(): string {
  return join(app.getPath('userData'), 'serial-logs')
}

function fmtLogTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

class SerialService implements ToolService {
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('serial', panelId, type, payload)
  }

  /** 日志入缓冲（真正落盘在 flushLog；写失败静默停日志，不影响收发） */
  private appendLog(s: SerialSession, dir: 'RX' | 'TX' | 'INFO', body: string): void {
    if (!s.logHandle) return
    s.logBuf.push(`[${fmtLogTime(Date.now())}] ${dir.padEnd(4)} ${body}\r\n`)
  }

  /** 日志落盘：串口会话断开或缓冲超限时把缓冲一次性写入持久句柄 */
  private async flushLog(s: SerialSession): Promise<void> {
    if (!s.logHandle || s.logBuf.length === 0) return
    const batch = s.logBuf
    s.logBuf = []
    try {
      await s.logHandle.appendFile(batch.join(''), 'utf8')
    } catch {
      // 写失败一次即停日志，避免反复报错拖慢收发
      await s.logHandle.close().catch(() => {})
      s.logHandle = null
    }
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
    if (s.logHandle) {
      // 转义只在日志开启时做（关闭时不白白跑正则）
      this.appendLog(s, 'RX', text.replace(/[\r\n\t]/g, (c) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' })[c] ?? c))
      // 缓冲超过 64 行立即落盘，防止长时间刷屏积压内存
      if (s.logBuf.length >= 64) void this.flushLog(s)
    }
    this.emit(panelId, 'data', {
      text,
      bytes: total.length,
      time: pieces[0].time,
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
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
      case 'open':
        return this.open(panelId, payload as SerialParams)
      case 'close':
        return this.close(panelId)
      case 'write':
        return this.write(panelId, payload as { mode: 'ascii' | 'hex'; text: string; newline: 'none' | 'crlf' | 'lf' | 'cr' })
      case 'dtr':
        return this.setFlow(panelId, { dtr: Boolean((payload as { on: boolean }).on) })
      case 'rts':
        return this.setFlow(panelId, { rts: Boolean((payload as { on: boolean }).on) })
      case 'signals':
        return this.signals(panelId)
      case 'log:save':
        return this.saveLog(panelId, payload as { content: string; name?: string })
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
  dispose(panelId: string): void {
    if (sessions.has(panelId)) void this.close(panelId)
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
  private tryOpen(panelId: string, params: SerialParams, cfg: SerialConfig): Promise<Error | null> {
    return new Promise((resolve) => {
      // 注意：autoOpen:false 时构造器回调会被 stream 层静默丢弃，
      // 回调必须挂在 port.open() 上，否则 Promise 永不 resolve（UI 永远"打开中"）
      const port = new SerialPort(
        {
          path: params.path,
          baudRate: params.baudRate,
          dataBits: params.dataBits,
          stopBits: params.stopBits,
          parity: params.parity,
          rtscts: params.rtscts,
          autoOpen: false
        },
        () => {}
      )
      port.on('error', (err: Error) => {
        this.emit(panelId, 'error', { message: err.message })
      })
      port.open(async (err) => {
        if (err) {
          resolve(err)
          return
        }
        // 自动日志：userData/serial-logs/<COM>-<日期>.log，持久句柄 + 批量落盘
        // （每周期 fs.appendFile 会反复 open/close 触发杀毒扫描，拖垮高吞吐刷屏）
        let logHandle: FileHandle | null = null
        if (cfg.autoLog) {
          try {
            await fs.mkdir(serialLogDir(), { recursive: true })
            const logPath = join(
              serialLogDir(),
              `${params.path.replace(/[^a-zA-Z0-9]/g, '')}-${new Date().toISOString().slice(0, 10)}.log`
            )
            logHandle = await fs.open(logPath, 'a')
            await logHandle.appendFile(
              `\r\n[${fmtLogTime(Date.now())}] INFO ===== 打开 ${params.path} @ ${params.baudRate} =====\r\n`,
              'utf8'
            )
          } catch {
            await logHandle?.close().catch(() => {})
            logHandle = null
          }
        }
        sessions.set(panelId, {
          port,
          params,
          rxBytes: 0,
          txBytes: 0,
          pending: [],
          decoder: new StringDecoder('utf8'),
          flushTimer: null,
          logHandle,
          logBuf: [],
          logTimer: null,
          rawConsumer: null
        })
        // 低流量场景：周期性把日志缓冲落盘
        if (logHandle) {
          const session = sessions.get(panelId)!
          session.logTimer = setInterval(() => {
            const cur = sessions.get(panelId)
            if (cur) void this.flushLog(cur)
          }, 500)
        }
        this.emitStatus(panelId)
        resolve(null)
      })
      port.on('data', (chunk: Buffer) => {
        const s = sessions.get(panelId)
        if (!s) return
        s.rxBytes += chunk.length
        // 文件传输期间：原始字节直通协议引擎，不走批量/终端/日志通道
        if (s.rawConsumer) {
          s.rawConsumer(chunk)
          return
        }
        s.pending.push({ buf: chunk, time: Date.now() })
        if (!s.flushTimer) {
          s.flushTimer = setTimeout(() => {
            const cur = sessions.get(panelId)
            if (cur) cur.flushTimer = null
            this.flush(panelId)
          }, FLUSH_MS)
        }
      })
      port.on('close', () => {
        const s = sessions.get(panelId)
        if (s) {
          if (s.flushTimer) {
            clearTimeout(s.flushTimer)
            s.flushTimer = null
          }
          if (s.logTimer) {
            clearInterval(s.logTimer)
            s.logTimer = null
          }
          // 端口意外关闭（拔线等）：冲掉日志缓冲并释放句柄
          void this.flushLog(s).finally(() => {
            void s.logHandle?.close().catch(() => {})
            s.logHandle = null
          })
        }
        sessions.delete(panelId)
        this.emitStatus(panelId)
      })
    })
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
    // 传输进行中断开：先取消，避免协议引擎挂在死流上
    this.fileCancel(panelId)
    const s = sessions.get(panelId)
    if (!s) return { ok: true }
    s.rawConsumer = null
    // 先冲掉尾部数据并清掉挂起的 flush 定时器，再移除会话（flush 依赖会话存在）
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      s.flushTimer = null
    }
    this.flush(panelId)
    this.appendLog(s, 'INFO', '===== 断开 =====')
    // 日志：清定时器、冲掉缓冲并关闭句柄（会话结束后不再有数据）
    if (s.logTimer) {
      clearInterval(s.logTimer)
      s.logTimer = null
    }
    await this.flushLog(s)
    await s.logHandle?.close().catch(() => {})
    s.logHandle = null
    sessions.delete(panelId)
    await new Promise<void>((resolve) => {
      if (!s.port.isOpen) resolve()
      else s.port.close((err) => (err ? resolve() : resolve()))
    })
    // 'close' 事件会再发一次 status（open:false）
    return { ok: true }
  }

  private write(
    panelId: string,
    p: { mode: 'ascii' | 'hex'; text: string; newline: 'none' | 'crlf' | 'lf' | 'cr' }
  ): { ok: boolean; error?: string; bytes?: number } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    // 与渲染端相同的组包规则（主进程兜底解析）
    let buf: Buffer
    if (p.mode === 'hex') {
      const compact = p.text.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
      if (compact.length === 0) return { ok: false, error: 'HEX 内容为空' }
      if (compact.length % 2 !== 0) return { ok: false, error: 'HEX 长度须为偶数' }
      buf = Buffer.from(compact, 'hex')
    } else {
      const nl = p.newline === 'crlf' ? '\r\n' : p.newline === 'lf' ? '\n' : p.newline === 'cr' ? '\r' : ''
      buf = Buffer.from(p.text + nl, 'utf8')
    }
    if (buf.length === 0) return { ok: false, error: '发送内容为空' }
    s.port.write(buf)
    s.txBytes += buf.length
    this.appendLog(s, 'TX', buf.toString('utf8').replace(/[\r\n\t]/g, (c) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' })[c] ?? c))
    this.emit(panelId, 'tx', {
      text: buf.toString('utf8'),
      bytes: buf.length,
      time: Date.now(),
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
    return { ok: true, bytes: buf.length }
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

  private async saveLog(panelId: string, p: { content: string; name?: string }): Promise<{ ok: boolean; error?: string }> {
    // 文件名带时分秒，以创建时间为准；目录用记忆的保存目录（重启记忆）
    const cfg = await getSection<SerialConfig>('serial', DEFAULT_SERIAL_CONFIG)
    const stamp = new Date()
    const p2 = (n: number, w = 2): string => n.toString().padStart(w, '0')
    const defaultName =
      p.name ??
      `serial-${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.log`
    const baseDir = cfg.logDir || serialLogDir()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存串口日志',
      defaultPath: join(baseDir, defaultName),
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: false, error: '已取消' }
    try {
      await fs.writeFile(filePath, p.content, 'utf8')
      // 记住本次保存目录，下次默认打开这里（重启记忆）
      const dir = dirname(filePath)
      if (dir && dir !== cfg.logDir) {
        cfg.logDir = dir
        await setSection('serial', cfg)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
