/**
 * 行终止符假设检验（tests/probes/）
 * 把同一份 cat 输出分别按 \r / \n / \r\n / 混合 终止，喂给 convertEol:true 的无头终端，
 * 看屏幕与回滚里到底留下什么——用来判定用户"前半段看不见、滚动也看不见、后半段可见"是哪种终止符造成的。
 * 用法：npx esbuild tests/probes/terminator-hypothesis-probe.js --bundle --platform=node --outfile=/tmp/t.cjs && node /tmp/t.cjs
 */
const { Terminal } = require('@xterm/xterm')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const w = (t, s) => new Promise((r) => t.write(s, r))

const STATUS = [
  '# cat proc/314/status', 'Name:\tdavinci', 'Umask:\t0022', 'State:\tS (sleeping)', 'Tgid:\t314',
  'Ngid:\t0', 'Pid:\t314', 'PPid:\t102', 'TracerPid:\t0', 'Uid:\t0\t0\t0\t0', 'Gid:\t0\t0\t0\t0',
  'FDSize:\t128', 'Groups:\t ', 'NStgid:\t314', 'NSpid:\t314', 'NSpgid:\t82', 'NSsid:\t82',
  'VmPeak:\t  895512 kB', 'VmSize:\t  870924 kB', 'VmLck:\t       0 kB', 'VmPin:\t       0 kB',
  'VmHWM:\t   57760 kB', 'VmRSS:\t   57668 kB', 'RssAnon:\t   29576 kB', 'RssFile:\t   23532 kB',
  'RssShmem:\t    4560 kB', 'VmData:\t  451636 kB', 'VmStk:\t     132 kB', 'VmExe:\t   16604 kB',
  'VmLib:\t   16876 kB', 'VmPTE:\t     584 kB', 'VmSwap:\t       0 kB', 'HugetlbPages:\t       0 kB',
  'CoreDumping:\t0', 'THP_enabled:\t1', 'Threads:\t51', 'SigQ:\t1/1709',
  'SigPnd:\t0000000000000000', 'ShdPnd:\t0000000000000000', 'SigBlk:\t0000000000000000',
  'SigIgn:\t0000000000301004', 'SigCgt:\t0000000180004402', 'CapInh:\t0000000000000000',
  'CapPrm:\t0000003fffffffff', 'CapEff:\t0000003fffffffff', 'CapBnd:\t0000003fffffffff',
  'CapAmb:\t0000000000000000', 'NoNewPrivs:\t0', 'Seccomp:\t0',
  'Speculation_Store_Bypass:\tthread vulnerable', 'Cpus_allowed:\t3', 'Cpus_allowed_list:\t0-1',
  'voluntary_ctxt_switches:\t1074', 'nonvoluntary_ctxt_switches:\t2085'
]

function report(label, text) {
  const t = new Terminal({ cols: 100, rows: 28, scrollback: 200000, convertEol: true })
  const done = w(t, text).then(async () => {
    await wait(40)
    const b = t.buffer.active
    const visible = []
    for (let i = b.baseY; i < b.length; i++) visible.push((b.getLine(i)?.translateToString(true) ?? '').trimEnd())
    const nonEmpty = visible.filter((x) => x.length > 0)
    const found = (needle) => {
      for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes(needle)) return i
      return -1
    }
    console.log(`--- ${label} ---`)
    console.log(`  length=${b.length} baseY=${b.baseY}  屏上非空行=${nonEmpty.length}/${t.rows}`)
    console.log(`  'cat proc/314/status'@${found('cat proc/314/status')}  'Name:'@${found('Name:')}  'nonvoluntary'@${found('nonvoluntary')}`)
    console.log(`  屏上内容: ${JSON.stringify(nonEmpty.slice(0, 6))}${nonEmpty.length > 6 ? ' …' : ''}`)
    t.dispose()
  })
  return done
}

;(async () => {
  const line = (i) => STATUS[i]
  await report('A 全部 \r\n 终止（正常设备）', STATUS.map((s) => s + '\r\n').join(''))
  await report('B 全部 \n 终止（convertEol 兜底）', STATUS.map((s) => s + '\n').join(''))
  await report('C 全部裸 \r 终止', STATUS.map((s) => s + '\r').join(''))
  await report('D 裸 \r 终止，最后一行 \r\n', STATUS.map((s, i) => s + (i === STATUS.length - 1 ? '\r\n' : '\r')).join(''))
  // E：每批（模拟 32ms 批次边界）批内用 \r、批末用 \r\n —— 日志里看到的就是这个形态
  const batches = [STATUS.slice(0, 20), STATUS.slice(20, 39), STATUS.slice(39)]
  const e = batches.map((bs) => bs.map((s, i) => s + (i === bs.length - 1 ? '\r\n' : '\r')).join('')).join('')
  await report('E 批内 \r / 批末 \r\n', e)
  void line
})()
