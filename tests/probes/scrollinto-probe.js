/**
 * 「滚屏是否保历史」探针（tests/probes/）
 * 用途：给备用屏降级策略找一个「把当前屏顶进回滚、又不丢行」的最短序列。
 * 候选：
 *   N1 在底行发 1 个 \n
 *   N2 发 999 个 \n（超出屏幕高度，看是否被钳制/是否多出空行）
 *   S1 CSI S（SU，向上滚一行）
 *   S2 CSI 999S
 *   S3 CSI 0S（默认 1）
 * 判据：滚出可见区的行是否进了回滚缓冲（能否滚回去看到），以及缓冲是否被灌入大量空行。
 * 用法：npx esbuild tests/probes/scrollinto-probe.js --bundle --platform=node --outfile=/tmp/si.cjs && node /tmp/si.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const ROWS = 24
const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(30)}\r\n`).join('')

const countHist = (t) => {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if (/^HIST /.test(b.getLine(i)?.translateToString(true) ?? '')) n++
  return n
}
const blankRows = (t) => {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === '') n++
  return n
}

const CASES = [
  ['基准（不动）', ''],
  ['N1 底行 \\n ×1', '\x1b[24;1H\n'],
  ['N2 底行 \\n ×999', '\x1b[24;1H' + '\n'.repeat(999)],
  ['N3 \\r\\n ×24', '\r\n'.repeat(24)],
  ['S1 CSI S', '\x1b[S'],
  ['S2 CSI 999S', '\x1b[999S'],
  ['S3 CSI 0S', '\x1b[0S']
]

;(async () => {
  console.log(`30 行历史 @ 100x${ROWS}，观察滚动后的回滚完整性\n`)
  for (const [label, seq] of CASES) {
    const t = new Terminal({ cols: 100, rows: ROWS, scrollback: 200000, convertEol: true })
    await w(t, HISTORY)
    const before = { len: t.buffer.active.length, hist: countHist(t) }
    await w(t, seq)
    await w(t, '\x1b[H\x1b[2J')
    await wait(20)
    const b = t.buffer.active
    t.scrollToTop()
    await wait(10)
    const topRow = (b.getLine(b.viewportY)?.translateToString(true) ?? '').trim()
    t.scrollToBottom()
    await wait(10)
    console.log(
      label.padEnd(18),
      `滚动前 len=${before.len} hist=${before.hist}`,
      `→ 清屏后 len=${String(b.length).padStart(3)}`,
      `hist=${String(countHist(t)).padStart(2)}`,
      `空白行=${String(blankRows(t)).padStart(3)}`,
      `滚到顶首行=${JSON.stringify(topRow.slice(0, 34))}`
    )
    t.dispose()
  }
})()
