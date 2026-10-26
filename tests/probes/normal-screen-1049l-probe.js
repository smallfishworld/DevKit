/**
 * `?1049l` 在主屏上是否破坏光标/历史探针（tests/probes/）
 *
 * 争点：code-review 断言「主屏（从未进过备用屏）发 ?1049l 会把光标倒回 0，
 * 于是下个会话的输出覆盖回滚顶部」，并称实测 row0 变成 'Linux boot: hello0'。
 * 本探针按它给的场景原样复现，并对比只发 DECSTR(`!p`) 的版本。
 *
 * 用法：npx esbuild tests/probes/normal-screen-1049l-probe.js --bundle --platform=node --outfile=/tmp/np.cjs && node /tmp/np.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const OLD = Array.from({ length: 15 }, (_, i) => `old-session line ${i}\r\n`).join('')
const NEW = 'Linux boot: hello\r\nsecond line\r\n'

const dump = (t, rows = 4) => {
  const b = t.buffer.active
  const out = []
  for (let i = 0; i < rows; i++) out.push((b.getLine(i)?.translateToString(true) ?? '').trim())
  return out
}

async function trial(label, resetSeq) {
  const t = new Terminal({ cols: 60, rows: 40, scrollback: 200000, convertEol: true })
  await w(t, OLD)
  await wait(20)
  const before = { len: t.buffer.active.length, y: t.buffer.active.cursorY, top: dump(t, 3) }
  // 模拟「重开串口」：先复位，再来新会话数据
  await w(t, resetSeq)
  await wait(20)
  const mid = { y: t.buffer.active.cursorY, len: t.buffer.active.length }
  await w(t, NEW)
  await wait(30)
  const b = t.buffer.active
  const after = { len: b.length, y: b.cursorY, top: dump(t, 3) }
  const corrupted = after.top[0] !== before.top[0] || after.top[1] !== before.top[1]

  console.log(`\n${label}`)
  console.log('  复位前 :', JSON.stringify(before))
  console.log('  复位后 :', JSON.stringify(mid))
  console.log('  新数据后:', JSON.stringify(after))
  console.log('  顶部历史被覆盖 :', corrupted ? '★ 是' : '否')
  t.dispose()
}

;(async () => {
  console.log('场景：主屏 15 行（从未进备用屏）→ 重开复位 → 新会话 2 行')
  await trial('A 不复位（基线）', '')
  await trial('B 只发 ?1049l', '\x1b[?1049l')
  await trial('C 只发 DECSTR !p（主屏当前实现）', '\x1b[!p')
  await trial('D 无条件 ?1049l + !p（旧实现）', '\x1b[?1049l\x1b[!p')
})()
