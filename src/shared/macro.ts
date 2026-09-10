/** 宏数据模型（宏文件 JSON 即此结构，人类可读、可进 git） */
import type { InputEventData } from './types'

export type StepType = 'input' | 'delay' | 'text' | 'wait-color'

/** 等待颜色参数：在 (x,y) 等颜色出现/消失，超时判失败 */
export interface WaitColorSpec {
  x: number
  y: number
  /** '#RRGGBB' */
  color: string
  /** 各通道最大允许偏差 0~255 */
  tolerance: number
  /** appear: 等待出现；disappear: 等待消失 */
  mode: 'appear' | 'disappear'
  /** 超时（毫秒），超时后终止回放 */
  timeoutMs: number
}

export interface MacroStep {
  id: string
  /** 步骤段名，同段可整体启用/禁用 */
  segment: string
  enabled: boolean
  type: StepType
  /** 执行本步骤前的等待（毫秒） */
  delayMs: number
  /** type=input 时的键鼠事件 */
  data?: InputEventData
  /** type=text 时的注入文本 */
  text?: string
  /** type=wait-color 时的等待参数 */
  wait?: WaitColorSpec
}

export interface MacroMeta {
  name: string
  /** 全局热键 accelerator，如 'F9'、'Ctrl+Alt+1'；空=不绑定 */
  hotkey: string
  createdAt: number
  updatedAt: number
}

export interface MacroFile {
  version: 1
  meta: MacroMeta
  steps: MacroStep[]
}

/** 录制/回放全局设置（持久化到 config.json） */
export interface MacroSettings {
  hotkeyRecord: string
  hotkeyPlay: string
  hotkeyStop: string
  /** 录制时忽略鼠标移动 */
  ignoreMoves: boolean
  /** 录制时屏蔽本程序自身热键（避免录制到 F9/F10 按键） */
  suppressOwnHotkeys: boolean
  /** 回放默认倍速 */
  speed: number
  /** 回放默认循环次数（0=无限） */
  loops: number
  /** 播放中 Esc 强制停止 */
  escStop: boolean
}

export const DEFAULT_MACRO_SETTINGS: MacroSettings = {
  hotkeyRecord: 'F9',
  hotkeyPlay: 'F10',
  hotkeyStop: 'F11',
  ignoreMoves: true,
  suppressOwnHotkeys: true,
  speed: 1,
  loops: 1,
  escStop: false
}
