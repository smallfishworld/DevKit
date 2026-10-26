/**
 * 「从备用屏拉回主屏」该发什么探针（tests/probes/）
 *
 * 前提（normal-screen-1049l-probe.js 实测）：在主屏上发 `?1049l` 会把光标倒回 0，
 * 下一个会话的输出因此覆盖回滚顶部 —— 所以**只在真正处于备用屏时**才能发它。
 * 本探针确认两件事：
 *   1. 备用屏里 DECSTR(`!p`) 单独能否退出备用屏（若能，就不需要 ?1049l）
 *   2. 备用屏里 ?1049l 的确切效果（能否恢复主屏 + 历史）
 *
 * 用法：npx esbuild tests/probes/altscreen-exit-strategy-probe.js --bundle --platform=node --outfile=/tmp/ae.cjs && node /tmp/ae.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(20)}\r\n`).join('')
const APP = '\x1b[H\x1b[2J' + Array.from({ length: 24 }, (_, i) => `\x1b[${i + 1};1Happ-row${String(i).padStart(2, '0')}`).join('')

const countHist = (t) => {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if (/^HIST /.test(b.getLine(i)?.translateToString(true) ?? '')) n++
  return n
}

const CASES = [
  ['只发 ?1049l', '\x1b[?1049l'],
  ['只发 DECSTR !p', '\x1b[!p'],
  ['?1049l + !p', '\x1b[?1049l\x1b[!p']
]

;(async () => {
  console.log('场景：进备用屏画满一屏 → 断线 → 重开时发复位 → 新会话写 3 行\n')
  for (const [label, seq] of CASES) {
    const t = new Terminal({ cols: 100, rows: 24, scrollback: 200000, convertEol: true })
    await w(t, HISTORY)
    await w(t, '\x1b[?1049h' + APP)
    const inAlt = t.buffer.active.type
    await w(t, seq)
    await wait(20)
    const afterReset = { type: t.buffer.active.type, len: t.buffer.active.length, hist: countHist(t) }
    await w(t, 'newline-A\r\nnewline-B\r\nnewline-C\r\n')
    await wait(30)
    const b = t.buffer.active
    let histShown = 0
    for (let i = 0; i < b.length; i++) if (/^HIST /.test(b.getLine(i)?.translateToString(true) ?? '')) histShown++
    console.log(
      label.padEnd(16),
      `进屏=${inAlt.padEnd(9)}`,
      `复位后=${afterReset.type.padEnd(8)} len=${String(afterReset.len).padStart(3)} hist=${afterReset.hist}`,
      `| 新数据后 hist=${histShown}`,
      `type=${b.type}`
    )
    t.dispose()
  }
})()
