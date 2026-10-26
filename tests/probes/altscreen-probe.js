/**
 * Alt Screen（备用屏）回滚行为探针（tests/probes/，不在 npm test 内）
 * 验证：设备切入 ?1049h 全屏模式后，超出屏幕的输出是否还能回滚看到。
 * 用法：npx esbuild tests/probes/altscreen-probe.js --bundle --platform=node --outfile=/tmp/a.cjs && node /tmp/a.cjs
 */
const { Terminal } = require('@xterm/xterm')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

function snap(t, label) {
  const b = t.buffer.active
  const first = b.getLine(0)?.translateToString(true) ?? ''
  const last = b.getLine(b.length - 1)?.translateToString(true) ?? ''
  const hasLine0 = b.length > 0 && /LINE 00/.test(first)
  const hasLine10 = (() => {
    for (let i = 0; i < b.length; i++) if (/LINE 10/.test(b.getLine(i)?.translateToString(true) ?? '')) return true
    return false
  })()
  console.log(
    label.padEnd(34),
    `type=${b.type}`, `length=${String(b.length).padStart(3)}`, `baseY=${String(b.baseY).padStart(3)}`,
    `viewportY=${b.viewportY}`, `| LINE 00 可见=${hasLine0}`, `LINE 10 可见=${hasLine10}`,
    `| 首行=${JSON.stringify(first.slice(0, 24))}`
  )
}

const OUT = Array.from({ length: 60 }, (_, i) => `LINE ${String(i).padStart(2, '0')} xxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n`).join('')

;(async () => {
  // A. 主屏（正常）：同样 60 行，回滚应完整保留
  const a = new Terminal({ cols: 40, rows: 24, scrollback: 200000, convertEol: true })
  await w(a, OUT)
  await wait(20)
  snap(a, 'A 主屏 60 行')
  a.dispose()

  // B. ?1049h 全屏后 60 行
  const b = new Terminal({ cols: 40, rows: 24, scrollback: 200000, convertEol: true })
  await w(b, '\x1b[?1049h')
  await w(b, OUT)
  await wait(20)
  snap(b, 'B 全屏(?1049h) 60 行')

  // C. 全屏中回滚：把视口拉到顶还能看到 LINE 00 吗
  const buf = b.buffer.active
  b.scrollToTop()
  await wait(20)
  const topLine = buf.getLine(buf.viewportY)?.translateToString(true) ?? ''
  console.log('C 全屏中 scrollToTop 后 viewportY=' + buf.viewportY, '首行=' + JSON.stringify(topLine.slice(0, 24)))
  b.dispose()

  // D. 1049h 后退出 1049l：内容去哪了
  const d = new Terminal({ cols: 40, rows: 24, scrollback: 200000, convertEol: true })
  await w(d, 'BEFORE\r\n\x1b[?1049h' + OUT)
  await w(d, '\x1b[?1049l')
  await wait(20)
  snap(d, 'D 1049h→1049l')
  d.dispose()
})()
