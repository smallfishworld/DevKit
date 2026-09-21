/* 快捷命令拖放插入点判定测试：esbuild 打包 term-macro.ts，验证
   resolveDropInsertion 的插前/插后/跨组/拖动集合跳过/末条等场景，
   并用 useTermMacros 的 reorderCmds 语义（beforeName 不存在 = 插末尾）做端到端断言 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.quickcmd-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/shared/term-macro.ts')}" --bundle --platform=node --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { resolveDropInsertion } = require(OUT)

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

// 模拟列表：A、B 在组 g1；C、D、E 在组 g2
const q = (name, group = '') => ({ name, group, steps: [{ type: 'cmd', text: name, mode: 'ascii', crlf: true }] })
const list = [q('A', 'g1'), q('B', 'g1'), q('C', 'g2'), q('D', 'g2'), q('E', 'g2')]

/** 端到端：resolveDropInsertion 的结果套用 reorderCmds 的语义（splice 插到 beforeName 前，
 *  beforeName 为 null → 用不存在的哨兵名触发“插末尾”），返回新顺序 */
function applyReorder(list, anchor, names, after) {
  const { beforeName, group } = resolveDropInsertion(list, anchor, names, after)
  const sentinel = beforeName ?? '__end__'
  const set = new Set(names)
  const dragged = list.filter((c) => set.has(c.name)).map((c) => ({ ...c, group }))
  const rest = list.filter((c) => !set.has(c.name))
  const idx = rest.findIndex((c) => c.name === sentinel)
  rest.splice(idx < 0 ? rest.length : idx, 0, ...dragged)
  return rest.map((c) => c.name)
}

console.log('--- 插前（上半部）---')
check(
  '拖 X 插到 C 之前 → X 排在 C 前',
  applyReorder([...list, q('X')], 'C', ['X'], false).join(',') === 'A,B,X,C,D,E'
)
check(
  '拖 X 插到 A 之前 → X 排第一',
  applyReorder([...list, q('X')], 'A', ['X'], false).join(',') === 'X,A,B,C,D,E'
)

console.log('--- 插后（下半部）---')
check(
  '拖 X 到 A 下半部 → X 成为 A 之后第二条（用户报障场景）',
  applyReorder([...list, q('X')], 'A', ['X'], true).join(',') === 'A,X,B,C,D,E'
)
check(
  '拖 X 到 B 下半部 → X 排在 C 之前（组界处：插到锚点后下一条前，组别随锚点）',
  resolveDropInsertion([...list, q('X')], 'B', ['X'], true).beforeName === 'C'
)
check(
  '锚点已是末条 → beforeName 为 null（插到末尾）',
  resolveDropInsertion([...list, q('X')], 'E', ['X'], true).beforeName === null
)

console.log('--- 拖动集合跳过 ---')
check(
  '锚点后紧邻条也在拖动集合时跳过它（[A,X,Y,B] 拖 X,Y 到 A 后 → 插到 B 前）',
  resolveDropInsertion([q('A'), q('X'), q('Y'), q('B')], 'A', ['X', 'Y'], true).beforeName === 'B'
)
check(
  '锚点后全是拖动条目 → 插到末尾',
  resolveDropInsertion([q('A'), q('X'), q('Y')], 'A', ['X', 'Y'], true).beforeName === null
)

console.log('--- 组别跟随锚点 ---')
check(
  '拖未分组 X 到 g2 组内 D 下半部 → X 组别变为 g2',
  resolveDropInsertion([...list, q('X')], 'D', ['X'], true).group === 'g2'
)
check(
  '拖组内条目到未分组锚点上 → 组别跟随为空',
  resolveDropInsertion([...list, q('N')], 'N', ['C'], false).group === ''
)

console.log('--- 直接判定返回 ---')
const r = resolveDropInsertion(list, 'C', ['E'], false)
check('插前返回锚点名与锚点组别', r.beforeName === 'C' && r.group === 'g2')

if (fail > 0) {
  console.log(`\nquickcmd-test: ${fail} FAILED, ${pass} passed`)
  process.exit(1)
}
console.log(`\nquickcmd-test: all ${pass} passed`)
