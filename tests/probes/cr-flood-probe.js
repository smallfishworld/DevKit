/**
 * 无头 xterm 光标控制探针（tests/probes/，不在 npm test 内）
 * 复现「设备只发 \r / \r\n 重绘光标、不发可见字符」时终端上的表现：
 * 用户键入的字是否被回车吃掉、看起来是否像「不刷新」。
 * 用法：node tests/probes/cr-flood-probe.js
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function w(t, s) {
  await new Promise((r) => t.write(s, r))
  await wait(15)
}
function dump(t, label) {
  const b = t.buffer.active
  const y = b.baseY + b.cursorY
  const rows = []
  for (let i = Math.max(0, y - 4); i <= y; i++) {
    rows.push(JSON.stringify(b.getLine(i)?.translateToString(true) ?? ''))
  }
  console.log(
    `${label.padEnd(26)} | 光标(row=${y},col=${b.cursorX}) baseY=${b.baseY} | 末尾行: ${rows.join(' , ')}`
  )
}

async function main() {
  console.log('--- A: 纯 \\r 洪泛（设备无输出、只反复回车）---')
  {
    const t = new Terminal({ cols: 60, rows: 8, scrollback: 2000, convertEol: true })
    await w(t, '# ')
    for (let i = 0; i < 20; i++) await w(t, '\r')
    dump(t, '20 次 \\r 之后')
    for (const ch of 'debug') await w(t, ch)
    dump(t, '随后逐字输入 debug')
    await w(t, '\r')
    dump(t, '按回车(\\r)')
    t.dispose()
  }

  console.log('--- B: 空行洪泛 \\r\\n\\r\\n ---')
  {
    const t = new Terminal({ cols: 60, rows: 8, scrollback: 2000, convertEol: true })
    for (let i = 0; i < 20; i++) await w(t, '\r\n\r\n')
    dump(t, '20 次 \\r\\n\\r\\n 之后')
    t.dispose()
  }

  console.log('--- C: 输入被 \\r 夹击（模拟设备回显）---')
  {
    const t = new Terminal({ cols: 60, rows: 8, scrollback: 2000, convertEol: true })
    await w(t, '# ')
    for (const ch of 'debug') {
      await w(t, ch)
      await w(t, '\r')
    }
    dump(t, '逐字输入 debug，每字后跟 \\r')
    t.dispose()
  }

  console.log('--- D: 退格擦除回显（\\b \\b）在行首附近 ---')
  {
    const t = new Terminal({ cols: 60, rows: 8, scrollback: 2000, convertEol: true })
    await w(t, '# rrreset')
    for (let i = 0; i < 7; i++) await w(t, '\b \b')
    dump(t, '退格 7 次')
    t.dispose()
  }
}

main()
