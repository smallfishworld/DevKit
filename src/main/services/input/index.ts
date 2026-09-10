/**
 * 键鼠输入工具服务：捕获（uiohook-napi）+ 注入（koffi SendInput）
 */
import type { ToolService } from '../../ipc'
import type { InputSelfTest, MouseButton } from '../../../shared/types'
import { startCapture, stopCapture, isCapturing } from './capture'
import {
  injectMouseMove,
  injectMouseClick,
  injectKeyTap,
  injectText,
  inputSelfTest as injectSelfTest
} from './inject'
import { uIOhook } from 'uiohook-napi'

interface InjectClickPayload {
  x: number
  y: number
  button?: MouseButton
}

interface InjectKeyPayload {
  vk: number
}

interface InjectTextPayload {
  text: string
}

/** 完整自检：注入层 + 捕获层 */
export function fullSelfTest(): InputSelfTest {
  const base = injectSelfTest()
  base.uiohookLoaded = typeof uIOhook?.start === 'function'
  return base
}

export const inputService: ToolService = {
  invoke(panelId, action, payload) {
    switch (action) {
      case 'selftest':
        return fullSelfTest() satisfies InputSelfTest
      case 'capture:start': {
        const opts = (payload ?? {}) as { ignoreMoves?: boolean }
        startCapture(panelId, opts)
        return { capturing: true }
      }
      case 'capture:stop': {
        stopCapture(panelId)
        return { capturing: isCapturing() }
      }
      case 'capture:status':
        return { capturing: isCapturing() }
      case 'inject:click': {
        const { x, y, button } = payload as InjectClickPayload
        return { ok: injectMouseClick(x, y, button ?? 'left') }
      }
      case 'inject:move': {
        const { x, y } = payload as InjectClickPayload
        return { ok: injectMouseMove(x, y) }
      }
      case 'inject:key': {
        const { vk } = payload as InjectKeyPayload
        return { ok: injectKeyTap(vk) }
      }
      case 'inject:text': {
        const { text } = payload as InjectTextPayload
        return { ok: injectText(text) }
      }
      default:
        throw new Error(`input 服务未知操作: ${action}`)
    }
  },
  dispose(panelId) {
    stopCapture(panelId)
  }
}
