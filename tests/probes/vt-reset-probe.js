/**
 * 软复位 / 退出备用屏序列的副作用探针（tests/probes/）
 * 用途：确定「重开串口时把终端从上次会话遗留的 VT 状态里拉回来」该发哪些序列，
 * 前提是不能清掉用户的回滚历史。
 * 用法：npx esbuild tests/probes/vt-reset-probe.js --bundle --platform=node --outfile=/tmp/v.cjs && node /tmp/v.cjs
 */
const { Terminal } = require('@xterm/xterm')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))
const OUT = Array.from({ length: 60 }, (_, i) => `LINE ${String(i).padStart(2, '0')} ${'z'.repeat(20)}\r\n`).join('')
const info = (t) => {
  const b = t.buffer.active
  let keep = 0
  for (let i = 0; i < b.length; i++) if (/LINE \d\d/.test(b.getLine(i)?.translateToString(true) ?? '')) keep++
  return { type: b.type, len: b.length, keep }
}

;(async () => {
  for (const [label, seq, pre] of [
    ['A 正常屏 + ?1049l', '\x1b[?1049l', ''],
    ['B 正常屏 + DECSTR(!p)', '\x1b[!p', ''],
    ['C 正常屏 + ?1049l + !p', '\x1b[?1049l\x1b[!p', ''],
    ['D 备用屏中 + ?1049l', '\x1b[?1049l', '\x1b[?1049h']
  ]) {
    const t = new Terminal({ cols: 40, rows: 24, scrollback: 200000, convertEol: true })
    await w(t, OUT)
    if (pre) await w(t, pre)
    const before = info(t)
    await w(t, seq)
    await wait(20)
    const after = info(t)
    console.log(label.padEnd(26), 'before', JSON.stringify(before), '-> after', JSON.stringify(after))
    t.dispose()
  }
})()
