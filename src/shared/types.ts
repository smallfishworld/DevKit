/** 主进程与渲染进程之间统一的工具调用/事件协议 */

/** 渲染进程 -> 主进程的调用 */
export interface ToolInvoke {
  tool: string
  panelId: string
  action: string
  payload?: unknown
}

/** 主进程 -> 渲染进程的事件 */
export interface ToolEvent {
  tool: string
  panelId: string
  type: string
  payload?: unknown
}

/** 渲染进程暴露给面板的 API（由 preload 注入 window.api） */
export interface DevKitApi {
  invoke(tool: string, action: string, panelId: string, payload?: unknown): Promise<unknown>
  /** 订阅某面板的事件，返回取消订阅函数 */
  on(
    tool: string,
    panelId: string,
    type: string,
    listener: (payload: unknown) => void
  ): () => void
  /** 无边框窗口控制（自绘标题栏用） */
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    info(): Promise<WinInfo>
    onMaxChange(cb: (maximized: boolean) => void): () => void
    readClipboard(): Promise<string>
    writeClipboard(text: string): Promise<boolean>
  }
}

/** 应用运行时版本信息（标题栏图标点击展示） */
export interface WinInfo {
  version: string
  electron: string
  chrome: string
  node: string
}

// ---------- 键鼠输入（捕获/注入统一数据结构，M3 宏基于此存储） ----------

export type MouseButton = 'left' | 'right' | 'middle'

export interface KeyEventData {
  kind: 'key'
  /** Windows 虚拟键码 VK_* */
  vk: number
  down: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface MouseEventData {
  kind: 'mouse'
  action: 'down' | 'up' | 'move'
  button: MouseButton
  /** 屏幕绝对坐标（主屏原点，与 GetCursorPos 一致） */
  x: number
  y: number
}

export interface WheelEventData {
  kind: 'wheel'
  x: number
  y: number
  /** 正值向上滚，一格 120 */
  delta: number
}

export type InputEventData = KeyEventData | MouseEventData | WheelEventData

/** 原生模块自检结果（面板上展示，便于诊断环境问题） */
export interface InputSelfTest {
  koffiLoaded: boolean
  sendInputResolved: boolean
  inputStructSize: number
  uiohookLoaded: boolean
  error?: string
}

// ---------- TFTP ----------

export type TransferDir = 'rrq' | 'wrq'

export interface TransferInfo {
  id: number
  peer: string
  dir: TransferDir
  filename: string
  totalBytes: number
  transferred: number
  done: boolean
  ok: boolean
  error: string | null
  startedAt: number
}
