/* 终端交互判定纯逻辑测试：鼠标复制粘贴 / Ctrl+C/V / 查找模式退出 / 全局兜底键。
   判定逻辑与 TerminalView.vue 共用同一份 termInput.ts（生产代码路径） */
const { resolveMouseDown, resolveTermKey, resolveGlobalKey } = require('../src/renderer/src/components/termInput')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  [FAIL] ${name}`)
  }
}

console.log('== resolveMouseDown（鼠标复制粘贴） ==')
// 常规模式
check('左键+有选区 → 复制', resolveMouseDown({ searchOpen: false, button: 0, hasSelection: true }) === 'copy')
check('左键+无选区 → 无操作', resolveMouseDown({ searchOpen: false, button: 0, hasSelection: false }) === 'none')
check('右键 → 粘贴（无论有无选区）', resolveMouseDown({ searchOpen: false, button: 2, hasSelection: true }) === 'paste')
check('右键 → 粘贴（无选区）', resolveMouseDown({ searchOpen: false, button: 2, hasSelection: false }) === 'paste')
check('中键 → 无操作', resolveMouseDown({ searchOpen: false, button: 1, hasSelection: true }) === 'none')
// 查找模式：点击终端退出查找
check('查找中左键 → 退出查找', resolveMouseDown({ searchOpen: true, button: 0, hasSelection: false }) === 'exit-search')
check('查找中左键+有选区 → 仍退出查找（不复制命中内容）', resolveMouseDown({ searchOpen: true, button: 0, hasSelection: true }) === 'exit-search')
check('查找中右键 → 退出查找并粘贴', resolveMouseDown({ searchOpen: true, button: 2, hasSelection: false }) === 'exit-search-paste')

console.log('== resolveTermKey（终端内按键） ==')
// 非 keydown / 非 Ctrl 一律放行
check('keyup 放行', resolveTermKey({ type: 'keyup', ctrlKey: true, altKey: false, metaKey: false, key: 'c', hasSelection: true }) === 'pass-xterm')
check('无 Ctrl 放行（普通字符输入）', resolveTermKey({ type: 'keydown', ctrlKey: false, altKey: false, metaKey: false, key: 'a', hasSelection: false }) === 'pass-xterm')
// Ctrl+C 智能双行为
check('Ctrl+C 无选区 → 放行 xterm 发 SIGINT', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'c', hasSelection: false }) === 'pass-xterm')
check('Ctrl+C 有选区 → 复制', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'c', hasSelection: true }) === 'copy')
check('Ctrl+C 大写 C 有选区 → 复制', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'C', hasSelection: true }) === 'copy')
// Ctrl+V 粘贴
check('Ctrl+V → 粘贴', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'v', hasSelection: false }) === 'paste')
// 缩放与查找
check('Ctrl+= 放大', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: '=', hasSelection: false }) === 'zoom-in')
check('Ctrl+- 缩小', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: '-', hasSelection: false }) === 'zoom-out')
check('Ctrl+0 复位', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: '0', hasSelection: false }) === 'zoom-reset')
check('Ctrl+F 打开查找', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'f', hasSelection: false }) === 'open-search')
check('Ctrl+F 大写 F 打开查找', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'F', hasSelection: false }) === 'open-search')
// 其他 Ctrl 组合放行（Ctrl+Z/D 等终端控制键）
check('Ctrl+Z 放行发挂起', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'z', hasSelection: false }) === 'pass-xterm')
check('Ctrl+D 放行发 EOF', resolveTermKey({ type: 'keydown', ctrlKey: true, altKey: false, metaKey: false, key: 'd', hasSelection: false }) === 'pass-xterm')

console.log('== resolveGlobalKey（全局兜底） ==')
// 焦点在输入框：完全忽略（不抢浏览器复制粘贴）
check('焦点在输入框 → 忽略 Ctrl+C', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'c', editableTarget: true, hasSelection: false }).kind === 'none')
check('焦点在输入框 → 忽略 Ctrl+V', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'v', editableTarget: true, hasSelection: false }).kind === 'none')
// 非 Ctrl 组合忽略
check('无 Ctrl → 忽略', resolveGlobalKey({ ctrlKey: false, altKey: false, metaKey: false, key: 'c', editableTarget: false, hasSelection: false }).kind === 'none')
check('Ctrl+Alt 组合 → 忽略', resolveGlobalKey({ ctrlKey: true, altKey: true, metaKey: false, key: 'c', editableTarget: false, hasSelection: false }).kind === 'none')
check('Ctrl+Win 组合 → 忽略', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: true, key: 'c', editableTarget: false, hasSelection: false }).kind === 'none')
// Ctrl+C 双行为
check('Ctrl+C 无选区 → 发 SIGINT', (() => { const a = resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'c', editableTarget: false, hasSelection: false }); return a.kind === 'send' && a.seq === '\x03' })())
check('Ctrl+C 有选区 → 复制', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'c', editableTarget: false, hasSelection: true }).kind === 'copy')
// 其他终端控制键
check('Ctrl+D → 发 EOF', (() => { const a = resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'd', editableTarget: false, hasSelection: false }); return a.kind === 'send' && a.seq === '\x04' })())
check('Ctrl+Z → 发挂起', (() => { const a = resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'z', editableTarget: false, hasSelection: false }); return a.kind === 'send' && a.seq === '\x1a' })())
check('Ctrl+L → 发清屏', (() => { const a = resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'l', editableTarget: false, hasSelection: false }); return a.kind === 'send' && a.seq === '\x0c' })())
// Ctrl+V 不在全局兜底表（终端内已处理；全局放行浏览器粘贴语义无意义）
check('Ctrl+V 非编辑目标 → 忽略', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'v', editableTarget: false, hasSelection: false }).kind === 'none')
// 不在控制键表的键忽略
check('Ctrl+X → 忽略', resolveGlobalKey({ ctrlKey: true, altKey: false, metaKey: false, key: 'x', editableTarget: false, hasSelection: false }).kind === 'none')

console.log(`\n终端交互判定: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
