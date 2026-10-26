/**
 * 重开串口复位序列的端到端探针（tests/probes/）
 * 用生产实现 reopenResetSequence()，覆盖两种终端状态：
 *   主屏   —— 新会话输出必须**追加**在历史之后，不能覆盖顶部
 *   备用屏 —— 必须拉回主屏且历史完好（这是「前半段看不见」的主因）
 * 用法：npx esbuild tests/probes/reopen-reset-e2e-probe.js --bundle --platform=node --outfile=/tmp/re.cjs && node /tmp/re.cjs
 */
const { Terminal } = require('@xterm/xterm')
const { reopenResetSequence } = require('../../src/shared/vtguard')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(20)}\r\n`).join('')
const APP = '\x1b[H\x1b[2J' + Array.from({ length: 24 }, (_, i) => `\x1b[${i + 1};1Happ-row${String(i).padStart(2, '0')}`).join('')
const NEW = 'new-A\r\nnew-B\r\nnew-C\r\n'

const countHist = (t) => {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if (/^HIST /.test(b.getLine(i)?.translateToString(true) ?? '')) n++
  return n
}

async function trial(label, enterAlt) {
  const t = new Terminal({ cols: 100, rows: 24, scrollback: 200000, convertEol: true })
  await w(t, HISTORY)
  if (enterAlt) await w(t, '\x1b[?1049h' + APP)
  const typeBefore = t.buffer.active.type
  // 生产逻辑：按终端实际所处的屏幕决定序列
  await w(t, reopenResetSequence(typeBefore))
  await wait(20)
  const typeAfter = t.buffer.active.type
  await w(t, NEW)
  await wait(30)
  const b = t.buffer.active
  b.length // 保持引用
  t.scrollToTop()
  await wait(10)
  const topRow = (b.getLine(b.viewportY)?.translateToString(true) ?? '').trim()
  console.log(
    label.padEnd(26),
    `${typeBefore} → ${typeAfter}`.padEnd(18),
    `HIST=${String(countHist(t)).padStart(2)}/30`,
    `len=${String(b.length).padStart(3)}`,
    `顶部=${JSON.stringify(topRow.slice(0, 26))}`,
    topRow.startsWith('HIST 00') ? '✅ 历史完好' : '❌ 历史被破坏'
  )
  t.dispose()
}

;(async () => {
  console.log('重开串口：按终端实际状态发复位序列，新会话写 3 行\n')
  await trial('主屏重开（常见路径）', false)
  await trial('备用屏重开（top 未正常退出）', true)
})()
