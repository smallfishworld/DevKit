/**
 * 备用屏「同会话内卡住」探针（tests/probes/）
 * 场景：设备进了备用屏，程序退出时没有发 `?1049l`（或该序列在链路上丢了），
 * 此后整个会话都留在没有回滚的备用屏里。用户不需要断开重开就能遇到
 * 「前半段看不见、滚动也看不见、后半段还在」。
 * 对比：
 *   P 原样放行   ：留在备用屏，之后所有输出都没有回滚
 *   D 换行腾屏   ：进入时用 rows 个换行把当前屏顶进回滚再清屏；退出时再清一次
 *     重复进入/退出 10 次，看回滚是否被灌入大量空行
 * 用法：npx esbuild tests/probes/altscreen-session-probe.js --bundle --platform=node --outfile=/tmp/as.cjs && node /tmp/as.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))
const ROWS = 24

const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(30)}\r\n`).join('')
const CAT = Array.from({ length: 53 }, (_, i) =>
  i === 0 ? '# cat proc/314/status\r\n' : `Field${String(i).padStart(2, '0')}:\tvalue-${i} ${'v'.repeat(20)}\r\n`
).join('')
const APP = '\x1b[H\x1b[2J' + Array.from({ length: ROWS }, (_, i) => `\x1b[${i + 1};1Happ-row${String(i).padStart(2, '0')}`).join('')

const find = (t, needle) => {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
  return -1
}

function policyD(rows) {
  return {
    enter: '\r\n'.repeat(rows) + '\x1b[H\x1b[2J',
    leave: '\x1b[H\x1b[2J'
  }
}

async function trial(label, enter, leave, toggles) {
  const t = new Terminal({ cols: 100, rows: ROWS, scrollback: 200000, convertEol: true })
  await w(t, HISTORY)
  for (let i = 0; i < toggles; i++) {
    await w(t, enter + APP + leave)
  }
  // 程序「退出但没发 ?1049l」→ 直接回到 shell 继续干活
  await w(t, CAT)
  await wait(40)
  const b = t.buffer.active
  let blanks = 0
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').trim() === '') blanks++
  t.scrollToTop()
  await wait(10)
  const cmd = find(t, '# cat proc/314/status')
  const canScroll = cmd !== -1 && b.viewportY < cmd
  console.log(
    label.padEnd(28),
    `type=${b.type.padEnd(9)}`,
    `len=${String(b.length).padStart(5)}`,
    `空白行=${String(blanks).padStart(4)}`,
    `命令@${String(cmd).padStart(4)}`,
    `中段@${String(find(t, 'Field20:')).padStart(4)}`,
    `可滚回=${canScroll ? '是' : '否'}`
  )
  t.dispose()
}

;(async () => {
  console.log(`设备进备用屏后不发 ?1049l，之后 cat 53 行 @ 100x${ROWS}\n`)
  await trial('P 原样放行 ×1', '\x1b[?1049h', '', 1)
  const d = policyD(ROWS)
  await trial('D 换行腾屏 ×1', d.enter, d.leave, 1)
  await trial('D 换行腾屏 ×10（看空行）', d.enter, d.leave, 10)
})()
