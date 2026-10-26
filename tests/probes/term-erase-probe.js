/**
 * 无头 xterm 擦除回显探针（tests/probes/，不在 npm test 内）
 * 复现「输入 rrreset 后退格」的设备回显流，验证 xterm + 批量拆分是否忠实地渲染擦除：
 * 设备（BusyBox ash）退格回显为 \b \b（BS 空格 BS），逐次擦一字符。
 * 用法：node tests/probes/term-erase-probe.js
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 写完一批后等 xterm 内部解析队列排空（write 回调 + 一帧余量） */
async function writeBatch(term, text) {
  await new Promise((resolve) => term.write(text, resolve))
  await wait(20)
}

function dumpLine(term, label) {
  const buf = term.buffer.active
  const y = term.buffer.active.baseY + term.buffer.active.cursorY
  const line = buf.getLine(y)?.translateToString(true) ?? '(无行)'
  console.log(`${label.padEnd(28)} | 行内容=[${line}] | 光标 col=${term.buffer.active.cursorX}`)
}

async function main() {
  // 场景 1：擦除回显一次性到达（一个批次）
  {
    const t = new Terminal({ cols: 80, rows: 10, scrollback: 200_000, convertEol: true })
    await writeBatch(t, '# rrreset')
    dumpLine(t, '输入后')
    await writeBatch(t, '\b \b'.repeat(7))
    dumpLine(t, '退格7次(单批)')
    t.dispose()
  }
  // 场景 2：擦除回显逐次到达（7 个批次，模拟按键节奏 + 32ms 批量）
  {
    const t = new Terminal({ cols: 80, rows: 10, scrollback: 200_000, convertEol: true })
    await writeBatch(t, '# rrreset')
    for (let i = 0; i < 7; i++) await writeBatch(t, '\b \b')
    dumpLine(t, '退格7次(逐批)')
    t.dispose()
  }
  // 场景 3：擦除回显的 \b 与空格被 32ms 批量切开（\b | 空格\b | ...）
  {
    const t = new Terminal({ cols: 80, rows: 10, scrollback: 200_000, convertEol: true })
    await writeBatch(t, '# rrreset')
    for (let i = 0; i < 7; i++) {
      await writeBatch(t, '\b')
      await writeBatch(t, ' \b')
    }
    dumpLine(t, '退格7次(擦除对切开)')
    t.dispose()
  }
  // 场景 4：带时间戳前缀的行（showTime 开启时的显示形态）再退格
  {
    const t = new Terminal({ cols: 80, rows: 10, scrollback: 200_000, convertEol: true })
    await writeBatch(t, '\x1b[90m[12:00:00.000]\x1b[0m # rrreset')
    dumpLine(t, '带时间戳输入后')
    await writeBatch(t, '\b \b'.repeat(7))
    dumpLine(t, '带时间戳退格7次')
    t.dispose()
  }
  // 场景 5：本地回显路径——\x7f 直接写入 xterm（设备不回显 + 本地回显开）
  {
    const t = new Terminal({ cols: 80, rows: 10, scrollback: 200_000, convertEol: true })
    for (const ch of 'rrreset') await writeBatch(t, ch)
    dumpLine(t, '本地回显逐字输入')
    for (let i = 0; i < 7; i++) await writeBatch(t, '\x7f')
    dumpLine(t, '本地回显退格\\x7f')
    t.dispose()
  }
}

main()
