/**
 * 屏幕擦除/切屏语义探针（tests/probes/）
 * 量化「设备发清屏/复位/切屏时，屏幕上已滚出可视区与还在屏上的内容分别去哪了」。
 * 用法：npx esbuild tests/probes/erase-semantics-probe.js --bundle --platform=node --outfile=/tmp/e.cjs && node /tmp/e.cjs
 */
const { Terminal } = require('@xterm/xterm')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const OUT = Array.from({ length: 60 }, (_, i) => `LINE ${String(i).padStart(2, '0')} ${'y'.repeat(30)}\r\n`).join('')
const has = (t, needle) => {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
  return -1
}
const probe = (t, label) => {
  const b = t.buffer.active
  console.log(
    label.padEnd(30),
    `len=${String(b.length).padStart(3)} baseY=${String(b.baseY).padStart(3)}`,
    `LINE 00@${String(has(t, 'LINE 00')).padStart(3)}`,
    `LINE 30@${String(has(t, 'LINE 30')).padStart(3)}`,
    `LINE 59@${String(has(t, 'LINE 59')).padStart(3)}`,
    `| 屏首=${JSON.stringify((b.getLine(b.viewportY)?.translateToString(true) ?? '').slice(0, 12))}`
  )
}

async function scenario(label, opts, seq) {
  const t = new Terminal({ cols: 40, rows: 24, scrollback: 200000, convertEol: true, ...opts })
  await w(t, OUT)
  await wait(30)
  probe(t, label + ' 写入后')
  await w(t, seq)
  await wait(30)
  probe(t, label + ' 序列后')
  t.dispose()
}

;(async () => {
  console.log('60 行写入 24 行屏 → 36 行进回滚，末 24 行在屏上\n')
  await scenario('A 基准（无序列）', {}, '')
  await scenario('B ED2(CSI 2J)', {}, '\x1b[2J')
  await scenario('C ED2 + scrollOnErase', { scrollOnEraseInDisplay: true }, '\x1b[2J')
  await scenario('D ED3(CSI 3J)', {}, '\x1b[3J')
  await scenario('E RIS(ESC c)', {}, '\x1bc')
  await scenario('F 进备用屏 ?1049h', {}, '\x1b[?1049h')
  await scenario('G ED2+H 后写新内容', {}, '\x1b[2J\x1b[HNEW\r\n')
})()
