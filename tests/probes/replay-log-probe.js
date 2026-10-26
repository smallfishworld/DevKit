/**
 * 日志回放探针（tests/probes/，不在 npm test 内）
 * 把一份已清洗的串口日志按原始批次（同一时间戳 = 同一批）重新灌进无头 xterm，
 * 检查"输出超过一屏时前半段是否还在回滚缓冲里"。
 * 用法：npx esbuild tests/probes/replay-log-probe.js --bundle --platform=node --outfile=/tmp/r.cjs && node /tmp/r.cjs <日志>
 */
const fs = require('node:fs')
const { Terminal } = require('@xterm/xterm')

const file = process.argv[2]
const rows = Number(process.argv[3]) || 24

const raw = fs.readFileSync(file, 'utf8')
const batches = new Map()
const order = []
for (const line of raw.split(/\r?\n/)) {
  const m = /^\[([0-9-]+ [0-9:.]+)\] ?(.*)$/.exec(line)
  if (!m) continue
  const ts = m[1]
  if (!batches.has(ts)) { batches.set(ts, []); order.push(ts) }
  batches.get(ts).push(m[2])
}

;(async () => {
  const t = new Terminal({ cols: 100, rows, scrollback: 200000, convertEol: true })
  for (const ts of order) {
    const text = batches.get(ts).join('\r\n') + '\r\n'
    await new Promise((r) => t.write(text, r))
  }
  const b = t.buffer.active
  const all = []
  for (let i = 0; i < b.length; i++) all.push(b.getLine(i)?.translateToString(true) ?? '')
  const find = (s) => all.findIndex((l) => l.includes(s))
  console.log(`批次 ${order.length}，缓冲行 ${b.length}，baseY=${b.baseY}，rows=${rows}`)
  console.log(`Name: 行号 = ${find('Name:')}（-1 = 已被丢弃）`)
  console.log(`nonvoluntary_ctxt_switches 行号 = ${find('nonvoluntary_ctxt_switches')}`)
  console.log(`cat proc/314/status 行号 = ${find('cat proc/314/status')}`)
  const i = find('Name:')
  if (i >= 0) {
    console.log('缓冲区前 5 行:', JSON.stringify(all.slice(Math.max(0, i - 1), i + 4)))
  }
  t.dispose()
})()
