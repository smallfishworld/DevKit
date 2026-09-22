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
import { cleanLogBody, fileNameStamp, fmtStamp, splitTerminalLines } from '../../../shared/logtext'

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
  /** 日志管道的未完行尾巴（最后一个 \n 之后的内容；未完行/半个 \r\r\n 终止符/跨批 ANSI 序列滞留于此） */
  logCarry: string
  /** 内存全量日志（「存日志」导出源）：整行按 MEM_CHUNK_PIECES 行聚成的大块 Buffer。
   *  放主进程且存 Buffer（V8 堆外）：此前放渲染端按字符串累积，长会话涨到数百 MB 后
   *  渲染端 V8 大 GC 频繁暂停主线程——表现为长时间使用后终端打印断断续续，
   *  重开串口（清掉累积）后恢复。Buffer 背储在堆外不参与 GC，彻底消除该退化 */
  memBuf: Buffer[]
  /** 未封块的行累积（凑满 MEM_CHUNK_PIECES 行再成块，避免按行一 Buffer 对象） */
  pendingMem: string
  /** pendingMem 已累积行数 */
  memPieces: number
  /** 内存全量日志累计字节（UTF-8 实际大小） */
  memBytes: number
  /** 超限后置位：停止记录（渲染端收到事件后同时停止终端显示） */
  memFull: boolean
}

/** 进行中的传输（每面板最多一个） */
interface ActiveTransfer {
  protocol: TransferProtocol
  dir: 'send' | 'recv'
  cancel: () => void
}

const sessions = new Map<string, SerialSession>()
/** 断开后留存的内存全量日志（按 panelId）：会话关闭后「存日志」仍可导出，
 *  重开串口（新会话）时移除——等价旧渲染端实现里「断开后 ringBuf 仍在」的行为 */
interface RetainedMem {
  /** 拼成单 Buffer 的完整日志内容 */
  buf: Buffer
  /** 文件名用串口名（断开后会话已删，params 不可再取） */
  path: string
}
const retainedMem = new Map<string, RetainedMem>()

/** 会话结束（正常关/拔线）时留存内存日志，供断开后「存日志」导出 */
function retainMemLog(panelId: string, s: SerialSession): void {
  // 先把未封块的行封成块再留存（漏封会丢尾部内容）
  if (s.pendingMem) {
    s.memBuf.push(Buffer.from(s.pendingMem, 'utf8'))
    s.pendingMem = ''
    s.memPieces = 0
  }
  if (s.memBuf.length > 0) {
    retainedMem.set(panelId, { buf: Buffer.concat(s.memBuf), path: s.params.path })
  }
  s.memBuf = []
  s.memBytes = 0
}
const transfers = new Map<string, ActiveTransfer>()
/** 批量合并窗口：16ms ≈ 60fps，刷屏视觉流畅；合并仍吸收高波特率的碎片事件 */
const FLUSH_MS = 16
/** 内存全量日志上限（字节，UTF-8 实际大小）；超限停止记录并提示先存日志 */
const MEM_LOG_LIMIT = 500 * 1024 * 1024

/** 内存日志攒块阈值：行凑满 256 段拼成单块 Buffer，控制 Buffer 对象数量
 *  （按行一对象时 500MB 日志会产生千万级 JS 堆对象，把 GC 压力转回主进程） */
const MEM_CHUNK_PIECES = 256

/** 自动日志目录：userData/serial-logs/ */
function serialLogDir(): string {
  return join(app.getPath('userData'), 'serial-logs')
}

/** 日志行时间戳（与终端显示一致）：HH:MM:SS.mmm；落盘带日期（跨天可辨）：YYYY-MM-DD HH:MM:SS.mmm */
function fmtLogTime(t: number, withDate = false): string {
  return fmtStamp(t, withDate)
}

class SerialService implements ToolService {
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('serial', panelId, type, payload)
  }

  /** 日志入缓冲（真正落盘在 flushLog；写失败静默停日志，不影响收发）。
   *  入参为已按完整行切分的原始行（不含终止符），清洗后逐行补时间戳（每行可辨；带日期，跨天可追溯）。
   *  空行照常落盘（设备真实空行可追溯）。
   *  同格式整行始终累积进内存全量日志 memBuf（自动落盘关闭/失败时仍可「存日志」导出）；
   *  行先拼进 pendingMem 字符串，攒满一段再 Buffer.from 成块（大块存储，见 MEM_CHUNK_PIECES） */
  private appendLog(panelId: string, s: SerialSession, parts: string[]): void {
    if (parts.length === 0) return
    const stamp = fmtLogTime(Date.now(), true)
    for (const part of parts) {
      for (const line of cleanLogBody(part).split('\n')) {
        const piece = `[${stamp}] ${line}\r\n`
        if (!s.memFull) {
          s.pendingMem += piece
          s.memPieces += 1
          if (s.memPieces >= MEM_CHUNK_PIECES) {
            this.sealMemChunk(panelId, s)
          } else {
            s.memBytes += Buffer.byteLength(piece, 'utf8')
            if (s.memBytes > MEM_LOG_LIMIT) this.tripMemFull(panelId, s)
          }
        }
        if (s.logHandle) s.logBuf.push(piece)
      }
    }
  }

  /** 把 pendingMem 字符串封成一块 Buffer 入 memBuf（memBytes 以封块时实测为准） */
  private sealMemChunk(panelId: string, s: SerialSession): void {
    if (!s.pendingMem) return
    const b = Buffer.from(s.pendingMem, 'utf8')
    s.pendingMem = ''
    s.memPieces = 0
    s.memBuf.push(b)
    s.memBytes += b.length
    if (s.memBytes > MEM_LOG_LIMIT) this.tripMemFull(panelId, s)
  }

  /** 内存日志达上限：停记录（pendingMem 残留丢弃）并通知渲染端停显 */
  private tripMemFull(panelId: string, s: SerialSession): void {
    s.memFull = true
    s.pendingMem = ''
    s.memPieces = 0
    this.emit(panelId, 'memlog', { full: true })
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
    // 按完整行切分：最后一个 \n 之前处理，之后（未完行/半个 \r\r\n 终止符）留给下一批拼接，
    // 终止符跨批不产生幻影空行；跨批 ANSI 序列也在 carry 中。
    // 切分不再只随磁盘日志走（内存全量日志总是开）
    const { lines, carry } = splitTerminalLines(s.logCarry + text)
    s.logCarry = carry
    this.appendLog(panelId, s, lines)
    // 缓冲超过 64 行立即落盘，防止长时间刷屏积压内存
    if (s.logHandle && s.logBuf.length >= 64) void this.flushLog(s)
    this.emit(panelId, 'data', {
      text,
      bytes: total.length,
      time: pieces[0].time,
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
  }

  /** 更换日志目录时：对打开中的会话立刻轮转 —— 冲掉旧句柄并在新目录重开新文件（时间戳以轮转时刻为准） */
  private async rotateLogs(dir: string): Promise<void> {
    for (const s of sessions.values()) {
      if (!s.logHandle) continue
      // 冲缓冲、关旧句柄（flushLog 写失败时会把句柄置空，须空安全）
      await this.flushLog(s)
      await s.logHandle?.close().catch(() => {})
      s.logHandle = null
      if (!s.logTimer) continue
      // 新目录重开
      try {
        await fs.mkdir(dir, { recursive: true })
        const logPath = join(dir, `${s.params.path.replace(/[^a-zA-Z0-9]/g, '')}-${fileNameStamp()}.log`)
        s.logHandle = await fs.open(logPath, 'a')
        await s.logHandle.appendFile(`\r\n[${fmtLogTime(Date.now())}] INFO ===== 日志目录切换，续写至 ${dir} =====\r\n`, 'utf8')
      } catch {
        s.logHandle = null
        clearInterval(s.logTimer!)
        s.logTimer = null
      }
    }
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
      case 'log:mem-save':
        return this.saveMemLog(panelId)
      case 'log:mem-clear':
        this.clearMemLog(panelId)
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
        // 自动日志：<配置目录 或 userData/serial-logs>/<COM>-<创建时刻 YYYYMMDD-HHMMSS>.log
        // 持久句柄 + 批量落盘（每周期 fs.appendFile 会反复 open/close 触发杀毒扫描，拖垮高吞吐刷屏）
        let logHandle: FileHandle | null = null
        if (cfg.autoLog) {
          try {
            const logDir = cfg.logDir || serialLogDir()
            await fs.mkdir(logDir, { recursive: true })
            const logPath = join(
              logDir,
              `${params.path.replace(/[^a-zA-Z0-9]/g, '')}-${fileNameStamp()}.log`
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
        // 新会话：旧留存日志作废（重开串口 = 新一轮记录）
        retainedMem.delete(panelId)
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
          rawConsumer: null,
          logCarry: '',
          memBuf: [],
          pendingMem: '',
          memPieces: 0,
          memBytes: 0,
          memFull: false
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
          // 端口意外关闭（拔线等）：冲掉日志缓冲并释放句柄；内存全量日志留存供断开后导出
          retainMemLog(panelId, s)
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
    // 冲出未完行尾巴（提示符等；纯 \r 残留尾巴跳过，避免落盘多余空行）
    const tail = s.logCarry
    s.logCarry = ''
    if (tail.replace(/\r/g, '')) this.appendLog(panelId, s, [tail])
    this.appendLog(panelId, s, ['===== 断开 ====='])
    // 日志：清定时器、冲掉缓冲并关闭句柄（会话结束后不再有数据）
    if (s.logTimer) {
      clearInterval(s.logTimer)
      s.logTimer = null
    }
    await this.flushLog(s)
    await s.logHandle?.close().catch(() => {})
    s.logHandle = null
    // 留存内存全量日志供断开后「存日志」导出，再移除会话
    retainMemLog(panelId, s)
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
    // HEX 发送按字节审计记录（二进制过 toString('utf8') 会把 0x1b 当 ANSI 剥掉、非法字节变 U+FFFD）
    this.appendLog(panelId, s, [p.mode === 'hex' ? buf.toString('hex').replace(/../g, '$& ').trim() : buf.toString('utf8')])
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

  private async saveLog(
    panelId: string,
    p: { content: string | Buffer; name?: string }
  ): Promise<{ ok: boolean; error?: string }> {
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
      // 记住本次保存目录，下次默认打开这里（重启记忆）；
      // 同时让打开中的会话自动日志立刻轮转到新目录
      const dir = dirname(filePath)
      if (dir && dir !== cfg.logDir) {
        cfg.logDir = dir
        await setSection('serial', cfg)
        await this.rotateLogs(cfg.logDir)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 导出内存全量日志（「存日志」）：Buffer 直拼直写，不经渲染端（满 500MB 也不占渲染端内存）。
   *  会话已断开时回落到断开时留存的内容（断开后仍可导出本次会话日志） */
  private async saveMemLog(panelId: string): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    let content: Buffer | undefined
    let path: string
    if (s) {
      // 封块后拼装（不改动会话自身状态；memBuf 继续可追加）
      const chunks = [...s.memBuf]
      if (s.pendingMem) chunks.push(Buffer.from(s.pendingMem, 'utf8'))
      content = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      path = s.params.path
    } else {
      const r = retainedMem.get(panelId)
      content = r?.buf
      path = r?.path ?? ''
    }
    if (!content || content.length === 0) return { ok: false, error: '无日志可存' }
    // 文件名 serial-<COM>-<时刻 YYYYMMDD-HHMMSS>.log（与原渲染端命名一致）
    const safeName = path.replace(/[\\/:*?"<>|]/g, '_') || 'com'
    return this.saveLog(panelId, { content, name: `serial-${safeName}-${fileNameStamp()}.log` })
  }

  /** 清空内存全量日志（终端「清空」联动解除溢出锁定；重开串口 = 新会话自动重置） */
  private clearMemLog(panelId: string): void {
    retainedMem.delete(panelId)
    const s = sessions.get(panelId)
    if (!s) return
    s.memBuf = []
    s.pendingMem = ''
    s.memPieces = 0
    s.memBytes = 0
    s.memFull = false
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
    // 打开中的会话立刻轮转到新目录（新文件马上出现在新路径下）
    await this.rotateLogs(cfg.logDir)
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
