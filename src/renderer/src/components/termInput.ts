/**
 * 终端交互判定（纯函数，无 Vue/xterm 依赖，供 TerminalView 与单元测试共用）
 * 行为规格：
 * - 左键：有选区 → 复制；无选区 → 无操作
 * - 右键：粘贴
 * - 查找条打开时点击终端：退出查找（清除命中高亮/选区，恢复普通交互）；右键同时粘贴
 * - Ctrl+C：有选区 → 复制；无选区 → 放行给 xterm 发 SIGINT(\x03)
 * - Ctrl+V：粘贴
 * - Ctrl+= / Ctrl+- / Ctrl+0：缩放；Ctrl+F：打开查找
 * - 全局兜底（焦点不在输入框）：Ctrl+终端控制键作为终端输入发出；Ctrl+C 有选区时复制
 */

export type MouseAction = 'copy' | 'paste' | 'exit-search' | 'exit-search-paste' | 'none'

export function resolveMouseDown(p: {
  searchOpen: boolean
  button: number
  hasSelection: boolean
}): MouseAction {
  if (p.searchOpen) return p.button === 2 ? 'exit-search-paste' : 'exit-search'
  if (p.button === 0) return p.hasSelection ? 'copy' : 'none'
  if (p.button === 2) return 'paste'
  return 'none'
}

export type TermKeyAction =
  | 'copy'
  | 'paste'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'open-search'
  | 'pass-xterm'

/** 终端内按键（attachCustomKeyEventHandler，target 恒为 xterm 自身 textarea） */
export function resolveTermKey(p: {
  type: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  key: string
  hasSelection: boolean
}): TermKeyAction {
  if (p.type !== 'keydown' || !p.ctrlKey || p.altKey || p.metaKey) return 'pass-xterm'
  switch (p.key) {
    case '=':
    case '+':
      return 'zoom-in'
    case '-':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
    case 'f':
    case 'F':
      return 'open-search'
    case 'c':
    case 'C': // Shift 修饰时浏览器上报大写
      return p.hasSelection ? 'copy' : 'pass-xterm'
    case 'v':
      return 'paste'
    default:
      return 'pass-xterm'
  }
}

export type GlobalKeyAction = { kind: 'none' } | { kind: 'copy' } | { kind: 'send'; seq: string }

/** 焦点不在终端时兜底的终端控制键（Ctrl+字母 → 控制序列） */
const GLOBAL_SEQ: Record<string, string> = {
  c: '\x03', // 中断
  z: '\x1a', // 挂起
  d: '\x04', // EOF
  '\\': '\x1c', // 退出
  u: '\x15', // 删行
  l: '\x0c', // 清屏
  a: '\x01', // 行首
  e: '\x05', // 行尾
  k: '\x0b', // 删至行尾
  w: '\x17', // 删词
  r: '\x12', // 反向搜索
  s: '\x13' // 暂停输出
}

/** 全局兜底按键（window 捕获阶段；焦点在输入型元素时忽略，交还浏览器默认行为） */
export function resolveGlobalKey(p: {
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  key: string
  editableTarget: boolean
  hasSelection: boolean
}): GlobalKeyAction {
  if (p.editableTarget || !p.ctrlKey || p.altKey || p.metaKey) return { kind: 'none' }
  const lower = p.key.toLowerCase()
  const seq = GLOBAL_SEQ[lower]
  if (!seq) return { kind: 'none' }
  if (lower === 'c' && p.hasSelection) return { kind: 'copy' }
  return { kind: 'send', seq }
}
