/**
 * 键鼠注入：通过 koffi(FFI) 直调 user32.dll 的 SendInput
 * 说明：koffi 为 N-API 预编译包，无需本地编译工具链
 */
import koffi from 'koffi'
import type { InputSelfTest, MouseButton } from '../../../shared/types'

// ---------- Win32 常量 ----------
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

// 虚拟屏度量索引
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

// ---------- Win32 类型定义（koffi 自然对齐，等价 C 布局） ----------
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t'
})

const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16'
})

const INPUT_U = koffi.union('INPUT_U', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT
})

const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: INPUT_U
})

const user32 = koffi.load('user32.dll')
const SendInput = user32.func('uint32 SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)')
const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)')
const INPUT_SIZE = koffi.sizeof(INPUT)

// ---------- 虚拟屏坐标换算 ----------
// SendInput 绝对坐标按 0~65535 归一化；uiohook 上报的是主屏原点坐标
interface VirtualScreen {
  x: number
  y: number
  w: number
  h: number
}

let vscreen: VirtualScreen | null = null

function getVirtualScreen(): VirtualScreen {
  if (!vscreen) {
    vscreen = {
      x: GetSystemMetrics(SM_XVIRTUALSCREEN),
      y: GetSystemMetrics(SM_YVIRTUALSCREEN),
      w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
      h: GetSystemMetrics(SM_CYVIRTUALSCREEN)
    }
  }
  return vscreen
}

/** 屏幕坐标 -> SendInput 归一化绝对坐标 */
function toAbsolute(x: number, y: number): { ax: number; ay: number } {
  const vs = getVirtualScreen()
  const ax = Math.round(((x - vs.x) * 65535) / (vs.w - 1))
  const ay = Math.round(((y - vs.y) * 65535) / (vs.h - 1))
  return { ax: Math.max(0, Math.min(65535, ax)), ay: Math.max(0, Math.min(65535, ay)) }
}

// ---------- 基础注入 ----------
// 注意：koffi 的 union 成员对象只允许带一个键（即使值为 null 的多余键也会报
// "Expected object with single property name for union"），因此按事件类型只挂用到的那个成员
function sendMouse(dwFlags: number, dx = 0, dy = 0, mouseData = 0): boolean {
  const input = {
    type: INPUT_MOUSE,
    u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } }
  }
  return SendInput(1, input, INPUT_SIZE) === 1
}

function sendKey(wVk: number, wScan: number, dwFlags: number): boolean {
  const input = {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } }
  }
  return SendInput(1, input, INPUT_SIZE) === 1
}

// ---------- 对外 API ----------
export function injectMouseMove(x: number, y: number): boolean {
  const { ax, ay } = toAbsolute(x, y)
  return sendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay)
}

const BTN_FLAGS: Record<MouseButton, [number, number]> = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
}

/** 点击：移动 + 按下 + 抬起 */
export function injectMouseClick(x: number, y: number, button: MouseButton = 'left'): boolean {
  injectMouseMove(x, y)
  const [down, up] = BTN_FLAGS[button]
  const okDown = sendMouse(down)
  const okUp = sendMouse(up)
  return okDown && okUp
}

export function injectMouseButton(button: MouseButton, isDown: boolean): boolean {
  const [down, up] = BTN_FLAGS[button]
  return sendMouse(isDown ? down : up)
}

/** 滚轮：delta 一格 120，正=向上 */
export function injectWheel(x: number, y: number, delta: number): boolean {
  injectMouseMove(x, y)
  return sendMouse(MOUSEEVENTF_WHEEL, 0, 0, delta > 0 ? delta : -(-delta))
}

export function injectKey(vk: number, isDown: boolean): boolean {
  return sendKey(vk, 0, isDown ? 0 : KEYEVENTF_KEYUP)
}

/** 轻敲一次按键 */
export function injectKeyTap(vk: number): boolean {
  const down = sendKey(vk, 0, 0)
  const up = sendKey(vk, 0, KEYEVENTF_KEYUP)
  return down && up
}

/** 按 UTF-16 码元逐字符注入文本（UNICODE 事件不经过键盘布局/焦点窗口键盘钩子过滤） */
export function injectText(text: string): boolean {
  let ok = true
  for (const ch of text) {
    for (const unit of ch) {
      const code = unit.codePointAt(0) ?? 0
      ok = sendKey(0, code, KEYEVENTF_UNICODE) && ok
      ok = sendKey(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) && ok
    }
  }
  return ok
}

export function inputSelfTest(): InputSelfTest {
  const result: InputSelfTest = {
    koffiLoaded: true,
    sendInputResolved: typeof SendInput === 'function',
    inputStructSize: INPUT_SIZE,
    uiohookLoaded: false
  }
  return result
}
