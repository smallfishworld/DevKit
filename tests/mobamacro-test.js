/* MobaXterm 宏导入解析测试：esbuild 打包 term-macro.ts，用工程根的真实
   .mxtmacros 文件验证解析（GBK 解码、步骤合并、占位符还原、空条目跳过） */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const iconv = require('iconv-lite')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.mobamacro-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/shared/term-macro.ts')}" --bundle --platform=node --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { parseMobaMacros, stepPreview } = require(OUT)

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

// ---------- 1. 手写小样本：验证格式解码 ----------
const sample = [
  '[Macros]',
  'reboot=12:2:0:reboot|258:13:1835009:RETURN|',
  'withsleep=0:0:0:SLEEPEQUAL100|12:2:0:hello world|258:13:1835009:RETURN|',
  'escaped=12:2:0:mount 10.1.74.230__DBLDOT__/data1|258:13:1835009:RETURN|',
  'pipe=12:2:0:ps __PIIPE__ grep davinci|258:13:1835009:RETURN|',
  'multi=12:2:0:cd /dav|258:13:1835009:RETURN|0:0:0:SLEEPEQUAL500|12:2:0:rm -r fpga*|258:13:1835009:RETURN|',
  'nolf=12:2:0:no newline here|',
  'dup (1)=',
  '[MacrosHotkeys]',
  'should-not-appear=12:2:0:x|258:13:1835009:RETURN|'
].join('\r\n')

const cmds = parseMobaMacros(sample)
check('总条数（跳过空值/其他节）', cmds.length === 6)
const reboot = cmds.find(c => c.name === 'reboot')
check('reboot: 单步带换行', reboot && reboot.steps.length === 1 && reboot.steps[0].type === 'cmd'
  && reboot.steps[0].text === 'reboot' && reboot.steps[0].crlf === true)
const withsleep = cmds.find(c => c.name === 'withsleep')
check('withsleep: 延时在前', withsleep && withsleep.steps[0].type === 'sleep' && withsleep.steps[0].ms === 100
  && withsleep.steps[1].text === 'hello world' && withsleep.steps[1].crlf === true)
const escaped = cmds.find(c => c.name === 'escaped')
check('__DBLDOT__ → :', escaped && escaped.steps[0].text === 'mount 10.1.74.230:/data1')
const pipe = cmds.find(c => c.name === 'pipe')
check('__PIIPE__ → |', pipe && pipe.steps[0].text === 'ps | grep davinci')
const multi = cmds.find(c => c.name === 'multi')
check('multi: 4 步（cmd+sleep+cmd）', multi && multi.steps.length === 3
  && multi.steps[0].crlf === true && multi.steps[1].ms === 500 && multi.steps[2].crlf === true)
const nolf = cmds.find(c => c.name === 'nolf')
check('无 RETURN 文本: 不加换行', nolf && nolf.steps[0].crlf === false)
check('分组名已设', cmds.every(c => c.group === 'MobaXterm 导入'))
check('空值条目 (1) 已跳过', !cmds.some(c => c.name === 'dup (1)'))
check('[MacrosHotkeys] 节未混入', !cmds.some(c => c.name === 'should-not-appear'))

// ---------- 2. 真实文件：用户的 .mxtmacros（GBK） ----------
const file = path.join(ROOT, 'MobaXterm Macros.mxtmacros')
if (fs.existsSync(file)) {
  const raw = iconv.decode(fs.readFileSync(file), 'gbk')
  const real = parseMobaMacros(raw)
  console.log(`\n真实文件解析: ${real.length} 条宏`)
  check('真实文件解析出宏（>10 条）', real.length > 10)
  check('真实文件全部有步骤', real.every(c => c.steps.length > 0))
  // 抽查已知宏: setenv ip1 首步是 RETURN 按键（文件原始顺序），其后是延时 100ms
  const ip1 = real.find(c => c.name === 'setenv ip1')
  check('setenv ip1 首步为 Enter 按键', ip1 && ip1.steps[0].type === 'key' && ip1.steps[0].key === '\r')
  check('setenv ip1 第二步为延时 100ms', ip1 && ip1.steps[1].type === 'sleep' && ip1.steps[1].ms === 100)
  const hasSetenv = ip1 && ip1.steps.some(s => s.type === 'cmd' && s.text === 'setenv ipaddr 10.22.140.145')
  check('setenv ip1 含 setenv ipaddr 10.22.140.145 命令', !!hasSetenv)
  // 中文名宏应正确解码（GBK → UTF-8）
  const cnCount = real.filter(c => /[一-鿿]/.test(c.name)).length
  console.log(`  含中文名的宏: ${cnCount} 条，如: ${real.filter(c => /[一-鿿]/.test(c.name)).slice(0, 3).map(c => c.name).join(' / ')}`)
  check('中文名宏解码正确', cnCount > 0)
  // 预览示例
  const ex = real.find(c => c.steps.length > 3)
  if (ex) console.log(`  示例「${ex.name}」: ${ex.steps.map(stepPreview).join(' → ')}`)
} else {
  console.log('（未找到真实 .mxtmacros 文件，跳过）')
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
fs.unlinkSync(OUT)
process.exit(fail > 0 ? 1 : 0)