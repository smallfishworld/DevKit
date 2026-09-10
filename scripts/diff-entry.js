/* diff 服务纯逻辑测试入口（被 diff-test.js 打包执行） */
const { promises: fs } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { textDiff } = require('../src/main/services/diff/textdiff')
const { hexDiff } = require('../src/main/services/diff/hexdiff')
const { scanFolder, syncFolderItem } = require('../src/main/services/diff/folder')
const { readFileRes, decode } = require('../src/main/services/diff/io')

let pass = 0
let fail = 0
let roots = []
async function newRoot() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-diff-'))
  roots.push(d)
  return d
}
function check(name, cond) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  [FAIL] ${name}`)
  }
}
function stats(t) {
  return { add: t.add, del: t.del, same: t.same, identical: t.identical }
}

const NOOP = { ignoreSpace: false, ignoreCase: false }

console.log('== textDiff ==')
check('完全相同', stats(textDiff('a\nb', 'a\nb', NOOP)).identical === true)
const d1 = textDiff('a\nb\nc', 'a\nx\nc', NOOP)
check('中间一行不同 → 1删1加', d1.del === 1 && d1.add === 1 && d1.same === 2)
check('changed 行左右行号对齐', d1.rows.find((r) => r.op === 'changed').left.no === 2 && d1.rows.find((r) => r.op === 'changed').right.no === 2)
check('单处变更 blocks===1', d1.blocks === 1)
check('忽略空白: "a b"=="ab"', textDiff('a b', 'ab', { ignoreSpace: true, ignoreCase: false }).identical === true)
check('忽略大小写', textDiff('ABC', 'abc', { ignoreSpace: false, ignoreCase: true }).identical === true)
check('空串相同', textDiff('', '', NOOP).identical === true)
check('CRLF 与 LF 一致', textDiff('a\r\nb', 'a\nb', NOOP).identical === true)
check('末尾换行不额外增行', textDiff('a\n', 'a', NOOP).identical === true)

// 行内片段：'a b c' vs 'a x c' → 左侧中段 changed、前后段不变
const di = textDiff('a b c', 'a x c', NOOP)
const chRow = di.rows.find((r) => r.op === 'changed')
check('行内片段存在且拼回原文', chRow && chRow.left.segs.map((s) => s.text).join('') === 'a b c')
check('行内中段 changed', chRow && chRow.left.segs.filter((s) => s.changed).map((s) => s.text).join('') === 'b')
check('行内 ignoreCase 保原大小写', (() => {
  const t = textDiff('ABC', 'abc', { ignoreSpace: false, ignoreCase: true })
  return t.identical // 归一化后整行等价 → 无 changed 行
})())
// 不对称块：del 多于 add → 多出的行归 only-left 且同 block
const dasym = textDiff('a\nb\nc', 'a\nc', NOOP)
check('不对称块 only-left', dasym.rows.some((r) => r.op === 'only-left' && r.left.no === 2 && r.block === 0))
const rasym = textDiff('a', 'a\nx\ny', NOOP)
check('不对称块 only-right 同块', (() => {
  const ors = rasym.rows.filter((r) => r.op === 'only-right')
  return ors.length === 2 && ors.every((r) => r.block === 0)
})())
// 多区域 → blocks 计数
check('多区域 blocks===2', textDiff('a\nb\nc\nd', 'a\nx\nc\ny', NOOP).blocks === 2)
// 次要差异：仅空白不同 → minor 行（蓝标可忽略），不计 identical
{
  const t = textDiff('a  b\nx', 'a b\nx', NOOP)
  check('仅空白不同 → minor 行', t.minor === 1 && t.rows.some((r) => r.op === 'minor'))
  check('minor 仍计入变更（identical=false）', t.identical === false)
  const t2 = textDiff('ABC\nx', 'abc\nx', NOOP)
  check('仅大小写不同 → minor 行', t2.minor === 1 && t2.rows.some((r) => r.op === 'minor'))
  const t3 = textDiff('a  b\nx', 'a b\nx', { ignoreSpace: true, ignoreCase: false })
  check('开忽略空白后不标 minor', t3.minor === 0 && t3.identical === true)
}
// INLINE_LIMIT 降级：构造 4500 行配对改动，前 4000 行有行内片段，其后整行单段
{
  const big = Array.from({ length: 4500 }, (_, i) => `line ${i} old`).join('\n')
  const big2 = Array.from({ length: 4500 }, (_, i) => `line ${i} new`).join('\n')
  const t = textDiff(big, big2, NOOP)
  const changed = t.rows.filter((r) => r.op === 'changed')
  const multiSeg = changed.filter((r) => r.left.segs.length > 1).length
  check('INLINE_LIMIT 后段降级整行单段', changed.length === 4500 && multiSeg > 0 && multiSeg < 4500 && changed[4499].left.segs.length === 1)
}

console.log('== hexDiff ==')
check('相同 → identical', hexDiff({ leftHex: '01 AA 02', rightHex: '01 AA 02' }).identical === true)
const h2 = hexDiff({ leftHex: '01 AA 02', rightHex: '01 AB 02' })
check('翻1字节 → diffCount1', h2.diffCount === 1 && h2.identical === false)
check('缺侧补 --', h2.rows[0].left === '01 AA 02 ' + Array(13).fill('--').join(' '))
const h3 = hexDiff({ leftHex: '00 01 02 03', rightHex: '00 01 02' })
check('长度错位 → left + 计差', h3.rows[0].type === 'left' && h3.diffCount >= 1)
check('左空右有 → right', hexDiff({ leftHex: '', rightHex: '00 01' }).rows[0].type === 'right')
check('容忍输入含 --', hexDiff({ leftHex: 'aa -- bb', rightHex: 'aa bb' }).diffCount === 0)

console.log('== io / 编码 ==')
async function ioTest() {
  const root = await newRoot()
  const f1 = path.join(root, 'utf8bom.bin')
  await fs.writeFile(f1, Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x42]))
  const r1 = await readFileRes({ path: f1, encoding: 'auto' })
  check('BOM utf8 判文本', r1.ok && r1.kind === 'text' && r1.encoding === 'utf8')
  check('BOM 文本剥离', r1.ok && r1.text === 'AB')

  const f2 = path.join(root, 'nul.bin')
  await fs.writeFile(f2, Buffer.from([0x41, 0x00, 0x42]))
  const r2 = await readFileRes({ path: f2, encoding: 'auto' })
  check('含NUL 判二进制', r2.ok && r2.kind === 'binary')
  check('二进制给 hex', r2.ok && typeof r2.hex === 'string' && r2.hex.length > 0)

  check('GBK 解码 你', decode(Buffer.from([0xc4, 0xe3]), 'gbk') === '你')

  const f3 = path.join(root, 'utf16.bin')
  await fs.writeFile(f3, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))
  const r3 = await readFileRes({ path: f3, encoding: 'auto' })
  check('UTF-16LE BOM 识别', r3.ok && r3.kind === 'text' && r3.text === 'AB')
}

console.log('== folder ==')
async function folderTest() {
  const root = await newRoot()
  const L = path.join(root, 'L')
  const R = path.join(root, 'R')
  await fs.mkdir(path.join(L, 'sub'), { recursive: true })
  await fs.mkdir(path.join(R, 'sub'), { recursive: true })
  await fs.writeFile(path.join(L, 'a.txt'), 'hello')
  await fs.writeFile(path.join(R, 'a.txt'), 'hello')
  await fs.writeFile(path.join(L, 'b.txt'), 'same-content')
  await fs.writeFile(path.join(R, 'b.txt'), 'DIFFERENT')
  await fs.writeFile(path.join(L, 'onlyL.txt'), 'x')
  await fs.writeFile(path.join(R, 'onlyR.txt'), 'y')
  await fs.writeFile(path.join(L, 'sub', 'common.log'), 'log')
  await fs.writeFile(path.join(R, 'sub', 'common.log'), 'log')

  const filter = { extIgnore: ['log'], ignoreCase: false, ignoreWhitespace: false }
  const res = await scanFolder({ left: L, right: R, filter })
  check('扫描 ok', res.ok === true)
  const by = Object.fromEntries(res.entries.map((e) => [e.rel, e.status]))
  check('相同文件', by['a.txt'] === 'identical')
  check('不同文件', by['b.txt'] === 'differ')
  check('仅左', by['onlyL.txt'] === 'only-left')
  check('仅右', by['onlyR.txt'] === 'only-right')
  check('目录', by['sub'] === 'dir')
  check('忽略扩展名', by['sub/common.log'] === 'ignored')
  check(
    'counts 汇总',
    res.counts.identical === 1 &&
      res.counts.differ === 1 &&
      res.counts['only-left'] === 1 &&
      res.counts['only-right'] === 1 &&
      res.counts.dir === 1 &&
      res.counts.ignored === 1
  )

  const sync1 = await syncFolderItem({ dir: 'left-to-right', rel: 'onlyL.txt', op: 'copy', left: L, right: R })
  check('复制到右 ok', sync1.ok === true && (await fs.readFile(path.join(R, 'onlyL.txt'), 'utf8')) === 'x')

  const sync2 = await syncFolderItem({ dir: 'left-to-right', rel: 'onlyR.txt', op: 'delete', left: L, right: R })
  const gone = await fs.access(path.join(R, 'onlyR.txt')).then(() => false, () => true)
  check('删除右 ok', sync2.ok === true && gone)

  const sync3 = await syncFolderItem({ dir: 'left-to-right', rel: '../evil', op: 'copy', left: L, right: R })
  check('拒绝 .. 穿越', sync3.ok === false && !!sync3.error)
  const sync4 = await syncFolderItem({ dir: 'left-to-right', rel: 'C:\\abs', op: 'copy', left: L, right: R })
  check('拒绝绝对路径', sync4.ok === false)
}

async function main() {
  await ioTest()
  await folderTest()
  for (const r of roots) await fs.rm(r, { recursive: true, force: true })
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})