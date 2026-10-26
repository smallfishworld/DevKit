/**
 * 原始流重建回放探针（tests/probes/）
 * 从清洗后的日志反推终端当时收到的「原始批次流」：
 *   - 同一时间戳 = 同一 32ms 批次
 *   - 批次内相邻日志行之间的分隔符是裸 \r（normalizeLines 把每个 \r 变一行）
 *   - 批次末行以 \r\n 结束
 * 然后回放进无头 xterm，检查「前半段是否真的不在缓冲区里」。
 * 用法：npx esbuild tests/probes/raw-replay-probe.js --bundle --platform=node --outfile=/tmp/rr.cjs && node /tmp/rr.cjs <log> [cols] [rows]
 */
const fs = require('fs')
const { Terminal } = require('@xterm/xterm')

const LOG = process.argv[2]
const COLS = Number(process.argv[3]) || 100
const ROWS = Number(process.argv[4]) || 28

const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean)
const batches = []
let cur = null
for (const l of lines) {
  const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\] ?(.*)$/.exec(l)
  if (!m) { if (cur) cur.bodies.push(l); continue }
  if (!cur || m[1] !== cur.ts) { cur = { ts: m[1], bodies: [] }; batches.push(cur) }
  cur.bodies.push(m[2])
}
// 批次内：相邻行用裸 \r 连接（模拟设备原地重绘），批末用 \r\n
const rawOf = (b) => b.bodies.map((x, i) => (i === b.bodies.length - 1 ? x + '\r\n' : x + '\r')).join('')

const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200000, convertEol: true })
const w = (s) => new Promise((r) => t.write(s, r))

function find(re) {
  const b = t.buffer.active
  for (let i = 0; i < b.length; i++) if (re.test(b.getLine(i)?.translateToString(true) ?? '')) return i
  return -1
}

;(async () => {
  for (const b of batches) await w(rawOf(b))
  await new Promise((r) => setTimeout(r, 100))
  const b = t.buffer.active
  console.log(`批次 ${batches.length}，终端 ${COLS}x${ROWS}`)
  console.log(`缓冲 length=${b.length} baseY=${b.baseY} viewportY=${b.viewportY}`)
  console.log(`cat 命令回显 @ ${find(/cat proc\/314\/status/)}`)
  console.log(`Name: davinci 出现在: ${(() => {
    const out = []
    for (let i = 0; i < b.length; i++) if (/^Name:\s+davinci/.test(b.getLine(i)?.translateToString(true) ?? '')) out.push(i)
    return JSON.stringify(out)
  })()}`)
  console.log(`nonvoluntary_ctxt_switches @ ${find(/nonvoluntary_ctxt_switches/)}`)
  console.log('--- 前 24 行 ---')
  for (let i = 0; i < Math.min(24, b.length); i++) {
    console.log(String(i).padStart(3), JSON.stringify((b.getLine(i)?.translateToString(true) ?? '').slice(0, 70)))
  }
  t.dispose()
})()
