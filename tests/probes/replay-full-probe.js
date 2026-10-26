/**
 * 完整会话回放探针（tests/probes/，不在 npm test 内）
 * 把真实日志 serial-COM1-20261023-101006.log 的全量内容按"时间戳分组 = 一批"
 * 回放进无头 xterm，检查 53 行 cat 输出在会话结束时是否还在回滚缓冲里。
 * 用法：npx esbuild tests/probes/replay-full-probe.js --bundle --platform=node --outfile=/tmp/r.cjs && node /tmp/r.cjs <日志路径> [cols] [rows] [terminator]
 */
const fs = require('fs')
const { Terminal } = require('@xterm/xterm')

const LOG = process.argv[2]
const COLS = Number(process.argv[3]) || 100
const ROWS = Number(process.argv[4]) || 28
const TERM = process.argv[5] === 'cr' ? '\r' : '\r\n'

const raw = fs.readFileSync(LOG, 'utf8')
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
// 剥掉 "[YYYY-MM-DD HH:MM:SS.mmm] " 前缀，按时间戳分组
const groups = []
let cur = { ts: '', bodies: [] }
for (const l of lines) {
  const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\] ?(.*)$/.exec(l)
  if (!m) continue
  if (m[1] !== cur.ts) {
    if (cur.bodies.length) groups.push(cur)
    cur = { ts: m[1], bodies: [] }
  }
  cur.bodies.push(m[2])
}
if (cur.bodies.length) groups.push(cur)
console.log(`日志 ${lines.length} 行 -> ${groups.length} 批；终端 ${COLS}x${ROWS}，行终止符 ${JSON.stringify(TERM)}`)

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200000, convertEol: true })
const write = (s) => new Promise((r) => term.write(s, r))

function findIndex(re) {
  const b = term.buffer.active
  for (let i = 0; i < b.length; i++) {
    if (re.test(b.getLine(i)?.translateToString(true) ?? '')) return i
  }
  return -1
}

;(async () => {
  for (const g of groups) {
    await write(g.bodies.map((b) => b + TERM).join(''))
  }
  const b = term.buffer.active
  const marks = {
    '第1次 cat 命令回显': /cat proc\/314\/status/,
    '第1次 Name: davinci': /^Name:\s+davinci/,
    '第1次 nonvoluntary': /nonvoluntary_ctxt_switches/,
    '第2次 Name: davinci': /^Name:\s+davinci/
  }
  console.log(`\n缓冲 length=${b.length}  baseY=${b.baseY}  viewportY=${b.viewportY}  光标行=${b.baseY + b.cursorY}`)
  // 统计所有 Name: davinci 出现位置
  const names = []
  for (let i = 0; i < b.length; i++) if (/^Name:\s+davinci/.test(b.getLine(i)?.translateToString(true) ?? '')) names.push(i)
  console.log(`Name: davinci 出现在行索引: [${names.join(', ')}]（缓冲保留 ${b.length} 行，200k 回滚远未满）`)
  console.log(`nonvoluntary 行索引: ${findIndex(/nonvoluntary_ctxt_switches/)}`)
  // 顶部 3 行
  for (let i = 0; i < 3; i++) console.log(`  行${i}: ${JSON.stringify((b.getLine(i)?.translateToString(true) ?? '').slice(0, 60))}`)
  term.dispose()
})()
