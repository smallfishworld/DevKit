/**
 * 无头 xterm 堆压力探针（tests/probes/，不在 npm test 内）
 * 量化：scrollback 行数 -> xterm 缓冲堆内存 + 单次 GC 暂停时长
 * 不调 term.open()（无 DOM），write()/buffer 是纯 JS，堆行为与真实渲染一致
 * 用法：node --expose-gc tests/probes/xterm-heap-probe.js [行数步长] [scrollback]
 * 默认按当前产品默认回滚 20 万行压测；[scrollback] 可指定其他值对比
 * （实测 36 万行满缓冲堆 ~138MB、GC 暂停 48-54ms，是维持 20 万行的依据）。
 */
const { Terminal } = require('@xterm/xterm')

if (!globalThis.gc) {
  console.error('请用 --expose-gc 运行：node --expose-gc tests/probes/xterm-heap-probe.js')
  process.exit(1)
}

const LINE = '2026-10-13 12:00:00.000 [INFO] device log line with some ascii payload 0123456789 ABCDEFG\r\n'

// xterm 主包不依赖 DOM 也能 write（不 open）；write 有内部异步节流，批量后需等 flush
function main() {
  const stepLines = Number(process.argv[2]) || 50_000
  const scrollback = Number(process.argv[3]) || 200_000
  const term = new Terminal({ scrollback, convertEol: false, cols: 120, rows: 30 })
  const start = process.memoryUsage().heapUsed
  console.log(`初始 heapUsed: ${(start / 1048576).toFixed(1)} MB，scrollback=${scrollback}`)
  for (let total = 0; total < scrollback; total += stepLines) {
    for (let i = 0; i < stepLines; i++) term.write(LINE)
    // xterm write 是异步节流的：等它把队列全部解析完再测
    const wait = () =>
      new Promise((resolve) => {
        term.write('', () => setTimeout(resolve, 300))
      })
    void (async () => {
      await wait()
      globalThis.gc()
      globalThis.gc()
      const heap = process.memoryUsage().heapUsed
      let worst = 0
      for (let k = 0; k < 3; k++) {
        const junk = []
        for (let i = 0; i < 200_000; i++) junk.push({ a: i })
        junk.length = 0
        const t0 = process.hrtime.bigint()
        globalThis.gc()
        const dt = Number(process.hrtime.bigint() - t0) / 1e6
        if (dt > worst) worst = dt
      }
      console.log(
        `${String(total + stepLines).padStart(7)} 行 | heapUsed ${(heap / 1048576).toFixed(1).padStart(7)} MB | ` +
          `最大 GC 暂停 ${worst.toFixed(0).padStart(4)} ms`
      )
    })()
  }
}

main()
