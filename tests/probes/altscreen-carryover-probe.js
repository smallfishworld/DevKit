/**
 * 备用屏跨会话残留探针（tests/probes/）
 *
 * 复现用户报告的真实序列（对照 serial-COM1-20261023-101006.log）：
 *   10:07:50 / 10:08:49 跑 top（进备用屏）→ 没有正常退出 → 10:09:21 断开串口
 *   → 10:09:24 重开 → cat proc/314/status（53 行）
 * 若重开时终端仍停在备用屏，cat 输出会落进**没有回滚**的备用屏，
 * 于是「前半段看不见、滚动也看不见、后半段还在」——与报告完全一致。
 *
 * 对比三种处置：
 *   S 不处置（旧版本）      ：重开时仍停在备用屏
 *   R 重开时 resetVtState() ：先 ?1049l + DECSTR 拉回主屏（本次修复）
 *   N 中和 ?1049h（曾试过） ：全屏程序直接画在主屏上，反而覆盖当前屏历史
 *
 * 用法：npx esbuild tests/probes/altscreen-carryover-probe.js --bundle --platform=node --outfile=/tmp/ac.cjs && node /tmp/ac.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(30)}\r\n`).join('')

/** 被中断的 top：进备用屏 + 一次整屏绘制，**永不发 ?1049l** */
const TOP = (() => {
  const rows = Array.from({ length: 24 }, (_, i) => `\x1b[${i + 1};1Htop-line${String(i).padStart(2, '0')} ${'t'.repeat(20)}`).join('')
  return '\x1b[?1049h\x1b[H\x1b[2J' + rows
})()

/** cat proc/314/status 的 53 行输出（与真实日志同规模） */
const CAT = Array.from({ length: 53 }, (_, i) =>
  i === 0 ? '# cat proc/314/status\r\n' : `Field${String(i).padStart(2, '0')}:\tvalue-${i} ${'v'.repeat(20)}\r\n`
).join('')

const find = (t, needle) => {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
  return -1
}

async function trial(label, onReopen, neutralizeAlt) {
  const t = new Terminal({ cols: 100, rows: 24, scrollback: 200000, convertEol: true })
  await w(t, HISTORY)
  await w(t, neutralizeAlt ? TOP.replace(/\x1b\[\?1049h/g, '') : TOP)
  const inAlt = t.buffer.active.type
  // 断开 → 重开：旧版本什么都没做；新版本调用 resetVtState()
  await w(t, onReopen)
  await wait(20)
  const afterReopen = t.buffer.active.type
  await w(t, CAT)
  await wait(40)
  const b = t.buffer.active
  const atPrompt = find(t, '# cat proc/314/status')
  const mid = find(t, 'Field20:')
  t.scrollToTop()
  await wait(20)
  const topRow = (b.getLine(b.viewportY)?.translateToString(true) ?? '').trim()
  const canScroll = atPrompt !== -1 && b.viewportY < atPrompt
  console.log(
    label.padEnd(34),
    `断线时=${inAlt.padEnd(9)}`,
    `重开后=${afterReopen.padEnd(9)}`,
    `len=${String(b.length).padStart(3)}`,
    `命令@${String(atPrompt).padStart(3)}`,
    `中段@${String(mid).padStart(3)}`,
    `可滚回=${canScroll ? '是' : '否'}`,
    `滚到顶=${JSON.stringify(topRow.slice(0, 18))}`
  )
  t.dispose()
}

;(async () => {
  console.log('场景：top 被中断（备用屏未退出）→ 断开 → 重开 → cat 53 行\n')
  await trial('S 重开不处置（旧版本）', '', false)
  await trial('R 重开 resetVtState()（修复）', '\x1b[?1049l\x1b[!p', false)
  await trial('N 中和 ?1049h（曾试过）', '', true)
})()
