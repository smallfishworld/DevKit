/* 回滚保护纯逻辑测试：ED3/RIS/备用屏中和、跨批切分拼回、普通序列原样放行
   与串口终端共用同一份生产代码路径（src/shared/vtguard.ts） */
const { VtGuard, neutralizeVt, reopenResetSequence } = require('../src/shared/vtguard')

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

console.log('== 普通内容原样放行 ==')
check('纯文本不变', neutralizeVt('hello\r\n').out === 'hello\r\n')
check('普通 SGR 颜色保留', neutralizeVt('\x1b[32mok\x1b[0m').out === '\x1b[32mok\x1b[0m')
check('清屏 CSI 2J 保留（设备清屏是正常语义）', neutralizeVt('a\x1b[2Jb').out === 'a\x1b[2Jb')
check('CSI 1J / K 保留', neutralizeVt('\x1b[1J\x1b[K').out === '\x1b[1J\x1b[K')
check('光标移动序列保留', neutralizeVt('\x1b[2A\x1b[3C').out === '\x1b[2A\x1b[3C')
check('空批无统计', (() => {
  const r = neutralizeVt('')
  return r.out === '' && r.stats.eraseScrollback === 0 && r.stats.hardReset === 0 && r.stats.altScreen === 0
})())

console.log('== CSI 3J（擦除回滚） ==')
check('单独 ED3 被丢掉', (() => {
  const r = neutralizeVt('\x1b[3J')
  return r.out === '' && r.stats.eraseScrollback === 1
})())
check('clear 惯用组合只剩 2J+H', (() => {
  const r = neutralizeVt('\x1b[H\x1b[2J\x1b[3J')
  return r.out === '\x1b[H\x1b[2J' && r.stats.eraseScrollback === 1
})())
check('夹在正文中间时正文不受影响', (() => {
  const r = neutralizeVt('before\x1b[3Jafter')
  return r.out === 'beforeafter' && r.stats.eraseScrollback === 1
})())
check('同批多次计数正确', neutralizeVt('\x1b[3J\x1b[3J\x1b[3J').stats.eraseScrollback === 3)
check('ED0/ED1/ED2 不算命中', neutralizeVt('\x1b[0J\x1b[1J\x1b[2J').stats.eraseScrollback === 0)
check('CSI 3;5H（带第二参数的定位）不被误伤', neutralizeVt('\x1b[3;5HX').out === '\x1b[3;5HX')

console.log('== ESC c（硬复位） ==')
check('RIS 降级为清屏', (() => {
  const r = neutralizeVt('\x1bc')
  return r.out === '\x1b[2J\x1b[H' && r.stats.hardReset === 1
})())
check('RIS 夹在正文中：正文保留', (() => {
  const r = neutralizeVt('a\x1bcb')
  return r.out === 'a\x1b[2J\x1b[Hb' && r.stats.hardReset === 1
})())
check('ESC 后跟别的字符不算 RIS', (() => {
  const r = neutralizeVt('\x1b[31mred')
  return r.out === '\x1b[31mred' && r.stats.hardReset === 0
})())

console.log('== 备用屏 ?1049h / ?1049l / ?47h（只统计，原样放行） ==')
// 实测（tests/probes/altscreen-policy-probe.js）：丢掉 ?1049h 会让 vi/top 的绝对光标重绘
// 落进主屏、覆盖当前屏已有内容（30 行历史只剩 7 行）。所以必须原样放行，只计数。
check('?1049h 原样放行', (() => {
  const r = neutralizeVt('\x1b[?1049h')
  return r.out === '\x1b[?1049h' && r.stats.altScreen === 1
})())
check('?1049l 原样放行', (() => {
  const r = neutralizeVt('\x1b[?1049l')
  return r.out === '\x1b[?1049l' && r.stats.altScreen === 1
})())
check('?47h 原样放行并计数', (() => {
  const r = neutralizeVt('\x1b[?47h')
  return r.out === '\x1b[?47h' && r.stats.altScreen === 1
})())
check('多参数含备用屏模式时整条保留', (() => {
  const r = neutralizeVt('\x1b[?1049;25h')
  return r.out === '\x1b[?1049;25h' && r.stats.altScreen === 1
})())
check('只含备用屏模式也多参数计数', neutralizeVt('\x1b[?1047;1049h').stats.altScreen === 1)
check('无关私用模式（?25h 光标）不计数', (() => {
  const r = neutralizeVt('\x1b[?25h')
  return r.out === '\x1b[?25h' && r.stats.altScreen === 0
})())
check('1080/1004 等其他模式不误伤', neutralizeVt('\x1b[?1080h\x1b[?1004h').out === '\x1b[?1080h\x1b[?1004h')

console.log('== 跨批切分（32ms 批次边界） ==')
check('ESC | [3J 拼回后仍可中和', (() => {
  const g = new VtGuard()
  const a = g.push('text\x1b')
  const b = g.push('[3J more')
  return a.out === 'text' && b.out === ' more' && b.stats.eraseScrollback === 1
})())
check('ESC[3 | J 拼回后仍可中和', (() => {
  const g = new VtGuard()
  const a = g.push('\x1b[3')
  const b = g.push('J')
  return a.out === '' && b.out === '' && b.stats.eraseScrollback === 1
})())
check('ESC[?104 | 9h 拼回后仍可识别', (() => {
  const g = new VtGuard()
  const a = g.push('x\x1b[?104')
  const b = g.push('9h y')
  return a.out === 'x' && b.out === '\x1b[?1049h y' && b.stats.altScreen === 1
})())
check('半截序列不会先吐出去（同一批内先扣留）', (() => {
  const g = new VtGuard()
  return g.push('a\x1b[?104').out === 'a'
})())
check('长参数表被切开也不漏（?1004; | 1049h）', (() => {
  const g = new VtGuard()
  const a = g.push('\x1b[?1004;')
  const b = g.push('1049h!')
  return a.out === '' && b.out === '\x1b[?1004;1049h!' && b.stats.altScreen === 1
})())
check('已完整的中位数序列不滞留', (() => {
  const g = new VtGuard()
  return g.push('\x1b[12;34H').out === '\x1b[12;34H'
})())
check('批尾裸 ESC 被扣留，下一批补成颜色码后原样吐出', (() => {
  const g = new VtGuard()
  const a = g.push('a\x1b')
  const b = g.push('[31mred')
  return a.out === 'a' && b.out === '\x1b[31mred' && b.stats.eraseScrollback === 0
})())
check('批尾 ESC[ 被扣留（不把半截 CSI 吐给终端）', (() => {
  const g = new VtGuard()
  return g.push('x\x1b[').out === 'x'
})())
check('reset() 清掉滞留尾巴', (() => {
  const g = new VtGuard()
  g.push('tail\x1b[')
  g.reset()
  return g.push('ok').out === 'ok'
})())

console.log('== 组合与统计 ==')
check('一批里三种命中都计数', (() => {
  const r = neutralizeVt('\x1b[3J\x1bc\x1b[?1049h')
  return r.stats.eraseScrollback === 1 && r.stats.hardReset === 1 && r.stats.altScreen === 1
})())
check('ED3/RIS 被中和，备用屏原样留在原位', neutralizeVt('\x1b[3J\x1bc\x1b[?1049h').out === '\x1b[2J\x1b[H\x1b[?1049h')
check('备用屏夹在正文中：正文与序列都保留', (() => {
  const r = neutralizeVt('before\x1b[?1049hafter')
  return r.out === 'before\x1b[?1049hafter' && r.stats.altScreen === 1
})())
check('未命中时统计全 0', (() => {
  const r = neutralizeVt('normal output\r\n')
  return r.stats.eraseScrollback === 0 && r.stats.hardReset === 0 && r.stats.altScreen === 0
})())
check('两个独立实例互不干扰', (() => {
  const g1 = new VtGuard()
  const g2 = new VtGuard()
  g1.push('\x1b[')
  return g2.push('x').out === 'x'
})())

console.log('== 重开串口的复位序列（reopenResetSequence） ==')
// 实测（tests/probes/normal-screen-1049l-probe.js）：主屏上发 ?1049l 会把光标倒回 0，
// 新会话输出覆盖回滚顶部。故只在备用屏里才发它。
check('主屏不发 ?1049l（否则覆盖回滚顶部）', reopenResetSequence('normal') === '\x1b[!p')
check('主屏也要发 DECSTR 清残留模式', reopenResetSequence('normal').includes('\x1b[!p'))
check('备用屏发 ?1049l 退出', reopenResetSequence('alternate').startsWith('\x1b[?1049l'))
check('备用屏同时发 DECSTR', reopenResetSequence('alternate') === '\x1b[?1049l\x1b[!p')
check('两种情况下 DECSTR 都在末尾（先退屏再复位）', (() => {
  const n = reopenResetSequence('normal')
  const a = reopenResetSequence('alternate')
  return n.endsWith('\x1b[!p') && a.endsWith('\x1b[!p')
})())
check('序列里不含清回滚（ED3）与会清屏的 2J', (() => {
  const n = reopenResetSequence('normal')
  const a = reopenResetSequence('alternate')
  return ![n, a].some((s) => s.includes('\x1b[3J') || s.includes('\x1b[2J'))
})())

console.log(`\n回滚保护: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
