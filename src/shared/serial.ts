/** 串口助手共享类型与默认值（快捷命令宏已独立为 shared/term-macro.ts，全局共享） */

export type Parity = 'none' | 'even' | 'odd'

export interface SerialParams {
  path: string
  baudRate: number
  dataBits: 7 | 8
  stopBits: 1 | 2
  parity: Parity
  rtscts: boolean
}

export const DEFAULT_SERIAL_PARAMS: SerialParams = {
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false
}

/** 常用波特率（下拉可编辑，仍可手输 1200~12000000） */
export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000, 4000000, 8000000, 12000000]

/** 保存的会话（可快速载入参数重连） */
export interface SerialSessionInfo {
  name: string
  params: SerialParams
}

/** 串口配置持久化结构（config.json 的 serial 键） */
export interface SerialConfig {
  last: SerialParams
  sessions: SerialSessionInfo[]
  /** 终端字体族（首个为有效字体，缺省自动回退） */
  termFont: string
  /** 终端字号（Ctrl+滚轮缩放范围 9~28） */
  termFontSize: number
  /** 文件传输默认协议（记住上次选择） */
  xferProtocol: TransferProtocol
  /** 手动「存日志」的保存目录（重启记忆；空则用默认自动日志目录） */
  logDir: string
  /** 自动日志开关（会话期间收发自动落盘；默认开启） */
  autoLog: boolean
  /** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
  sidebarWidth: number
}

/** 文件传输协议：YMODEM（ry/sy）或 ZMODEM（rz/sz） */
export type TransferProtocol = 'ymodem' | 'zmodem'

/** 文件传输进度事件（主进程 -> 渲染进程 'transfer' 事件） */
export interface SerialTransferEvt {
  state: 'start' | 'progress' | 'done' | 'error' | 'cancel'
  protocol: TransferProtocol
  dir: 'send' | 'recv'
  /** 文件名（接收时来自协议头） */
  name: string
  bytes: number
  total: number
  error?: string
}

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  last: DEFAULT_SERIAL_PARAMS,
  sessions: [],
  termFont: 'Consolas',
  termFontSize: 13,
  xferProtocol: 'ymodem',
  logDir: '',
  autoLog: true,
  sidebarWidth: 210
}
