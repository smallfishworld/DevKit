/* 串口日志文本清洗纯函数测试：剥 ANSI / 归一换行 / 制表符保留
   与辅助串口自动日志（src/shared/logtext.ts）共用同一份生产代码路径 */
const { cleanLogBody, stripAnsi, normalizeLines, fmtStamp, fileNameStamp, estimateBytes, splitTerminalLines, dateStamp, stampLines } = require('../src/shared/logtext')

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

console.log('== stripAnsi（剥 ANSI/VT100 控制序列） ==')
check('SGR 前景色剥除', stripAnsi('\x1b[36;22mhello\x1b[0m') === 'hello')
check('SGR 多参数剥除', stripAnsi('\x1b[1;32mabc\x1b[0m') === 'abc')
check('带 ? 的 CSI 剥除', stripAnsi('\x1b[?25labc') === 'abc')
check('裸 ESC 剥除', stripAnsi('a\x1bb') === 'ab')
check('OSC 剥除', stripAnsi('\x1b]0;title\x07abc') === 'abc')
check('无 ANSI 原样保留', stripAnsi('plain text {x} [y]') === 'plain text {x} [y]')

console.log('== normalizeLines（归一换行 + 压空行） ==')
check('\\r\\n → \\n', normalizeLines('a\r\nb') === 'a\nb')
check('独立 \\r → \\n', normalizeLines('a\rb') === 'a\nb')
check('\r\r\n → 单换行', normalizeLines('a\r\r\nb') === 'a\nb')
check('有意单空行保留', normalizeLines('a\n\nb') === 'a\n\nb')
check('成串空行压缩为一个空行', normalizeLines('a\n\n\n\nb') === 'a\n\nb')
check('\r\n\r\n → 内容+单空行', normalizeLines('a\r\n\r\nb') === 'a\n\nb')
check('无换行原样保留', normalizeLines('single') === 'single')

console.log('== cleanLogBody（端到端，对应真实设备日志） ==')
const sample =
  '\x1b[36;22m<DSP_INFO>  [plt_vi.c:3102] magic:0xacca\x1b[0m\r\r\n' +
  '\x1b[36;22m<DSP_INFO>  [plt_vi.c:3105] freq min\x1b[0m\r\r\n'
const cleaned = cleanLogBody(sample)
check('剥掉全部 ANSI 码', !/\x1b/.test(cleaned))
check('无 CR 残留', !/\r/.test(cleaned))
check('内容连行保留、\\r\\r\\n 归一为单 \\n', cleaned === '<DSP_INFO>  [plt_vi.c:3102] magic:0xacca\n<DSP_INFO>  [plt_vi.c:3105] freq min\n')
check('制表符保留为真实跳格', cleanLogBody('a\tb') === 'a\tb')

console.log('== fmtStamp / fileNameStamp（时间戳格式统一） ==')
const st = fmtStamp(new Date(2026, 8, 14, 9, 5, 7, 123).getTime())
check('fmtStamp 为 HH:MM:SS.mmm', st === '09:05:07.123')
check('fmtStamp 补零', fmtStamp(new Date(2026, 8, 14, 23, 0, 0, 5).getTime()) === '23:00:00.005')
check(
  'fmtStamp 带日期为 YYYY-MM-DD HH:MM:SS.mmm',
  fmtStamp(new Date(2026, 8, 14, 9, 5, 7, 123).getTime(), true) === '2026-09-14 09:05:07.123'
)
check('dateStamp 为 YYYY-MM-DD', dateStamp(new Date(2026, 8, 14)) === '2026-09-14')
check(
  'fileNameStamp 为 YYYYMMDD-HHMMSS',
  fileNameStamp(new Date(2026, 8, 14, 9, 5, 7)) === '20260914-090507'
)
check('estimateBytes 按 UTF-16 估算', estimateBytes('abcd') === 8)

console.log('== splitTerminalLines（按完整行切分，终止符跨批不产生幻影空行） ==')
check('完整行切出、无 carry', (() => { const r = splitTerminalLines('a\r\r\nb\n'); return r.lines.join('|') === 'a|b' && r.carry === '' })())
check('\\r\\r\\n 归一为单终止符', splitTerminalLines('a\r\r\nb\r\r\n').lines.join('|') === 'a|b')
check('设备真实空行保留', splitTerminalLines('a\r\r\n\r\r\nb\n').lines.join('|') === 'a||b')
check('结尾未完行进 carry', splitTerminalLines('a\r\r\nbc').lines.join('|') === 'a' && splitTerminalLines('a\r\r\nbc').carry === 'bc')
check('终止符切成两半：前批 CR 进 carry', splitTerminalLines('line3\r\r').lines.length === 0 && splitTerminalLines('line3\r\r').carry === 'line3\r\r')
check('终止符后半拼回后无幻影空行', splitTerminalLines('line3\r\r\n').lines.join('|') === 'line3')
check('孤立 \\n 批 = 一条空行', splitTerminalLines('\n').lines.join('|') === '' && splitTerminalLines('\n').carry === '')
check('空行终止符跨批（\\r\\r 与 \\n 分离）仍保留空行', splitTerminalLines('\r\r').lines.length === 0 && splitTerminalLines('\r\r\n').lines.join('|') === '')
check('无换行整批进 carry', splitTerminalLines('root# ').lines.length === 0 && splitTerminalLines('root# ').carry === 'root# ')
check('跨批 ANSI 序列滞留 carry', splitTerminalLines('abc\x1b[3').carry === 'abc\x1b[3')
check('两批拼接后清洗成功', (() => { const j = splitTerminalLines('\x1b[3').carry + '6;22mhello\x1b[0m\r\r\n'; return cleanLogBody(splitTerminalLines(j).lines[0]) === 'hello' })())

console.log('== stampLines（终端逐行补戳） ==')
const S = '[T] '
check('批内多行逐行补戳', stampLines('a\nb\n', S, false).out === '[T] a\n[T] b\n')
check('同批行共用一个时刻（prefix 一致即可）', stampLines('a\nb\n', S, false).out.split(S).length === 3)
check('结尾未完行也补戳、状态转行中', stampLines('a\nb', S, false).out === '[T] a\n[T] b' && stampLines('a\nb', S, false).midLine === true)
check('行中延续不加戳', stampLines('c\nd', S, true).out === 'c\n[T] d')
check('单换行批终结未完行不加戳', stampLines('\n', S, true).out === '\n' && stampLines('\n', S, true).midLine === false)
check('空行同样补戳（与落盘一致）', stampLines('a\n\nb\n', S, false).out === '[T] a\n[T] \n[T] b\n')
check('孤立换行批 = 补戳空行', stampLines('\n', S, false).out === '[T] \n')
check('\\r 保留在行内容中', stampLines('a\r\r\nb\n', S, false).out === '[T] a\r\r\n[T] b\n')
check('提示符回显（无换行）状态为行中', stampLines('root# ', S, false).midLine === true)
check('空批不补戳、状态不变', stampLines('', S, false).out === '' && stampLines('', S, true).midLine === true)

console.log('== 跨批端到端（模拟 16ms 批量窗口在任意字节处切分） ==')
// 落盘管道：逐批走 splitTerminalLines → cleanLogBody（与主进程/面板 pushRaw 同一套）
function logPipeline(batches) {
  let carry = ''
  const lines = []
  for (const b of batches) {
    const r = splitTerminalLines(carry + b)
    carry = r.carry
    for (const part of r.lines) lines.push(...cleanLogBody(part).split('\n'))
  }
  if (carry.replace(/\r/g, '')) lines.push(...cleanLogBody(carry).split('\n'))
  return lines
}
// 终端管道：逐批 stampLines 并跨批接力 midLine（与 TerminalView.write 同一套）
function termPipeline(batches, prefix) {
  let midLine = false
  let out = ''
  for (const b of batches) {
    const r = stampLines(b, prefix, midLine)
    out += r.out
    midLine = r.midLine
  }
  return out
}
const DSP = '\x1b[36;22m<DSP_INFO>  [plt.c:3102] magic:0xacca\x1b[0m\r\r\n' +
  '\x1b[36;22m<DSP_ERR>  [plt.c:3105] freq min\x1b[0m\r\r\n' +
  '\x1b[36;22m<DSP_INFO>  [plt.c:3108] gain ok\x1b[0m\r\r\n'
const DSP_LINES = ['<DSP_INFO>  [plt.c:3102] magic:0xacca', '<DSP_ERR>  [plt.c:3105] freq min', '<DSP_INFO>  [plt.c:3108] gain ok']
// 终止符 \r\r\n 切成两半（前批结尾 ...\r\r、后批开头 \n）——线上报的幻影空行场景
check('终止符跨批（\\r\\r 与 \\n 分离）：落盘无幻影空行', (() => {
  const lines = logPipeline([DSP.slice(0, DSP.length - 1), DSP.slice(DSP.length - 1)])
  return lines.join('|') === DSP_LINES.join('|')
})())
// DSP 真实流在任意字节处切开，落盘行都必须与原行一致（不增行、不丢行、不拼行）
check('DSP 流任意切点：落盘行恒等于原行', (() => {
  for (let i = 0; i <= DSP.length; i++) {
    if (logPipeline([DSP.slice(0, i), DSP.slice(i)]).join('|') !== DSP_LINES.join('|')) return false
  }
  return true
})())
check('DSP 流任意切点：终端每行恰一戳（无幻影戳）', (() => {
  for (let i = 0; i <= DSP.length; i++) {
    const out = termPipeline([DSP.slice(0, i), DSP.slice(i)], S)
    if (out.split(S).length - 1 !== DSP_LINES.length) return false
  }
  return true
})())
// 有意空行的流（a / 空行 / b）：空行在任意切点都保留，且不多不少
const BLANK = 'a\r\r\n\r\r\nb\r\r\n'
check('空行流任意切点：空行保留且无幻影空行', (() => {
  for (let i = 0; i <= BLANK.length; i++) {
    if (logPipeline([BLANK.slice(0, i), BLANK.slice(i)]).join('|') !== 'a||b') return false
  }
  return true
})())
check('空行流任意切点：终端含空行戳共 3 行戳', (() => {
  for (let i = 0; i <= BLANK.length; i++) {
    if (termPipeline([BLANK.slice(0, i), BLANK.slice(i)], S).split(S).length - 1 !== 3) return false
  }
  return true
})())
check('ANSI 序列跨批：清洗后无残留', logPipeline(['\x1b[36;22mhe', 'llo\x1b[0m\r\r\n']).join('|') === 'hello')

console.log(`\n日志文本清洗: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)