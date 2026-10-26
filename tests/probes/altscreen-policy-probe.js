/**
 * 备用屏处理策略探针（tests/probes/）
 * 目的：决定 VtGuard 对 `?1049h/?1049l` 该「直接丢弃」还是「降级为清屏」。
 * 场景：串口控制台上跑全屏程序（vi / top），程序正常退出。
 *   A 原生：进备用屏，退出后主屏内容原样恢复（回滚不受影响）
 *   B 丢弃：程序的所有光标定位重绘落进主屏，退出后屏幕上是程序残影
 *   C 降级为清屏：进入时清掉当前屏（回滚保留），退出时再清一次
 *   D 换行腾屏：进入时发 rows 个换行把当前屏顶进回滚，退出时清屏
 * 关心的是：退出后**当前屏**上还能不能看到程序之前的历史，以及回滚里是否多出垃圾行。
 * 用法：npx esbuild tests/probes/altscreen-policy-probe.js --bundle --platform=node --outfile=/tmp/ap.cjs && node /tmp/ap.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

/** 进入全屏程序前的历史（30 行，足以滚出屏幕） */
const HISTORY = Array.from({ length: 30 }, (_, i) => `HIST ${String(i).padStart(2, '0')} ${'h'.repeat(30)}\r\n`).join('')

/** 模拟全屏程序：进入 → 3 次整屏重绘 → 退出 */
const ENTER = '\x1b[?1049h\x1b[H\x1b[2J'
const LEAVE = '\x1b[?1049l'
function frame(n) {
  const rows = Array.from({ length: 24 }, (_, i) =>
    `\x1b[${i + 1};1Happ-frame${n}-row${String(i).padStart(2, '0')} ${'a'.repeat(20)}`
  ).join('')
  return `\x1b[H${rows}`
}

const count = (t, re) => {
  const b = t.buffer.active
  let n = 0
  for (let i = 0; i < b.length; i++) if (re.test(b.getLine(i)?.translateToString(true) ?? '')) n++
  return n
}

/** 当前屏（视口内）能看到的内容 */
function screen(t) {
  const b = t.buffer.active
  const out = []
  for (let i = b.viewportY; i < b.viewportY + t.rows; i++) out.push((b.getLine(i)?.translateToString(true) ?? '').trim())
  return out
}

function whichPolicy(name, enter, leave) {
  return { name, map: (s) => s.replace(/\x1b\[\?1049h/g, enter).replace(/\x1b\[\?1049l/g, leave) }
}

const POLICIES = [
  whichPolicy('A 原生（不中和）', '\x1b[?1049h', '\x1b[?1049l'),
  whichPolicy('B 丢弃（当前实现）', '', ''),
  whichPolicy('C 降级为清屏', '\x1b[2J\x1b[H', '\x1b[2J\x1b[H'),
  whichPolicy('D 换行腾屏', '\r\n'.repeat(24) + '\x1b[H', '\x1b[2J\x1b[H')
]

;(async () => {
  for (const p of POLICIES) {
    const t = new Terminal({ cols: 100, rows: 24, scrollback: 200000, convertEol: true })
    await w(t, HISTORY)
    let stream = ENTER + frame(1) + frame(2) + frame(3) + LEAVE
    stream = p.map(stream)
    await w(t, stream)
    await wait(40)
    const b = t.buffer.active
    const scr = screen(t)
    const histOnScreen = scr.filter((l) => l.startsWith('HIST')).length
    console.log(
      p.name.padEnd(18),
      `bufType=${b.type}`,
      `len=${String(b.length).padStart(3)}`,
      `HIST行(全缓冲)=${String(count(t, /^HIST /)).padStart(2)}`,
      `HIST行(当前屏)=${String(histOnScreen).padStart(2)}`,
      `app残影(当前屏)=${String(scr.filter((l) => l.startsWith('app-frame')).length).padStart(2)}`
    )
    console.log('   当前屏首行:', JSON.stringify(scr[0].slice(0, 40)), ' 末行:', JSON.stringify(scr[23].slice(0, 40)))
    t.dispose()
  }
})()
