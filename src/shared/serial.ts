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

/**
 * 休眠超过该时长才在唤醒时丢弃驱动积压的陈旧字节（毫秒）。
 * 短暂休眠不会有明显积压，丢掉反而丢真数据。
 *
 * 主进程（决定是否真丢缓冲）与渲染端（决定是否显示「串口可能已失步」提示）**必须用同一个值**：
 * 两者不一致会出现「主进程没丢、界面却提示失步」或反之的矛盾状态。故放在 shared。
 */
export const SUSPEND_FLUSH_MS = 30_000

/** 常用波特率（下拉可编辑，仍可手输 1200~12000000） */
export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000, 4000000, 8000000, 12000000]

/** 保存的会话（可快速载入参数重连） */
export interface SerialSessionInfo {
  name: string
  params: SerialParams
}

/** 串口收发编码：串口线上无编码约定，多数嵌入式设备输出 GBK；终端/日志内部统一 UTF-8 */
export type SerialEncoding = 'utf8' | 'gbk'

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
  /** 终端显示时间戳（每批接收数据前插本地时间 [HH:MM:SS.mmm]，与日志格式一致） */
  showTime: boolean
  /**
   * 裸 \r 按换行显示（默认关闭）：设备用 \r 原地重绘同一行时（进度条、休眠失步），
   * 真实 VT 语义下屏幕看不到新内容；开启后与日志归一规则一致，每帧单独成行。
   */
  crAsNewline?: boolean
  /**
   * 回滚保护（默认开启）：拦下设备发来的 `CSI 3J`（擦回滚）、`ESC c`（硬复位）。
   * 它们会销毁已滚出屏幕的内容，滚动也看不到；日志里这些序列已被剥掉，
   * 所以不拦的话用户无法察觉。关闭后完全按设备原始字节渲染。
   * 备用屏切换（`?1049h`）不在此列：中和它会让全屏程序覆盖主屏现存内容，
   * 改由重开串口时按终端实际状态复位（见 shared/vtguard.ts）。
   */
  guardScrollback?: boolean
  /** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
  sidebarWidth: number
  /** 左侧会话/快捷命令栏显示/隐藏 */
  sidebarHidden?: boolean
  /** 收发编码（收：按它解码线上的字节；发：按它编码下发文本；默认 UTF-8） */
  encoding: SerialEncoding
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
  showTime: false,
  crAsNewline: false,
  guardScrollback: true,
  sidebarWidth: 210,
  encoding: 'utf8'
}
