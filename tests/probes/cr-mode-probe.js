/**
 * 裸 CR 显示模式探针（tests/probes/，不在 npm test 内）
 * 复现「设备用 \r 原地重绘」时 raw 与 newline 两种模式的屏幕差异：
 * raw = 真实 VT 语义（光标回行首覆盖，屏上只剩最后一帧）
 * newline = crMode:'newline'（与日志归一一致，每帧单独成行）
 * 用法：npx esbuild tests/probes/cr-mode-probe.js --bundle --platform=node --outfile=/tmp/x.cjs && node /tmp/x.cjs
 */
const { Terminal } = require('@xterm/xterm')
const { crToNewline } = require('../../src/shared/logtext')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function w(t, s) {
  await new Promise((r) => t.write(s, r))
  await wait(5)
}

function dump(t, label) {
  const b = t.buffer.active
  const last = Math.min(b.length - 1, b.baseY + b.cursorY)
  const rows = []
  for (let i = Math.max(0, last - 2); i <= last; i++) {
    rows.push((b.getLine(i)?.translateToString(true) ?? '').trimEnd())
  }
  console.log(
    label.padEnd(30),
    '| row=' + (b.baseY + b.cursorY),
    'col=' + b.cursorX,
    '| 末几行: ' + JSON.stringify(rows)
  )
}

/** 设备失步后的典型输出：同一条记录被 \r 反复重绘 */
const DEVICE_BURST = ('[10-23 09:19:27.618][45801548][PRT][watchdog]feed the dog !\r').repeat(6)

async function run(mode) {
  console.log(`--- crMode = ${mode} ---`)
  const t = new Terminal({ cols: 80, rows: 10, scrollback: 1000, convertEol: true })
  await w(t, '# ')
  const src = mode === 'newline' ? crToNewline(DEVICE_BURST) : DEVICE_BURST
  await w(t, src)
  dump(t, `${mode}：设备 \r 重绘后`)
  // 用户随后键入（设备不回显，靠本地回显写入）
  await w(t, mode === 'newline' ? crToNewline('debug') : 'debug')
  dump(t, `${mode}：随后键入 debug`)
  t.dispose()
}

;(async () => {
  await run('raw')
  await run('newline')
})()
