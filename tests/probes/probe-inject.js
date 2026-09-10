/* 验证 SendInput 的 union 编组：
 * 1) 旧写法（多键含 null）应在 koffi 编组阶段报错（触达 OS 前）
 * 2) 新写法 mouse 相对移动 (0,0) 无副作用真实调用应返回 1
 * 3) 新写法 keyboard 形状合法（与 mouse 同一 union 校验机制，用编组错误/成功区分）
 */
const koffi = require('koffi')

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
})
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U })

const user32 = koffi.load('user32.dll')
const SendInput = user32.func('uint32 SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)')
const SIZE = koffi.sizeof(INPUT)

let fail = 0

// 1) 旧写法 → 期望抛 union 错误（真实复现用户报错）
try {
  SendInput(1, { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: 1, time: 0, dwExtraInfo: 0 }, ki: null, hi: null } }, SIZE)
  console.log('[FAIL] 旧写法（多键含null）竟然通过编组')
  fail++
} catch (e) {
  const msg = e.message
  console.log(`[PASS] 旧写法被编组阶段拒绝: ${msg}`)
  if (!msg.includes('single property')) fail++
}

// 2) 新写法 mouse：MOUSEEVENTF_MOVE(0x0001) 相对移动 0 像素，无任何可见效果
try {
  const r = SendInput(1, { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: 0x0001, time: 0, dwExtraInfo: 0 } } }, SIZE)
  console.log(`[PASS] 新 mouse 形状 SendInput 返回 ${r}（1=成功）`)
  if (r !== 1) fail++
} catch (e) {
  console.log(`[FAIL] 新 mouse 形状编组失败: ${e.message}`)
  fail++
}

// 3) 新写法 keyboard：不真实注入，仅验证编组是否接受（故意传错 cbSize 使调用失败，但编组在前）
try {
  let threwMarshal = false
  try {
    // cbSize 故意传 0：koffi 先完成 JS->C 编组（验证 union 形状），Win32 侧返回 0
    SendInput(1, { type: 1, u: { ki: { wVk: 0, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } }, 0)
  } catch (e) {
    if (e.message.includes('single property')) threwMarshal = true
    else throw e
  }
  console.log(`[PASS] 新 keyboard 形状通过 union 编组（未注入任何按键）`)
  if (threwMarshal) fail++
} catch (e) {
  console.log(`[FAIL] 新 keyboard 形状编组失败: ${e.message}`)
  fail++
}

console.log(fail === 0 ? '\n=== ALL UNION TESTS PASSED ===' : `\n=== ${fail} FAILED ===`)
process.exit(fail === 0 ? 0 : 1)
