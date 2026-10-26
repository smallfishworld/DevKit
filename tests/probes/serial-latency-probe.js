/**
 * 串口日志时延探针（tests/probes/，不在 npm test 内）
 * 用设备自带时间戳（watchdog 行的 [MM-DD HH:MM:SS.mmm]）与主机落盘时间戳做差，
 * 得到每条日志从"设备发出"到"主进程写入"的端到端时延（含恒定时钟偏差）。
 * 时延突然跳升 = 主进程接收/落盘链路堵住；时延平稳而终端仍不刷新 = 渲染端问题。
 * 用法：node tests/probes/serial-latency-probe.js <日志文件>
 */
const fs = require('node:fs')

const LINE = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\] \[(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\]/

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('用法: node tests/probes/serial-latency-probe.js <日志文件>')
    process.exit(1)
  }
  const raw = fs.readFileSync(file, 'utf8')
  const rows = []
  for (const ln of raw.split(/\r?\n/)) {
    const m = LINE.exec(ln)
    if (!m) continue
    const host = new Date(
      +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]
    ).getTime()
    // 设备时间不带年份：用主机时刻的年份补齐，跨年误差忽略
    let dev = new Date(+m[1], +m[8] - 1, +m[9], +m[10], +m[11], +m[12], +m[13]).getTime()
    if (dev - host > 180 * 86400 * 1000) dev -= 365 * 86400 * 1000
    if (host - dev > 180 * 86400 * 1000) dev += 365 * 86400 * 1000
    rows.push({ host, dev, lag: host - dev, line: ln })
  }
  if (rows.length === 0) {
    console.log('没有可解析的设备时间戳行')
    return
  }
  const base = rows[0].lag
  let worst = 0
  for (const r of rows) {
    const d = r.lag - base
    r.drift = d
    if (Math.abs(d) > Math.abs(worst)) worst = d
  }
  console.log(`可解析行数: ${rows.length}，首行基准偏差 ${base} ms`)
  console.log(`时延相对基准的最大偏移: ${worst} ms`)
  // 每 30 行采样一次，打印相对时延（正值 = 主进程落后于设备）
  console.log('\n主机时 - 设备时 的相对变化（每秒采样）:')
  let lastReport = 0
  for (const r of rows) {
    if (r.host - lastReport < 1000) continue
    lastReport = r.host
    const t = new Date(r.host).toISOString().slice(11, 23)
    console.log(`  ${t}  drift=${String(Math.round(r.drift)).padStart(7)} ms`)
  }
  // 集中列出漂移尖峰
  const spikes = rows.filter((r) => Math.abs(r.drift) > Math.abs(base) + 3000)
  console.log(`\n|drift| > 3s 的行数: ${spikes.length}`)
  for (const r of spikes.slice(0, 10)) {
    console.log(`  ${new Date(r.host).toISOString().slice(11, 23)} drift=${Math.round(r.drift)}ms`)
  }
}

main()
