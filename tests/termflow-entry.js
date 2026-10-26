/* 终端显示队列纯逻辑测试：水位判定 / 丢最旧块 / 丢弃计数 / 裸 CR 洪泛提示。
   队列逻辑与 TerminalView.vue 共用同一份 termFlow.ts（生产代码路径） */
const {
  DEFAULT_FLOW_LIMITS,
  BARE_CR_THRESHOLD,
  queueBytes,
  pushDisplay,
  dropNotice,
  newBareCrWatch,
  noteBareCr
} = require('../src/renderer/src/components/termFlow')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  [FAIL] ${name}`)
  }
}

// 造一个长度确定的字符串：Len n => n 字符 => n*2 字节（UTF-16 口径）
const chunk = (kb) => 'x'.repeat(kb * 512)
const KB = 1024

console.log('== pushDisplay（入队与水位） ==')
check('空块不入队', pushDisplay([], '').queue.length === 0 && pushDisplay([], '').droppedBytes === 0)
check('未超高水位：原样追加', (() => {
  const r = pushDisplay(['a'], 'b')
  return r.queue.join('') === 'ab' && r.droppedBytes === 0
})())
check('恰好等于硬上限不丢弃', (() => {
  const lim = { highBytes: 2 * KB, hardBytes: 4 * KB }
  const r = pushDisplay([chunk(1)], chunk(1), lim) // 共 4KB
  return r.queue.length === 2 && r.droppedBytes === 0
})())
check('超硬上限：丢最旧块并计数', (() => {
  const lim = { highBytes: 2 * KB, hardBytes: 4 * KB }
  const a = chunk(1)
  const r = pushDisplay([a], chunk(4), lim) // 1KB+4KB=5KB > 4KB → 丢 1KB，剩 4KB > high 2KB 但只剩 1 块
  return r.queue.length === 1 && r.droppedBytes === a.length * 2
})())
check('连续超限：回落到高水位以下', (() => {
  const lim = { highBytes: 2 * KB, hardBytes: 4 * KB }
  const q = [chunk(1), chunk(1), chunk(1)]
  const r = pushDisplay(q, chunk(2), lim) // 5KB > 4KB → 丢 1KB 得 4KB，仍 > 2KB → 再丢 → 3KB... 直到 ≤2KB
  return queueBytes(r.queue) <= lim.highBytes && r.droppedBytes === 3 * KB
})())
check('单块自身超硬上限也至少保留它', (() => {
  const lim = { highBytes: KB, hardBytes: 2 * KB }
  const big = chunk(8)
  const r = pushDisplay([chunk(1)], big, lim)
  return r.queue.length === 1 && r.queue[0] === big && r.droppedBytes === KB
})())
check('丢弃后队列内容为最新的块（保留"现在"）', (() => {
  const lim = { highBytes: 2 * KB, hardBytes: 4 * KB }
  const r = pushDisplay([chunk(1), chunk(1), chunk(1)], 'NEWEST', lim)
  return r.queue[r.queue.length - 1] === 'NEWEST'
})())
check('初始队列不被就地修改', (() => {
  const q = [chunk(1), chunk(1), chunk(1)]
  const before = q.length
  pushDisplay(q, chunk(1), { highBytes: 2 * KB, hardBytes: 4 * KB })
  return q.length === before
})())

console.log('== queueBytes（在途字节口径） ==')
check('空队列为 0', queueBytes([]) === 0)
check('按 UTF-16 计（1 字符 2 字节）', queueBytes(['abc']) === 6)
check('多块求和', queueBytes(['ab', 'cde']) === 10)

console.log('== dropNotice（丢弃提示行） ==')
check('含灰色提示前缀与"日志完整"', (() => {
  const s = dropNotice(4 * KB)
  return s.includes('[DevKit]') && s.includes('日志完整') && s.endsWith('\r\n')
})())
check('KB 数按四舍五入', dropNotice(KB * 3).includes('跳过 3 KB'))
check('极小丢弃量至少显示 1 KB', dropNotice(10).includes('跳过 1 KB'))

console.log('== noteBareCr（裸 CR 洪泛提示） ==')
check('未含裸 CR 不计数', (() => {
  const w = newBareCrWatch(1000)
  noteBareCr(w, false, 1000)
  return w.count === 0
})())
check('达到阈值提示一次', (() => {
  const w = newBareCrWatch(1000)
  let hits = 0
  for (let i = 0; i < BARE_CR_THRESHOLD; i++) if (noteBareCr(w, true, 1000 + i)) hits++
  return hits === 1 && w.notified
})())
check('未达阈值不提示', (() => {
  const w = newBareCrWatch(1000)
  let hits = 0
  for (let i = 0; i < BARE_CR_THRESHOLD - 1; i++) if (noteBareCr(w, true, 1000 + i)) hits++
  return hits === 0
})())
check('提示过就不再提示（每会话一次）', (() => {
  const w = newBareCrWatch(1000)
  for (let i = 0; i < BARE_CR_THRESHOLD; i++) noteBareCr(w, true, 1000 + i)
  let again = 0
  for (let i = 0; i < BARE_CR_THRESHOLD * 2; i++) if (noteBareCr(w, true, 2000 + i)) again++
  return again === 0
})())
check('跨窗口重置计数', (() => {
  const w = newBareCrWatch(1000)
  for (let i = 0; i < BARE_CR_THRESHOLD - 1; i++) noteBareCr(w, true, 1000 + i)
  // 2 秒后新窗口：计数归零，之前那 19 次不该累计
  noteBareCr(w, true, 4000)
  return w.count === 1
})())
check('超窗口后重新累计仍可提示', (() => {
  const w = newBareCrWatch(1000)
  for (let i = 0; i < BARE_CR_THRESHOLD; i++) noteBareCr(w, true, 1000 + i)
  // 已提示过；若换会话（newBareCrWatch）应能再次提示
  const w2 = newBareCrWatch(9000)
  let hits = 0
  for (let i = 0; i < BARE_CR_THRESHOLD; i++) if (noteBareCr(w2, true, 9000 + i)) hits++
  return w.notified && hits === 1
})())

console.log('== 默认上限 ==')
check('高水位 2MB / 硬上限 8MB', DEFAULT_FLOW_LIMITS.highBytes === 2 * 1024 * 1024 && DEFAULT_FLOW_LIMITS.hardBytes === 8 * 1024 * 1024)
check('硬上限低于 xterm 的 50MB 丢弃阈值（不会走到 throw）', DEFAULT_FLOW_LIMITS.hardBytes < 50 * 1024 * 1024)

console.log(`\n终端显示队列: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
