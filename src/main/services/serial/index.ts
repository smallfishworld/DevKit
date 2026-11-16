/**
 * 串口助手服务（多实例：panelId -> 会话）
 * 高波特率防卡 UI：主进程按 32ms 批量合并接收数据后一次性推送
 */
import { SerialPort } from 'serialport'
import { StringDecoder } from 'node:string_decoder'
import * as iconv from 'iconv-lite'
import { dialog, app, shell, powerSaveBlocker } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent, setWindowBackgroundThrottling } from '../../ipc'
import type { SerialConfig, SerialEncoding, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { DEFAULT_SERIAL_CONFIG } from '../../../shared/serial'
import { getSection, setSection } from '../macro/configStore'
import { ByteQueue, TransferCancelled, ymodemRecv, ymodemSend } from './ymodem'
import { zmodemRecv, zmodemSend } from './zmodem'
import { TerminalRuntime } from '../terminal/runtime'
import { fmtDuration, txAuditLine } from '../../../shared/logtext'
import { DeviceActionLines, runDeviceAction, SerialSecretRedactor } from './device-actions'
import type { DeviceActionResult, DeviceActionStage, WaitVerdictInput } from './device-actions'
import { isTriggerWord, matchChallengeLine } from './device-action-match'
import { parseDeviceActionsConfig } from './device-actions-config'
import type { DeviceActionHold, DeviceActionProfile } from './device-actions-config'
import { deviceActionsFilePath, readDeviceActionsFile, writeDeviceActionsFile } from './device-actions-store'
import { loadDeviceActionProvider } from './device-actions-provider'
import type { DeviceActionProvider } from './device-actions-provider'

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
  /** 系统休眠开始时刻（唤醒时算时长并在日志标注；null = 未处于休眠） */
  suspendedAt: number | null
  /** The host may deliver data buffered by the USB driver around resume. */
  suspendedDataNoted: boolean
  wakeBurstNotePending: boolean
  wakeBurstNoted: boolean
  action?: {
    controller: AbortController
    locked: boolean
    receive?: (text: string, receivedAt: number) => void
  }
  /** 自动应答监听：串口输出持续喂给行匹配器，命中特征码即发起动作 */
  watch?: {
    provider: DeviceActionProvider
    profiles: DeviceActionProfile[]
    lines: DeviceActionLines
    busy: boolean
  }
  /** 自动应答期间的输入保持：判定接受才回放，拒绝/超时丢弃 */
  hold?: {
    chunks: { buf: Buffer; audit: string }[]
    bytes: number
    maxBytes: number
    timer: NodeJS.Timeout
  }
  secrets?: SerialSecretRedactor
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

export class SerialService implements ToolService {
  constructor(private readonly actionProvider: () => Promise<DeviceActionProvider> = loadDeviceActionProvider) {}

  private runtime = new TerminalRuntime('serial')
  private powerBlockerId: number | null = null
  private viewVisible = new Map<string, boolean>()
  private resumeHold = new Set<string>()
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Briefly absorb the burst delivered by Windows USB drivers after wake. */
  private static readonly WAKE_SETTLE_MS = 1200

  private applyViewVisibility(id: string): void {
    this.runtime.setVisible(id, this.viewVisible.get(id) !== false && !this.resumeHold.has(id))
  }

  private cancelResumeHold(id: string): void {
    const timer = this.resumeTimers.get(id)
    if (timer) clearTimeout(timer)
    this.resumeTimers.delete(id)
    this.resumeHold.delete(id)
  }

  private releaseResumeHold(id: string): void {
    this.resumeTimers.delete(id)
    // Account for bytes already delivered to our 32 ms RX queue before ending
    // the uncertainty window; otherwise its closing marker could precede data.
    const session = sessions.get(id)
    if (session?.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
    this.flush(id)
    if (session?.wakeBurstNoted)
      this.runtime.note(id, '===== 唤醒后接收时间不确定窗口结束 =====')
    if (session) { session.wakeBurstNotePending = false; session.wakeBurstNoted = false }
    this.resumeHold.delete(id)
    this.applyViewVisibility(id)
  }

  /** Prevent automatic idle sleep while any serial session is capturing. */
  private syncCapturePower(): void {
    setWindowBackgroundThrottling(sessions.size === 0)
    if (sessions.size && this.powerBlockerId === null) {
      this.powerBlockerId = powerSaveBlocker?.start?.('prevent-app-suspension') ?? null
    } else if (!sessions.size && this.powerBlockerId !== null) {
      powerSaveBlocker?.stop?.(this.powerBlockerId)
      this.powerBlockerId = null
    }
  }
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
    s.pendingBytes = 0
    // Every serial data callback has its own host receipt time. Preserve
    // timestamps across the 32 ms group instead of stamping every line at the
    // timer's flush time. These are never device-generation timestamps.
    if (s.suspendedAt !== null && !s.suspendedDataNoted) {
      this.runtime.note(panelId, '===== 休眠/唤醒交界收到的数据：设备产生时间不确定；以下时间戳为主机接收时间 =====')
      s.suspendedDataNoted = true
    } else if (s.wakeBurstNotePending) {
      this.runtime.note(panelId, '===== 唤醒后驱动积压数据：设备产生时间不确定；以下时间戳为主机接收时间 =====')
      s.wakeBurstNotePending = false
      s.wakeBurstNoted = true
    }
    const decoded: Array<{ text: string; receivedAt: number }> = []
    for (const piece of pieces) {
      const text = s.decoder.write(piece.buf)
      if (!text) continue
      if (s.watch) this.watchLines(panelId, s, text, piece.time)
      s.action?.receive?.(text, piece.time)
      if (s.secrets) s.secrets.push(text, piece.time, (part, receivedAt) => decoded.push({ text: part, receivedAt }))
      else decoded.push({ text, receivedAt: piece.time })
    }
    // Disk records keep per-callback times; the renderer still receives one
    // coalesced output per 32 ms batch, preserving the existing UI throughput.
    if (decoded.length) this.runtime.dataTimed(panelId, decoded)
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    if (action === 'output:clear' || action === 'log:mem-clear') {
      // The serial RX batch belongs to the OLD screen if it reached the app
      // before the user's clear action. Drain it synchronously first.
      const session = sessions.get(panelId)
      if (session?.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
      this.flush(panelId)
      this.runtime.note(panelId, '===== 用户清空终端显示（历史日志继续保留） =====')
      this.runtime.clearDisplay(panelId)
      return { ok: true }
    }
    if (this.runtime.handles(action)) return this.runtime.invoke(panelId, action, payload)
    switch (action) {
      case 'action:profiles':
        return this.actionProvider().then(({ config }) => ({
          profiles: config.profiles.map(({ id, label, actionLabel, trigger }) => ({
            id, label, actionLabel, trigger
          })),
          armed: !!sessions.get(panelId)?.watch
        })).catch((error: Error) => ({ profiles: [], armed: false, error: error.message }))
      case 'action:watch':
        return this.setWatch(panelId, (payload as { enabled?: unknown } | undefined)?.enabled === true)
      case 'action:run':
        return this.startDeviceAction(panelId, (payload as { profile?: unknown } | undefined)?.profile)
      case 'action:cancel':
        sessions.get(panelId)?.action?.controller.abort(new Error('已取消设备动作'))
        return true
      case 'device-config:info':
        return readDeviceActionsFile(app.getPath('userData'))
      case 'device-config:validate':
        return this.validateDeviceConfig((payload as { config?: unknown } | undefined)?.config)
      case 'device-config:save':
        return this.saveDeviceConfig((payload as { config?: unknown } | undefined)?.config)
      case 'device-config:open-dir':
        return this.openDeviceConfigDir()
      case 'view:visible':
        this.viewVisible.set(panelId, Boolean((payload as { visible: boolean }).visible))
        this.applyViewVisibility(panelId)
        return { ok: true }
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
      case 'log:note':
        return this.noteLog(panelId, (payload as { text: string }).text)
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
      try { await this.close(id) } finally { await this.runtime.dispose(id); this.runtime.forgetVisible(id); this.viewVisible.delete(id); this.cancelResumeHold(id) }
    })))
  }

  /**
   * 渲染端的可追溯备注（回滚保护拦下破坏性序列、设备切备用屏等）：写进日志通道。
   * 这类事件对应的原序列在渲染前就被剥掉/放行，不记这条的话用户在日志里找不到任何线索。
   * 走 runtime.note：先终结未完行再整行落盘；txAuditLine 把控制字符转成可见字面量，
   * 保证一次备注 = 一行日志（否则一个 \r 会被换行归一拆成两行）。
   */
  private noteLog(panelId: string, text: string): { ok: boolean } {
    if (!text) return { ok: false }
    this.runtime.note(panelId, `[DevKit] ${txAuditLine(text)}`)
    return { ok: true }
  }

  /**
   * 系统进入休眠（powerMonitor 'suspend'）：在日志标注，并记下时刻用于唤醒时算时长。
   * 休眠期间进程被冻结，收不到任何数据；USB 转串口芯片 FIFO 溢出丢字节是硬件行为，软件补不回来。
   */
  onSystemSuspend(): void {
    const now = Date.now()
    for (const [panelId, s] of sessions) {
      s.action?.controller.abort(new Error('系统进入休眠，设备动作已终止'))
      this.releaseHold(panelId, s, false)
      // Flush already received bytes before the sleep marker, otherwise a pending
      // 32 ms batch can appear *after* the suspend timestamp in the disk log.
      if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
      this.flush(panelId)
      s.suspendedAt = now
      s.suspendedDataNoted = false
      s.wakeBurstNotePending = false
      s.wakeBurstNoted = false
      this.runtime.note(panelId, '===== 系统休眠 =====')
      this.resumeHold.add(panelId)
      this.applyViewVisibility(panelId)
    }
  }

  /**
   * 系统唤醒（powerMonitor 'resume'）：
   * - 日志标注休眠时长，便于事后定位"为什么这里缺了一段"；
   * - 不自动清除驱动缓存：尽量保存唤醒后仍可读取的所有数据。
   *   实测唤醒瞬间会一次性吐出几百 KB 的重复/残片（曾见单批 6611 行、单行 2.7KB 无终止符），
   *   用现有分帧与 ACK 水位消化积压，保持数据顺序和 VT 解析状态；
   * - 保持原终端解析与回滚；不自动重开或复位设备。
   */
  onSystemResume(): void {
    const now = Date.now()
    for (const [panelId, s] of sessions) {
      // Capture data already delivered by the OS before writing the wake marker.
      if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
      this.flush(panelId)
      const gap = s.suspendedAt === null ? 0 : now - s.suspendedAt
      s.suspendedAt = null
      s.suspendedDataNoted = false
      // A freshly resumed USB driver can expose data produced before wake.
      // We cannot infer device production timestamps from host RX callbacks.
      s.wakeBurstNotePending = gap >= 30_000
      s.wakeBurstNoted = false
      this.runtime.note(
        panelId,
        gap > 0
          ? `===== 系统唤醒（休眠 ${fmtDuration(gap)}；主机接收时间不代表设备产生时间） =====`
          : '===== 系统唤醒 ====='
      )
      // Preserve the terminal parser and scrollback while processing driver output.
      this.emit(panelId, 'resume', { gapMs: gap })
      this.cancelResumeHold(panelId)
      if (gap >= 30_000) {
        this.resumeHold.add(panelId)
        this.applyViewVisibility(panelId)
        this.resumeTimers.set(panelId, setTimeout(
          () => this.releaseResumeHold(panelId), SerialService.WAKE_SETTLE_MS
        ))
      } else this.applyViewVisibility(panelId)
    }
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
      flushTimer: null, rawConsumer: null, suspendedAt: null,
      suspendedDataNoted: false, wakeBurstNotePending: false, wakeBurstNoted: false
    }
    try {
      await this.runtime.start(panelId, {
        dir: cfg.logDir || serialLogDir(), name: params.path, temporary: !cfg.autoLog,
        keepParsingWhenHidden: true,
        pause: (paused) => {
          // Without RTS/CTS, keep capturing to disk; pausing the host cannot stop the device.
          if (sessions.get(panelId) !== session || !params.rtscts) return
          if (paused) port.pause(); else port.resume()
        },
        fatal: () => { void this.runtime.tasks.run(panelId, () => this.close(panelId)).catch(() => {}) },
        stats: () => ({ rxBytes: session.rxBytes, txBytes: session.txBytes })
      })
      sessions.set(panelId, session)
      this.syncCapturePower()
      this.applyViewVisibility(panelId)
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
      this.syncCapturePower()
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
    s.action?.controller.abort(new Error('串口已断开，设备动作已终止'))
    delete s.watch
    this.releaseHold(panelId, s, false)
    if (s.flushTimer) clearTimeout(s.flushTimer)
    s.flushTimer = null
    this.flush(panelId)
    const tail = s.decoder.end()
    if (s.secrets) {
      if (tail) s.secrets.push(tail, Date.now(), (text, at) => this.runtime.data(panelId, text, at))
      this.runtime.data(panelId, s.secrets.finish())
    } else if (tail) this.runtime.data(panelId, tail)
    sessions.delete(panelId)
    this.syncCapturePower()
    this.cancelResumeHold(panelId)
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
  ): { ok: boolean; error?: string; bytes?: number; held?: boolean } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '串口未打开' }
    // 自动应答的输入保持优先于动作锁：先扣住用户按键，等判定结果再回放/丢弃
    if (!s.hold && s.action?.locked) return { ok: false, error: '设备动作正在使用此串口' }
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
    // HEX 发送按字节审计记录（二进制过 toString('utf8') 会把 0x1b 当 ANSI 剥掉、非法字节变 U+FFFD）
    // ASCII 发送记录解码前文本（buf 可能是 GBK 编码，toString('utf8') 会乱码；hex 模式不存在多字节问题）；
    // txAuditLine 把控制字符转成可见字面量：一次发送 = 一行日志（否则正文里的 \r 会被换行归一拆成幻影空行）
    const auditText = p.mode === 'hex' ? buf.toString('hex').replace(/../g, '$& ').trim() : txAuditLine(p.text + nl)
    if (s.hold) return this.holdWrite(s, buf, auditText)
    s.port.write(buf)
    this.recordWrite(panelId, s, buf.length, auditText)
    return { ok: true, bytes: buf.length }
  }

  private recordWrite(panelId: string, s: SerialSession, bytes: number, auditText: string): void {
    s.txBytes += bytes
    this.runtime.note(panelId, auditText)
    this.emit(panelId, 'tx', {
      text: auditText,
      bytes,
      time: Date.now(),
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
  }

  private validateDeviceConfig(value: unknown): { ok: boolean; config?: unknown; error?: string } {
    if (value === undefined) return { ok: false, error: '缺少配置内容' }
    try {
      return { ok: true, config: parseDeviceActionsConfig(value) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '设备动作配置无效' }
    }
  }

  /** 可视化编辑器保存：校验通过后原子写入，并刷新已布防的自动应答。 */
  private async saveDeviceConfig(value: unknown): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (value === undefined) return { ok: false, error: '缺少配置内容' }
    const result = await writeDeviceActionsFile(value, app.getPath('userData'))
    if (!result.ok) return result
    await this.refreshWatches()
    return { ok: true, path: result.path }
  }

  private async openDeviceConfigDir(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const dir = app.getPath('userData')
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true, path: deviceActionsFilePath(dir) }
  }

  /** 配置变更后让已布防的面板立即使用新配置；没有 auto 档或配置失效则自动解除。 */
  private async refreshWatches(): Promise<void> {
    const armed = [...sessions].filter(([, session]) => session.watch)
    if (!armed.length) return
    let provider: DeviceActionProvider | undefined
    let error = ''
    try {
      provider = await this.actionProvider()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '无法读取设备动作配置'
    }
    for (const [panelId, session] of armed) {
      const watch = session.watch
      if (!watch) continue
      const profiles = provider?.config.profiles.filter((profile) => profile.trigger === 'auto') ?? []
      if (!provider || !profiles.length) {
        delete session.watch
        this.releaseHold(panelId, session, false)
        this.emit(panelId, 'action:state', { source: 'auto', armed: false, running: false, error })
        continue
      }
      session.watch = { provider, profiles, lines: new DeviceActionLines(), busy: watch.busy }
      this.emit(panelId, 'action:state', {
        source: 'auto', armed: true, running: watch.busy,
        profiles: profiles.map(({ id, label, actionLabel }) => ({ id, label, actionLabel }))
      })
    }
  }

  /** 开/关自动应答监听。enabled 时加载配置并只保留 trigger=auto 的动作。 */
  private async setWatch(panelId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s?.port.isOpen) return { ok: false, error: '串口未打开' }
    if (!enabled) {
      delete s.watch
      this.releaseHold(panelId, s, false)
      this.emit(panelId, 'action:state', { source: 'auto', armed: false, running: false })
      return { ok: true }
    }
    try {
      const provider = await this.actionProvider()
      const profiles = provider.config.profiles.filter((profile) => profile.trigger === 'auto')
      if (!profiles.length) return { ok: false, error: 'device-actions.json 没有 trigger 为 auto 的设备动作' }
      s.watch = { provider, profiles, lines: new DeviceActionLines(), busy: false }
      this.emit(panelId, 'action:state', {
        source: 'auto', armed: true, running: false,
        profiles: profiles.map(({ id, label, actionLabel }) => ({ id, label, actionLabel }))
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法读取设备动作配置' }
    }
  }

  /** 自动应答：把完整行喂给配置里的匹配器；命中即发起一次动作。 */
  private watchLines(panelId: string, s: SerialSession, text: string, receivedAt: number): void {
    const watch = s.watch
    if (!watch) return
    watch.lines.push(text, (line) => {
      if (sessions.get(panelId) !== s) return true
      if (watch.busy || s.action || transfers.has(panelId)) return false
      // 输入回显命中触发词时先扣住按键，防止用户在口令提示处多按回车
      for (const profile of watch.profiles) {
        if (isTriggerWord(line, profile.triggerWords)) this.beginHold(s, profile.holdInput)
      }
      for (const profile of watch.profiles) {
        let challenge: string | undefined
        try { challenge = matchChallengeLine(profile.detect, line) } catch { continue }
        if (!challenge) continue
        this.beginHold(s, profile.holdInput)
        watch.busy = true
        void this.runAutoAction(panelId, s, watch.provider, profile, challenge, receivedAt).finally(() => {
          if (s.watch === watch) watch.busy = false
        })
        return true
      }
      return false
    })
  }

  private async runAutoAction(
    panelId: string, s: SerialSession, provider: DeviceActionProvider,
    profile: DeviceActionProfile, challenge: string, receivedAt: number
  ): Promise<void> {
    let ok = false
    try {
      const result = await this.runAction(panelId, provider, profile, {
        source: 'auto', challenge: { value: challenge, receivedAt }
      })
      ok = result.ok
      this.emit(panelId, 'action:state', {
        source: 'auto', running: false, profileId: profile.id,
        ok, error: result.ok ? undefined : result.error
      })
    } catch (error) {
      this.emit(panelId, 'action:state', {
        source: 'auto', running: false, profileId: profile.id,
        ok: false, error: error instanceof Error ? error.message : '设备动作失败'
      })
    } finally {
      this.releaseHold(panelId, s, ok)
    }
  }

  private async startDeviceAction(panelId: string, profileId: unknown): Promise<DeviceActionResult> {
    let provider: DeviceActionProvider
    let profile: DeviceActionProfile | undefined
    try {
      provider = await this.actionProvider()
      profile = provider.config.profiles.find(({ id }) => id === profileId)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法读取设备动作配置' }
    }
    if (!profile) return { ok: false, error: '找不到此设备动作的配置' }
    if (profile.trigger === 'auto') return { ok: false, error: '该设备动作配置为自动应答，不通过快捷命令执行' }
    return this.runAction(panelId, provider, profile, { source: 'manual' })
  }

  private async runAction(
    panelId: string, provider: DeviceActionProvider, profile: DeviceActionProfile,
    options: { source: 'manual' | 'auto'; challenge?: { value: string; receivedAt: number } }
  ): Promise<DeviceActionResult> {
    const s = sessions.get(panelId)
    if (!s?.port.isOpen) return { ok: false, error: '串口未打开' }
    if (s.action || transfers.has(panelId)) return { ok: false, error: '该串口有设备动作或文件传输正在运行' }
    const task: NonNullable<SerialSession['action']> = { controller: new AbortController(), locked: false }
    s.action = task
    const signal = task.controller.signal
    let responseSent = false
    const setStage = (stage: DeviceActionStage): void => {
      if (options.source === 'manual') this.emit(panelId, 'action:stage', { stage })
      else this.emit(panelId, 'action:state', { source: 'auto', running: true, stage, profileId: profile.id })
    }
    function checkConnection(): void {
      signal.throwIfAborted()
      if (sessions.get(panelId) !== s || !s?.port.isOpen) throw new Error('串口连接已变化')
    }

    try {
      setStage('checking')
      checkConnection()
      await runDeviceAction(provider, profile, {
        signal,
        challenge: options.challenge,
        setStage,
        lock: () => {
          checkConnection()
          if (transfers.has(panelId)) throw new Error('已有文件传输进行中')
          task.locked = true
        },
        exchange: async (text, secret, timeoutMs, match) => {
          checkConnection()
          // Consume queued output before installing the matcher. Only new RX can satisfy it.
          this.flush(panelId)
          const lines = new DeviceActionLines()
          const bytes = Buffer.from(text, 'ascii')
          if (secret) {
            s.secrets ??= new SerialSecretRedactor()
            s.secrets.add(text.trimEnd())
          }
          return await new Promise((resolve, reject) => {
            let settled = false
            const onAbort = (): void => finish(signal.reason)
            const timer = setTimeout(() => finish(new Error(secret
              ? '口令已发送，未收到设备的明确结果'
              : '等待设备挑战码超时')), timeoutMs)
            function finish(error?: Error, result?: { value: string; receivedAt: number }): void {
              if (settled) return
              settled = true
              clearTimeout(timer)
              signal.removeEventListener('abort', onAbort)
              task.receive = undefined
              if (result) resolve(result)
              else reject(error)
            }
            signal.addEventListener('abort', onAbort, { once: true })
            task.receive = (data, receivedAt) => {
              lines.push(data, (line) => {
                try {
                  const value = match(line)
                  if (!value) return false
                  finish(undefined, { value, receivedAt })
                } catch (error) { finish(error as Error) }
                return true
              })
            }
            try {
              s.port.write(bytes, (error) => {
                if (error) finish(new Error(secret ? '口令写入异常，设备结果未确认' : '发送设备动作命令失败'))
              })
              responseSent ||= secret
              this.recordWrite(panelId, s, bytes.length, secret ? '[设备动作口令已隐藏]' : txAuditLine(text))
            } catch {
              finish(new Error(secret ? '口令写入异常，设备结果未确认' : '发送设备动作命令失败'))
            }
          })
        },
        waitVerdict: async (input: WaitVerdictInput) => {
          checkConnection()
          // 丢弃注入前已排队输出，避免把旧的 Password: 提示当成拒绝
          this.flush(panelId)
          const lines = new DeviceActionLines()
          const bytes = Buffer.from(input.reply, 'ascii')
          s.secrets ??= new SerialSecretRedactor()
          s.secrets.add(input.reply.trimEnd())
          return await new Promise<'accepted' | 'rejected'>((resolve, reject) => {
            let settled = false
            let decision: NodeJS.Timeout | null = null
            const onAbort = (): void => finish(signal.reason instanceof Error
              ? signal.reason : new Error('设备动作已终止'))
            const timer = setTimeout(() => finish('accepted'), input.timeoutMs)
            function finish(verdict?: 'accepted' | 'rejected' | Error): void {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (decision) clearTimeout(decision)
              signal.removeEventListener('abort', onAbort)
              task.receive = undefined
              if (verdict instanceof Error) reject(verdict)
              else resolve(verdict ?? 'accepted')
            }
            signal.addEventListener('abort', onAbort, { once: true })
            task.receive = (data) => {
              lines.push(data, (line) => {
                if (input.isReject(line)) { finish('rejected'); return true }
                // 首个非重提示输出后留一个观察窗，等可能被拆开的提示行
                if (!decision) decision = setTimeout(() => finish('accepted'), input.decisionDelayMs)
                return false
              })
            }
            try {
              s.port.write(bytes, (error) => {
                if (error) finish(new Error('口令写入异常，设备结果未确认'))
              })
              responseSent = true
              this.recordWrite(panelId, s, bytes.length, '[设备动作口令已隐藏]')
            } catch {
              finish(new Error('口令写入异常，设备结果未确认'))
            }
          })
        }
      })
      checkConnection()
      this.runtime.note(panelId, '[DevKit] 设备动作成功')
      return { ok: true }
    } catch (error) {
      if (task.locked && sessions.get(panelId) === s && !signal.aborted) {
        this.runtime.note(panelId, '[DevKit] 设备动作未完成')
      }
      if (responseSent && signal.aborted) return { ok: false, error: '口令已发送，设备结果未确认' }
      return { ok: false, error: error instanceof Error ? error.message : '设备动作失败' }
    } finally {
      if (s.action === task) s.action = undefined
    }
  }

  /** 自动应答开始前扣住用户输入；15s 兜底丢弃，绝不把未知内容送进口令提示。 */
  private beginHold(s: SerialSession, config: false | DeviceActionHold): void {
    if (!config || s.hold) return
    const hold: NonNullable<SerialSession['hold']> = {
      chunks: [], bytes: 0, maxBytes: config.maxBytes,
      timer: setTimeout(() => {
        if (s.hold === hold) s.hold = undefined
      }, config.maxMs)
    }
    s.hold = hold
  }

  private holdWrite(s: SerialSession, buf: Buffer, audit: string): { ok: true; bytes: number; held: true } {
    const hold = s.hold!
    hold.chunks.push({ buf, audit })
    hold.bytes += buf.length
    while (hold.bytes > hold.maxBytes && hold.chunks.length) {
      hold.bytes -= hold.chunks.shift()!.buf.length
    }
    return { ok: true, bytes: buf.length, held: true }
  }

  /** 判定接受才回放；拒绝/超时/断开一律丢弃。 */
  private releaseHold(panelId: string, s: SerialSession, replay: boolean): void {
    const hold = s.hold
    if (!hold) return
    s.hold = undefined
    clearTimeout(hold.timer)
    if (!replay) return
    if (sessions.get(panelId) !== s || !s.port.isOpen) return
    for (const { buf, audit } of hold.chunks) {
      try { s.port.write(buf) } catch { break }
      this.recordWrite(panelId, s, buf.length, audit)
    }
  }

  /** 热切换收发编码：只影响之后的线上字节；切换前已按旧编码解码的显示/日志不回溯。
   *  替换整个流式解码器——旧解码器里滞留的多字节尾巴按新编码解释必然错位 */
  private setEncoding(panelId: string, encoding: SerialEncoding): { ok: boolean; error?: string } {
    const s = sessions.get(panelId)
    if (s?.action?.locked) return { ok: false, error: '设备动作正在使用此串口' }
    if (s) {
      s.encoding = encoding
      s.decoder = makeDecoder(encoding)
    }
    return { ok: true }
  }

  private setFlow(panelId: string, bits: { dtr?: boolean; rts?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s) return Promise.resolve({ ok: false, error: '串口未打开' })
    if (s.action?.locked) return Promise.resolve({ ok: false, error: '设备动作正在使用此串口' })
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
    if (s.action?.locked) return { ok: false, error: '设备动作正在使用此串口' }
    if (transfers.has(panelId)) return { ok: false, error: '已有传输进行中' }
    let data: Buffer
    try {
      data = await fs.readFile(p.path)
    } catch (err) {
      return { ok: false, error: `读取文件失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (sessions.get(panelId) !== s) return { ok: false, error: '串口连接已变化' }
    if (s.action?.locked) return { ok: false, error: '设备动作正在使用此串口' }
    if (transfers.has(panelId)) return { ok: false, error: '已有传输进行中' }
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
    if (s.action?.locked) return { ok: false, error: '设备动作正在使用此串口' }
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
