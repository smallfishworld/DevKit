/**
 * SSH 终端服务（多实例：panelId -> 会话）
 * ssh2 纯 JS 实现（无原生模块）；输出与串口相同按 80ms 批量合并推送防卡 UI
 */
import { Client, type ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { SshConfig, SshParams } from '../../../shared/ssh'
import { DEFAULT_SSH_CONFIG } from '../../../shared/ssh'
import { getSection, setSection } from '../macro/configStore'
import { cleanLogBody, fileNameStamp, fmtStamp, splitTerminalLines } from '../../../shared/logtext'

interface RxPiece {
  buf: Buffer
  time: number
}

interface SshSession {
  client: Client
  stream: ClientChannel
  params: SshParams
  rxBytes: number
  txBytes: number
  pending: RxPiece[]
  decoder: StringDecoder
  flushTimer: NodeJS.Timeout | null
  /** 自动日志：持久句柄 + 内存缓冲批量写（避免每周期 open/close 文件触发杀毒扫描） */
  logHandle: FileHandle | null
  logBuf: string[]
  /** 低流量时周期性落盘（500ms） */
  logTimer: NodeJS.Timeout | null
  /** 日志管道的未完行尾巴（最后一个 \n 之后的内容；未完行/半个 \r\r\n 终止符/跨批 ANSI 序列滞留于此） */
  logCarry: string
  /** 内存全量日志（「存日志」导出源）：整行按 MEM_CHUNK_PIECES 行聚成的大块 Buffer 存 V8 堆外
   *  （放渲染端字符串累积会长会话涨数百 MB 引发大 GC，终端打印断断续续；见串口服务同注释） */
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

const sessions = new Map<string, SshSession>()
/** 批量合并窗口：16ms ≈ 60fps，视觉流畅；仍合并吸收网络碎片包 */
const FLUSH_MS = 16
/** 内存全量日志上限（字节，UTF-8 实际大小）；超限停止记录并提示先存日志 */
const MEM_LOG_LIMIT = 500 * 1024 * 1024
/** 内存日志攒块阈值：行凑满 256 段拼成单块 Buffer，控制 Buffer 对象数量
 *  （按行一对象时 500MB 日志会产生千万级 JS 堆对象，把 GC 压力转回主进程） */
const MEM_CHUNK_PIECES = 256

/** 断开后留存的内存全量日志（按 panelId）：会话关闭后「存日志」仍可导出，
 *  重连（新会话）时移除——等价旧渲染端实现里「断开后 ringBuf 仍在」的行为 */
interface RetainedMem {
  /** 拼成单 Buffer 的完整日志内容 */
  buf: Buffer
  /** 文件名用主机名（断开后会话已删，params 不可再取） */
  host: string
}
const retainedMem = new Map<string, RetainedMem>()

/** 会话结束时留存内存日志，供断开后「存日志」导出 */
function retainMemLog(panelId: string, s: SshSession): void {
  // 先把未封块的行封成块再留存（漏封会丢尾部内容）
  if (s.pendingMem) {
    s.memBuf.push(Buffer.from(s.pendingMem, 'utf8'))
    s.pendingMem = ''
    s.memPieces = 0
  }
  if (s.memBuf.length > 0) {
    retainedMem.set(panelId, { buf: Buffer.concat(s.memBuf), host: s.params.host })
  }
  s.memBuf = []
  s.memBytes = 0
}

function sshLogDir(): string {
  return join(app.getPath('userData'), 'ssh-logs')
}

/** 日志行时间戳（与终端显示一致）：HH:MM:SS.mmm；落盘带日期（跨天可辨）：YYYY-MM-DD HH:MM:SS.mmm */
function fmtLogTime(t: number, withDate = false): string {
  return fmtStamp(t, withDate)
}

class SshService implements ToolService {
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('ssh', panelId, type, payload)
  }

  /** 日志入缓冲（真正落盘在 flushLog；写失败静默停日志，不影响收发）。
   *  入参为已按完整行切分的原始行（不含终止符），清洗后逐行补时间戳（每行可辨；带日期，跨天可追溯）。
   *  空行照常落盘（设备真实空行可追溯）。
   *  同格式整行始终累积进内存全量日志 memBuf（自动落盘关闭/失败时仍可「存日志」导出）；
   *  行先拼进 pendingMem 字符串，攒满一段再 Buffer.from 成块（大块存储，见 MEM_CHUNK_PIECES） */
  private appendLog(panelId: string, s: SshSession, parts: string[]): void {
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
  private sealMemChunk(panelId: string, s: SshSession): void {
    if (!s.pendingMem) return
    const b = Buffer.from(s.pendingMem, 'utf8')
    s.pendingMem = ''
    s.memPieces = 0
    s.memBuf.push(b)
    s.memBytes += b.length
    if (s.memBytes > MEM_LOG_LIMIT) this.tripMemFull(panelId, s)
  }

  /** 内存日志达上限：停记录（pendingMem 残留丢弃）并通知渲染端停显 */
  private tripMemFull(panelId: string, s: SshSession): void {
    s.memFull = true
    s.pendingMem = ''
    s.memPieces = 0
    this.emit(panelId, 'memlog', { full: true })
  }

  /** 日志落盘：断开或缓冲超限时把缓冲一次性写入持久句柄 */
  private async flushLog(s: SshSession): Promise<void> {
    if (!s.logHandle || s.logBuf.length === 0) return
    const batch = s.logBuf
    s.logBuf = []
    try {
      await s.logHandle.appendFile(batch.join(''), 'utf8')
    } catch {
      // 写失败一次即停日志，避免反复报错拖慢收发（close 须空安全：下方置空后不再引用）
      await s.logHandle?.close().catch(() => {})
      s.logHandle = null
    }
  }

  private emitStatus(panelId: string, extra: Record<string, unknown> = {}): void {
    const s = sessions.get(panelId)
    this.emit(panelId, 'status', {
      open: !!s,
      host: s?.params.host ?? '',
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
    // 终止符跨批不产生幻影空行；跨批 ANSI 序列也在 carry 中（内存日志总是开，切分不再只随磁盘日志走）
    const { lines, carry } = splitTerminalLines(s.logCarry + text)
    s.logCarry = carry
    this.appendLog(panelId, s, lines)
    // 缓冲超限立即落盘，防止长时间刷屏积压内存
    if (s.logHandle && s.logBuf.length >= 64) void this.flushLog(s)
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
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG).then((config) => ({
          config,
          open: sessions.has(panelId)
        }))
      case 'config:get':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
      case 'config:set':
        return setSection('ssh', payload).then(() => ({ ok: true }))
      case 'connect':
        return this.connect(panelId, payload as SshParams)
      case 'close':
        return this.close(panelId)
      case 'write':
        return this.write(panelId, (payload as { text: string }).text)
      case 'resize':
        return this.resize(panelId, payload as { cols: number; rows: number })
      case 'log:mem-save':
        return this.saveMemLog(panelId)
      case 'log:mem-clear':
        this.clearMemLog(panelId)
        return { ok: true }
      case 'log:set-dir':
        return this.setLogDir()
      case 'log:get-dir':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG).then((c) => ({ dir: c.logDir || sshLogDir() }))
      case 'pick-key':
        return this.pickKeyFile()
      case 'log:open-dir':
        return getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
          .then(async (c) => {
            // 优先打开用户设置的保存路径；未设置时打开默认自动日志目录
            const dir = c.logDir || sshLogDir()
            await fs.mkdir(dir, { recursive: true })
            void shell.openPath(dir)
            return { ok: true }
          })
          .catch(() => ({ ok: false, error: '无法创建日志目录' }))
      default:
        throw new Error(`ssh 服务未知操作: ${action}`)
    }
  }

  dispose(panelId: string): void {
    if (sessions.has(panelId)) void this.close(panelId)
  }

  private async connect(panelId: string, params: SshParams): Promise<{ ok: boolean; error?: string }> {
    await this.close(panelId)
    const host = (params.host || '').trim()
    if (!host) return { ok: false, error: '未填写主机地址' }
    if (!params.username.trim()) return { ok: false, error: '未填写用户名' }
    const port = Number(params.port) || 22

    // 密钥认证：先读私钥文件
    let privateKey: Buffer | undefined
    if (params.authType === 'key') {
      if (!params.privateKeyPath) return { ok: false, error: '未选择私钥文件' }
      try {
        privateKey = await fs.readFile(params.privateKeyPath)
      } catch (err) {
        return { ok: false, error: `私钥读取失败：${err instanceof Error ? err.message : String(err)}` }
      }
    } else if (!params.password) {
      return { ok: false, error: '未填写密码' }
    }

    const client = new Client()
    return new Promise((resolve) => {
      let settled = false
      const fail = (error: string): void => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          /* 忽略 */
        }
        resolve({ ok: false, error })
      }
      client.on('error', (err: Error) => fail(err.message))
      client.on('close', () => {
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
          // 意外断开（网络断/服务器关）：冲掉日志缓冲并释放句柄；内存全量日志留存供断开后导出
          retainMemLog(panelId, s)
          void this.flushLog(s).finally(() => {
            void s.logHandle?.close().catch(() => {})
            s.logHandle = null
          })
        }
        this.flush(panelId)
        sessions.delete(panelId)
        this.emitStatus(panelId)
      })
      client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
        // 部分服务器要求 keyboard-interactive 认证：直接用密码应答
        finish([params.password])
      })
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            fail(err.message)
            return
          }
          void this.setupSession(panelId, client, stream, { ...params, host, port })
            .then(() => {
              settled = true
              resolve({ ok: true })
            })
            .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
        })
      })
      client.connect({
        host,
        port,
        username: params.username.trim(),
        password: params.authType === 'password' ? params.password : undefined,
        privateKey,
        tryKeyboard: true,
        readyTimeout: 15_000
      })
    })
  }

  /** shell 流就绪后：建会话、挂数据转发、写自动日志头 */
  private async setupSession(
    panelId: string,
    client: Client,
    stream: ClientChannel,
    params: SshParams
  ): Promise<void> {
    // 自动日志开关（配置项，默认开启）：持久句柄 + 批量落盘
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    let logHandle: FileHandle | null = null
    if (cfg.autoLog) {
      try {
        await fs.mkdir(cfg.logDir || sshLogDir(), { recursive: true })
        const logPath = join(
          cfg.logDir || sshLogDir(),
          `${params.host.replace(/[^a-zA-Z0-9]/g, '')}-${params.port}-${fileNameStamp()}.log`
        )
        logHandle = await fs.open(logPath, 'a')
        await logHandle.appendFile(
          `\r\n[${fmtLogTime(Date.now())}] INFO ===== 连接 ${params.username}@${params.host}:${params.port} =====\r\n`,
          'utf8'
        )
      } catch {
        await logHandle?.close().catch(() => {})
        logHandle = null
      }
    }
    const session: SshSession = {
      client,
      stream,
      params,
      rxBytes: 0,
      txBytes: 0,
      pending: [],
      decoder: new StringDecoder('utf8'),
      flushTimer: null,
      logHandle,
      logBuf: [],
      logTimer: null,
      logCarry: '',
      memBuf: [],
      pendingMem: '',
      memPieces: 0,
      memBytes: 0,
      memFull: false
    }
    // 新会话：旧留存日志作废（重连 = 新一轮记录）
    retainedMem.delete(panelId)
    sessions.set(panelId, session)
    // 低流量场景：周期性把日志缓冲落盘
    if (logHandle) {
      session.logTimer = setInterval(() => {
        const cur = sessions.get(panelId)
        if (cur) void this.flushLog(cur)
      }, 500)
    }
    stream.on('data', (chunk: Buffer) => {
      const s = sessions.get(panelId)
      if (!s) return
      s.rxBytes += chunk.length
      s.pending.push({ buf: chunk, time: Date.now() })
      if (!s.flushTimer) {
        s.flushTimer = setTimeout(() => {
          const cur = sessions.get(panelId)
          if (cur) cur.flushTimer = null
          this.flush(panelId)
        }, FLUSH_MS)
      }
    })
    stream.stderr?.on('data', (chunk: Buffer) => {
      const s = sessions.get(panelId)
      if (!s) return
      s.rxBytes += chunk.length
      s.pending.push({ buf: chunk, time: Date.now() })
    })
    stream.on('close', () => {
      try {
        client.end()
      } catch {
        /* 'close' 事件分支会兜底清理 */
      }
    })
    this.emitStatus(panelId)
  }

  private async close(panelId: string): Promise<{ ok: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: true }
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
    // 日志：清定时器、冲缓冲、关句柄
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
      try {
        s.stream.end()
        s.client.end()
      } catch {
        /* 忽略 */
      }
      resolve()
    })
    return { ok: true }
  }

  private write(panelId: string, text: string): { ok: boolean; error?: string } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: 'SSH 未连接' }
    if (!text) return { ok: false, error: '发送内容为空' }
    const buf = Buffer.from(text, 'utf8')
    s.stream.write(buf)
    s.txBytes += buf.length
    this.appendLog(panelId, s, [text])
    this.emit(panelId, 'tx', {
      text,
      bytes: buf.length,
      time: Date.now(),
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
    return { ok: true }
  }

  private resize(panelId: string, p: { cols: number; rows: number }): { ok: boolean } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false }
    try {
      s.stream.setWindow(Math.max(1, Math.floor(p.rows)), Math.max(1, Math.floor(p.cols)), 0, 0)
    } catch {
      /* 会话关闭竞态 */
    }
    return { ok: true }
  }

  /** 选择私钥文件（渲染端文件系统受限，用主进程对话框） */
  private async pickKeyFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [
        { name: '私钥', extensions: ['pem', 'key', 'ppk', 'id_rsa'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  private async saveLog(
    panelId: string,
    p: { content: string | Buffer; name?: string }
  ): Promise<{ ok: boolean; error?: string }> {
    // 文件名带时分秒，以创建时间为准；目录用记忆的保存目录（重启记忆）
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    const stamp = new Date()
    const p2 = (n: number, w = 2): string => n.toString().padStart(w, '0')
    const defaultName =
      p.name ??
      `ssh-${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.log`
    const baseDir = cfg.logDir || sshLogDir()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存 SSH 日志',
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
        await setSection('ssh', cfg)
        await this.rotateSessions(cfg.logDir)
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
    let host: string
    if (s) {
      // 封块后拼装（不改动会话自身状态；memBuf 继续可追加）
      const chunks = [...s.memBuf]
      if (s.pendingMem) chunks.push(Buffer.from(s.pendingMem, 'utf8'))
      content = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      host = s.params.host
    } else {
      const r = retainedMem.get(panelId)
      content = r?.buf
      host = r?.host ?? ''
    }
    if (!content || content.length === 0) return { ok: false, error: '无日志可存' }
    // 文件名 ssh-<主机>-<时刻 YYYYMMDD-HHMMSS>.log（与原渲染端命名一致）
    const safeHost = host.replace(/[\\/:*?"<>|]/g, '_') || 'host'
    return this.saveLog(panelId, { content, name: `ssh-${safeHost}-${fileNameStamp()}.log` })
  }

  /** 清空内存全量日志（终端「清空」联动解除溢出锁定；重连 = 新会话自动重置） */
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
    const cfg = await getSection<SshConfig>('ssh', DEFAULT_SSH_CONFIG)
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择日志保存目录',
      defaultPath: cfg.logDir || sshLogDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths[0]) return { ok: false, error: '已取消' }
    cfg.logDir = filePaths[0]
    await setSection('ssh', cfg)
    await this.rotateSessions(cfg.logDir)
    return { ok: true, dir: filePaths[0] }
  }

  /** 更换日志目录时：对打开中的会话立刻轮转 —— 冲掉旧句柄并在新目录重开新文件（时间戳以轮转时刻为准） */
  private async rotateSessions(dir: string): Promise<void> {
    for (const s of sessions.values()) {
      if (!s.logHandle) continue
      // 冲缓冲、关旧句柄（flushLog 写失败时会把句柄置空，须空安全）
      await this.flushLog(s)
      await s.logHandle?.close().catch(() => {})
      s.logHandle = null
      if (!s.logTimer) continue
      try {
        await fs.mkdir(dir, { recursive: true })
        const logPath = join(dir, `${s.params.host.replace(/[^a-zA-Z0-9]/g, '')}-${s.params.port}-${fileNameStamp()}.log`)
        s.logHandle = await fs.open(logPath, 'a')
        await s.logHandle.appendFile(`\r\n[${fmtLogTime(Date.now())}] INFO ===== 日志目录切换，续写至 ${dir} =====\r\n`, 'utf8')
      } catch {
        s.logHandle = null
        clearInterval(s.logTimer)
        s.logTimer = null
      }
    }
  }
}

export const sshService = new SshService()
