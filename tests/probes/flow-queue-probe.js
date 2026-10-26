/**
 * 显示队列整链探针（tests/probes/，不在 npm test 内）
 * 用真实的 xterm + termFlow 队列复刻 TerminalView 的入队/背压逻辑，
 * 灌入远超硬上限的洪泛数据，验证：
 *   1) 进程不崩、xterm 不抛（不触碰 50MB throw 路径）
 *   2) 显示队列在途字节始终有界
 *   3) 丢弃提示出现，且日志（这里用计数模拟）不受影响
 * 用法：npx esbuild tests/probes/flow-queue-probe.js --bundle --platform=node --outfile=/tmp/q.cjs && node /tmp/q.cjs
 */
const { Terminal } = require('@xterm/xterm')
const { DEFAULT_FLOW_LIMITS, pushDisplay, queueBytes, dropNotice } = require('../../src/renderer/src/components/termFlow')

const LINE = '[10-23 09:19:27.618][45801548][PRT][watchdog][tid:252]feed the dog !\r\n'

function makeView() {
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 360000, convertEol: true })
  let queue = []
  let draining = false
  let maxInFlight = 0
  let droppedTotal = 0
  let notices = 0

  function drain() {
    if (draining || queue.length === 0) return
    const next = queue.shift()
    draining = true
    try {
      term.write(next, () => {
        draining = false
        drain()
      })
    } catch (e) {
      draining = false
      console.log('  !! xterm 抛异常:', e.message)
      setTimeout(drain, 0)
    }
  }

  return {
    write(text) {
      const r = pushDisplay(queue, text, DEFAULT_FLOW_LIMITS)
      queue = r.queue
      if (r.droppedBytes > 0) {
        droppedTotal += r.droppedBytes
        notices++
        queue.push('\r\n')
        queue.push(dropNotice(r.droppedBytes))
      }
      maxInFlight = Math.max(maxInFlight, queueBytes(queue))
      drain()
    },
    /** 等队列排空（drain 回调链走完） */
    async idle() {
      while (draining || queue.length > 0) await new Promise((r) => setTimeout(r, 10))
    },
    stats: () => ({ maxInFlight, droppedTotal, notices, term }),
    dispose: () => term.dispose()
  }
}

;(async () => {
  const v = makeView()
  const BATCHES = 3000 // 3000 批 × 200 行 ≈ 21MB，远超 8MB 硬上限
  let logLines = 0
  const t0 = Date.now()
  for (let i = 0; i < BATCHES; i++) {
    v.write(LINE.repeat(200))
    if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0)) // 让出事件循环，模拟 IPC 事件间隔
  }
  const enqueueMs = Date.now() - t0
  await v.idle()
  const s = v.stats()
  const heap = (process.memoryUsage().heapUsed / 1048576).toFixed(0)
  console.log(`灌入 ${BATCHES} 批 × 200 行 ≈ ${((BATCHES * 200 * LINE.length) / 1048576).toFixed(1)}MB`)
  console.log(`入队耗时 ${enqueueMs}ms，排空后总耗时 ${Date.now() - t0}ms`)
  console.log(`队列在途峰值 ${(s.maxInFlight / 1048576).toFixed(2)}MB（硬上限 ${(DEFAULT_FLOW_LIMITS.hardBytes / 1048576).toFixed(0)}MB）`)
  console.log(`丢弃 ${(s.droppedTotal / 1048576).toFixed(1)}MB，提示 ${s.notices} 次`)
  console.log(`日志行数（模拟主进程通道，不受队列影响）=${BATCHES * 200}（此处未落盘，仅说明通道独立）`)
  console.log(`堆占用 ${heap}MB`)
  console.log(`缓冲行数 baseY=${s.term.buffer.active.baseY}`)
  s.term.dispose()
  if (s.maxInFlight > DEFAULT_FLOW_LIMITS.hardBytes * 2) {
    console.log('!! 队列上界失效')
    process.exit(1)
  }
})()
