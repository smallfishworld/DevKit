/**
 * 隐藏标签页/最小化导致的退化 fit→reflow 内容丢失探针（tests/probes/）
 * 背景：TerminalView 用 v-show 切标签，隐藏时容器 0 尺寸，ResizeObserver 触发 fit，
 * FitAddon 的 proposeDimensions 用 Math.max(2, …)/Math.max(1, …) 兜底 → 终端被 resize 成 2×1；
 * 回到可见再 fit 回 100×28。本探针检验这一来一回是否丢内容。
 * 用法：npx esbuild tests/probes/reflow-loss-probe.js --bundle --platform=node --outfile=/tmp/f.cjs && node /tmp/f.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const LINES = Array.from({ length: 400 }, (_, i) => `LINE-${String(i).padStart(3, '0')} payload ${'x'.repeat(40)}\r\n`)
LINES[4] = '# cat proc/314/status\n'   // 模拟用户命令回显
LINES[5] = 'Name:\tdavinci\n'

const has = (t, needle) => {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
  return -1
}

async function scenario(label, rects) {
  const t = new Terminal({ cols: 100, rows: 28, scrollback: 200000, convertEol: true })
  await w(t, LINES.join(''))
  await wait(30)
  const before = { len: t.buffer.active.length, cat: has(t, 'cat proc/314/status'), name: has(t, 'Name:'), len0: has(t, 'LINE-000') }
  for (const [c, r] of rects) {
    t.resize(c, r)
    await wait(20)
  }
  await wait(60)
  const after = { len: t.buffer.active.length, cat: has(t, 'cat proc/314/status'), name: has(t, 'Name:'), len0: has(t, 'LINE-000') }
  console.log(
    label.padEnd(30),
    `before len=${before.len} cat@${before.cat} name@${before.name} LINE-000@${before.len0}`,
    `| after len=${after.len} cat@${after.cat} name@${after.name} LINE-000@${after.len0}`
  )
  t.dispose()
}

;(async () => {
  await scenario('A 无 resize（基准）', [])
  await scenario('B 2x1 再回 100x28', [[2, 1], [100, 28]])
  await scenario('C 80x24 再回 100x28', [[80, 24], [100, 28]])
  await scenario('D 连续抖动 40x10→2x1→100x28', [[40, 10], [2, 1], [100, 28]])
})()
