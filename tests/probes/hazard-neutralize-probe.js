/**
 * 破坏性序列中和探针（tests/probes/）
 * 复现「设备发清屏/复位/切全屏 → 前半段滚出可视区的内容永久消失、滚动也看不到、尾部仍可见」，
 * 并验证中和后（丢弃 ED3、RIS 降级为仅清屏、忽略备用屏）内容完整保留、可回滚。
 * 用法：npx esbuild tests/probes/hazard-neutralize-probe.js --bundle --platform=node --outfile=/tmp/h.cjs && node /tmp/h.cjs
 */
const { Terminal } = require('@xterm/xterm')
const { VtGuard } = require('../../src/shared/vtguard')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const STATUS = Array.from({ length: 53 }, (_, i) =>
  i === 0 ? '# cat proc/314/status\r\n' : `Field${String(i).padStart(2, '0')}:\tvalue-${i} ${'v'.repeat(20)}\r\n`
).join('')

const has = (t, needle) => {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
  return -1
}

/** 设备末尾追加一条破坏性序列（模拟真实固件行为） */
const HAZARDS = {
  'ED3 \x1b[3J': '\x1b[3J',
  'RIS \x1bc': '\x1bc',
  '备用屏 \x1b[?1049h': '\x1b[?1049h'
}

/**
 * 备用屏是**不中和**的（丢 ?1049h 会让全屏程序覆盖主屏，见 altscreen-policy-probe.js），
 * 这一行的「已中和」输出与「未中和」相同是预期结果；它的处置位在重开时 resetVtState()，
 * 由 altscreen-carryover-probe.js 验证。
 */

/** 用生产实现（src/shared/vtguard.ts）中和破坏性序列 */
function neutralize(text) {
  return new VtGuard().push(text).out
}

async function run(label, seq, patch) {
  const t = new Terminal({ cols: 100, rows: 28, scrollback: 200000, convertEol: true })
  await w(t, STATUS)
  await w(t, seq)
  await wait(40)
  const b = t.buffer.active
  const first = has(t, '# cat proc/314/status')
  const mid = has(t, 'Field20:')
  const last = has(t, 'Field52:')
  // 把视口拉到最顶，看用户能不能滚回去
  t.scrollToTop()
  await wait(20)
  const topRow = (b.getLine(b.viewportY)?.translateToString(true) ?? '').trim()
  console.log(
    label.padEnd(24),
    `len=${String(b.length).padStart(3)}`,
    `命令@${String(first).padStart(3)}`,
    `中段@${String(mid).padStart(3)}`,
    `末段@${String(last).padStart(3)}`,
    `| 滚到顶首行=${JSON.stringify(topRow.slice(0, 20))}`
  )
  t.dispose()
  void patch
}

;(async () => {
  console.log('53 行 cat 输出 @ 100x28（尾部 3 行追加破坏性序列）\n')
  await run('基准（无序列）', '')
  for (const [name, seq] of Object.entries(HAZARDS)) await run('未中和 ' + name, seq)
  console.log('')
  for (const [name, seq] of Object.entries(HAZARDS)) await run('已中和 ' + name, neutralize(seq))
})()
