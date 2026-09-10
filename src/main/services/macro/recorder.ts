/**
 * 宏录制器：订阅全局输入流 -> 带延时的步骤列表
 * 过滤：修饰键单独按下、按键自动重复、自身热键（MR-07）、鼠标移动（可选）
 */
import { captureBus, startCapture, stopCapture } from '../input/capture'
import { matchesAnyHotkey } from './hotkeys'
import type { InputEventData, KeyEventData } from '../../../shared/types'
import type { MacroSettings } from '../../../shared/macro'

const RECORDER_REF = '__macro_recorder__'

export interface RecorderCallbacks {
  onEvent: (count: number) => void
  onStop: () => void
}

let recording = false
let steps: { data: InputEventData; time: number }[] = []
let callbacks: RecorderCallbacks | null = null
let settings: MacroSettings | null = null
const pressedKeys = new Set<number>()

function listener(data: InputEventData): void {
  if (!recording) return

  if (data.kind === 'key') {
    // 自身热键过滤：录制启动/停止热键本身不进宏
    if (settings?.suppressOwnHotkeys && matchesAnyHotkey(data)) return
    // 自动重复过滤：按住不放产生的重复 keydown 丢弃
    if (data.down) {
      if (pressedKeys.has(data.vk)) return
      pressedKeys.add(data.vk)
    } else {
      pressedKeys.delete(data.vk)
    }
    // 修饰键单独按下/抬起不录（组合键以主键的修饰状态表达）
    if ([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c].includes(data.vk)) return
  }

  steps.push({ data, time: Date.now() })
  callbacks?.onEvent(steps.length)
}

export function startRecording(s: MacroSettings, cb: RecorderCallbacks): boolean {
  if (recording) return false
  recording = true
  settings = s
  callbacks = cb
  steps = []
  pressedKeys.clear()
  captureBus.on('input', listener)
  startCapture(RECORDER_REF, { ignoreMoves: s.ignoreMoves })
  return true
}

/** 停止录制并返回带时间戳的事件序列 */
export function stopRecording(): { data: InputEventData; time: number }[] {
  if (!recording) return []
  recording = false
  captureBus.removeListener('input', listener)
  stopCapture(RECORDER_REF)
  pressedKeys.clear()
  const result = steps
  steps = []
  callbacks?.onStop()
  return result
}

export function isRecording(): boolean {
  return recording
}
