/**
 * 键鼠捕获：基于 uiohook-napi（libuiohook 的 N-API 封装，预编译、免本地工具链）
 * 底层为 Windows 低级钩子 WH_KEYBOARD_LL / WH_MOUSE_LL
 */
import { uIOhook, EventType, WheelDirection } from 'uiohook-napi'
import type { UiohookKeyboardEvent, UiohookMouseEvent, UiohookWheelEvent } from 'uiohook-napi'
import { EventEmitter } from 'node:events'
import { uioToVk } from './keycodes'
import { emitToolEvent } from '../../ipc'
import type { InputEventData, MouseButton } from '../../../shared/types'

/** 进程内事件总线：宏录制器直接订阅原始输入事件 */
export const captureBus = new EventEmitter()
captureBus.setMaxListeners(20)

const BTN_MAP: Record<number, MouseButton> = { 1: 'left', 2: 'right', 3: 'middle' }

export interface CaptureFilter {
  /** 忽略鼠标移动（只记录点击），录制界面操作时建议开启 */
  ignoreMoves: boolean
}

let filter: CaptureFilter = { ignoreMoves: true }
/** 正在接收事件的 panelId 集合（引用计数，为空时卸载系统钩子） */
const panels = new Set<string>()
let hookRunning = false

function handleEvent(e: UiohookKeyboardEvent | UiohookMouseEvent | UiohookWheelEvent): void {
  let data: InputEventData | null = null

  switch (e.type) {
    case EventType.EVENT_KEY_PRESSED:
    case EventType.EVENT_KEY_RELEASED: {
      const k = e as UiohookKeyboardEvent
      data = {
        kind: 'key',
        vk: uioToVk(k.keycode) ?? k.keycode,
        down: e.type === EventType.EVENT_KEY_PRESSED,
        ctrl: k.ctrlKey,
        alt: k.altKey,
        shift: k.shiftKey,
        meta: k.metaKey
      }
      break
    }
    case EventType.EVENT_MOUSE_PRESSED:
    case EventType.EVENT_MOUSE_RELEASED: {
      const m = e as UiohookMouseEvent
      data = {
        kind: 'mouse',
        action: e.type === EventType.EVENT_MOUSE_PRESSED ? 'down' : 'up',
        button: BTN_MAP[m.button as number] ?? 'left',
        x: m.x,
        y: m.y
      }
      break
    }
    case EventType.EVENT_MOUSE_MOVED: {
      if (filter.ignoreMoves) return
      const m = e as UiohookMouseEvent
      data = { kind: 'mouse', action: 'move', button: 'left', x: m.x, y: m.y }
      break
    }
    case EventType.EVENT_MOUSE_WHEEL: {
      const w = e as UiohookWheelEvent
      if (w.direction !== WheelDirection.VERTICAL) return
      // libuiohook rotation 为正表示向下滚；统一为一格 120，正=向上
      const delta = w.rotation > 0 ? -120 : 120
      data = { kind: 'wheel', x: w.x, y: w.y, delta }
      break
    }
  }

  if (!data) return
  for (const panelId of panels) emitToolEvent('input', panelId, 'input', data)
  captureBus.emit('input', data)
}

function ensureHook(): void {
  if (hookRunning) return
  uIOhook.on('input', handleEvent)
  uIOhook.start()
  hookRunning = true
}

function releaseHook(): void {
  if (!hookRunning) return
  uIOhook.stop()
  hookRunning = false
}

export function startCapture(panelId: string, opts?: Partial<CaptureFilter>): void {
  if (opts?.ignoreMoves !== undefined) filter = { ...filter, ...opts }
  panels.add(panelId)
  ensureHook()
}

export function stopCapture(panelId: string): void {
  panels.delete(panelId)
  if (panels.size === 0) releaseHook()
}

export function isCapturing(): boolean {
  return hookRunning
}
