/**
 * 串口TCP桥接共享类型与纯逻辑：Telnet IAC 解析、远程管理 JSON 行协议、配置身份派生。
 * 主进程 bridge 服务、渲染端 BridgePanel、tests/ 共用同一份。
 */

// ===================== 类型 =====================

/** 通道运行参数（启动时定，运行中不可改） */
export interface BridgeChannelParams {
  /** 1~8 */
  cid: number
  /** 串口设备名（COM3） */
  port: string
  baudRate: number
  /** TCP 监听端口 */
  tcpPort: number
}

/** 共享串口格式（8 路共用） */
export interface BridgeSharedFormat {
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits: 1 | 1.5 | 2
  /** none | xonxoff | rtscts */
  flowCtrl: string
}

/** 单身份下的完整配置（服务端模式；客户端模式仅记 remote） */
export interface BridgeIdentityConfig {
  mode: 'server' | 'client'
  /** 远程管理：服务端模式=本机管理端口，客户端模式=远端地址 */
  remoteHost: string
  remotePort: number
  /** 管理服务/连接是否开启 */
  remoteOn: boolean
  /** 服务端模式专有 */
  shared?: BridgeSharedFormat
  allowMulti?: boolean
  telnetMode?: boolean
  /** 每路参数（8 个槽位） */
  channels: Array<Partial<BridgeChannelParams>>
}

/** configStore 'bridge' 节结构：多身份配置 + 上次身份记忆 */
export interface BridgeConfig {
  identities: Record<string, BridgeIdentityConfig>
  lastIdentity: string
}

export const DEFAULT_SHARED_FORMAT: BridgeSharedFormat = {
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowCtrl: 'none'
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  identities: {},
  lastIdentity: 'server_9999'
}

/** 服务端推送的通道状态（channels_status.channels[] 元素） */
export interface BridgeChannelStatus {
  cid: number
  port: string
  baudrate: number
  tcp_port: number
  running: boolean
  rx_bytes: number
  tx_bytes: number
  clients: number
}

/** 服务端推送的共享配置（snake_case wire 字段） */
export interface BridgeSharedStatus {
  bytesize: number
  parity: string
  stopbits: number
  flowctrl: string
  allow_multi: boolean
}

// ===================== Telnet IAC 解析（RFC 854 最小状态机） =====================

export const IAC = 0xff
export const DONT = 0xfe
export const DO = 0xfd
export const WONT = 0xfc
export const WILL = 0xfb
export const SB = 0xfa
export const SE = 0xf0
export const CMD_BREAK = 0xf3
export const CMD_IP = 0xf4
export const CMD_AO = 0xf5
export const CMD_AYT = 0xf6
export const CMD_EC = 0xf7
export const CMD_EL = 0xf8
export const CMD_GA = 0xf9
export const CMD_NOP = 0xf1

const TWO_BYTE_CMDS = new Set([CMD_BREAK, CMD_IP, CMD_AO, CMD_AYT, CMD_EC, CMD_EL, CMD_GA, CMD_NOP])
const THREE_BYTE_VERBS = new Set([DONT, DO, WONT, WILL])

export interface IacFeedResult {
  /** 剥离协议字节后的纯数据 */
  data: Buffer
  /** 事件序列，如 ['break'] */
  events: string[]
}

/**
 * 最小 telnet IAC 解析器（RFC 854）。
 * - 剥离所有 IAC 协商/子协商字节（不发送应答，保持透明）
 * - IAC BREAK (FF F3) → 'break' 事件（转真实串口 break）
 * - IAC IAC (FF FF) → 反转义为单个 0xFF 数据字节
 * 跨批安全：feed 后半截序列（结尾孤立的 FF/FD 等）由 state 携带，下次 feed 接着解析。
 */
export class TelnetIacParser {
  private state: 'NORMAL' | 'IAC' | 'VERB' | 'SUB' | 'SUB_IAC' = 'NORMAL'

  feed(chunk: Buffer): IacFeedResult {
    const data: number[] = []
    const events: string[] = []
    for (const b of chunk) {
      const st = this.state
      if (st === 'NORMAL') {
        if (b === IAC) this.state = 'IAC'
        else data.push(b)
      } else if (st === 'IAC') {
        if (b === IAC) {
          data.push(IAC)
          this.state = 'NORMAL'
        } else if (b === SB) {
          this.state = 'SUB'
        } else if (TWO_BYTE_CMDS.has(b)) {
          if (b === CMD_BREAK) events.push('break')
          this.state = 'NORMAL'
        } else if (THREE_BYTE_VERBS.has(b)) {
          this.state = 'VERB'
        } else {
          this.state = 'NORMAL'
        }
      } else if (st === 'VERB') {
        // 三字节命令 (DO/DONT/WILL/WONT + 选项) 的选项字节：吞掉
        this.state = 'NORMAL'
      } else if (st === 'SUB') {
        if (b === IAC) this.state = 'SUB_IAC'
      } else if (st === 'SUB_IAC') {
        if (b === SE) this.state = 'NORMAL'
        else if (b === IAC) this.state = 'SUB'
        else this.state = 'SUB'
      }
    }
    return { data: Buffer.from(data), events }
  }
}

// ===================== 远程管理 JSON 行协议 =====================

/** 行分隔 JSON：`json + '\n'`，UTF-8 */
export function packCommand(cmd: string, kv: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ cmd, ...kv }) + '\n', 'utf8')
}

/** 按行切分缓冲，返回 [完整行列表, 剩余半行]（行 = \n 前内容，吃掉结尾 \r） */
export function splitLines(buf: Buffer<ArrayBufferLike>): [string[], Buffer<ArrayBufferLike>] {
  const out: string[] = []
  let start = 0
  while (true) {
    const idx = buf.indexOf(0x0a, start)
    if (idx === -1) break
    out.push(buf.subarray(start, idx).toString('utf8').replace(/\r$/, ''))
    start = idx + 1
  }
  return [out, buf.subarray(start)]
}

/** 解析一行 JSON 命令；非法 JSON 返回 null（静默） */
export function unpackLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ===================== 配置身份派生 =====================

/**
 * 按运行模式派生配置身份字符串（用作日志文件名片段）：
 * client: <host>_<port>; server: server_<port>。
 * 清洗 Windows 文件名非法字符 :/\*?"<>| 为下划线，全空回退 default。
 */
export function makeIdentity(mode: 'server' | 'client', host: string, port: string | number): string {
  const raw = mode === 'client' ? `${host}_${port}` : `server_${port}`
  const bad = ':/\\*?"<>|'
  let cleaned = ''
  for (const c of raw) cleaned += bad.includes(c) ? '_' : c
  cleaned = cleaned.trim().replaceAll(/^\.+|\.+$/g, '')
  if (!cleaned || !cleaned.replace(/_/g, '')) cleaned = 'default'
  return cleaned
}

/** 日志文件名片段清洗（同 makeIdentity 的字符清洗 + 空值兜底，供磁盘日志文件名） */
export function safeFilePart(s: string): string {
  const bad = ':/\\*?"<>|'
  let out = ''
  for (const c of s) out += bad.includes(c) ? '_' : c
  out = out.trim().replaceAll(/^\.+|\.+$/g, '')
  if (!out || !out.replace(/_/g, '')) out = 'default'
  return out
}

/** 历史事件（面板界面上限 1500 行） */
export const MAX_UI_LOG = 1500

/**
 * 从串口显示名提取设备名：'COM3  (USB-Serial)' → 'COM3'；已是裸设备名则原样返回。
 * 兼容旧配置/远端推送里混入的显示名。
 */
export function portDeviceOf(display: string): string {
  return display.replace(/\s+\([^)]*\)\s*$/, '').trim()
}
