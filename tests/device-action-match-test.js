/* 设备动作匹配纯函数测试：esbuild 打包 device-action-match.ts，覆盖
   挑战码识别（prefix / base64-line）、结果行判定、口令重复提示与触发词。 */
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.device-action-match-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/main/services/serial/device-action-match.ts')}" --bundle --platform=node --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const {
  matchChallengeLine, matchResultLine, isPromptLine, isTriggerWord
} = require(OUT)

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}
function throws(fn, pattern) {
  try { fn() } catch (error) { return pattern.test(error.message) }
  return false
}

const base64Detect = { type: 'base64-line', shortMin: 20, shortMax: 21, longMin: 300, longMinDecoded: 260 }
const prefixDetect = { type: 'prefix', prefix: 'Challenge:' }

console.log('--- 挑战码：prefix ---')
check('前缀后取码', matchChallengeLine(prefixDetect, 'Challenge: ABC_123=') === 'ABC_123=')
check('任意位置出现不算命中', matchChallengeLine(prefixDetect, 'boot Challenge: ABC_123=') === undefined)
check('前缀后码不合法时明确抛错', throws(() => matchChallengeLine(prefixDetect, 'Challenge: bad code!'), /格式不匹配/))

console.log('--- 挑战码：base64-line ---')
const shortCode = 'QUJDREVGR0hJSktMTU5P='
const short20 = Buffer.alloc(14, 0x42).toString('base64')
check('20/21 字符带填充短码命中', short20.length === 20 &&
  matchChallengeLine(base64Detect, short20) === short20 && matchChallengeLine(base64Detect, shortCode) === shortCode)
const mediumCode = Buffer.alloc(16, 0x41).toString('base64')
check('超过短码上限且非长码不命中', mediumCode.length === 24 && matchChallengeLine(base64Detect, mediumCode) === undefined)
check('短码无填充不命中', matchChallengeLine(base64Detect, 'QUJDREVGR0hJSktMTU5P') === undefined)
check('小于短码下限不命中', matchChallengeLine(base64Detect, 'QUJDREVGR0hJ=') === undefined)
check('普通单词不命中', matchChallengeLine(base64Detect, 'debug') === undefined)
check('带空白的码行按 trim 判定', matchChallengeLine(base64Detect, `  ${shortCode}  `) === shortCode)
const longCode = Buffer.alloc(280, 0x41).toString('base64')
check('长码且解码 ≥ 260 字节命中', matchChallengeLine(base64Detect, longCode) === longCode)
const smallLong = Buffer.alloc(200, 0x41).toString('base64')
check('长码但解码不足不命中（过滤普通 base64 输出）', matchChallengeLine(base64Detect, smallLong) === undefined)

console.log('--- 结果行判定 ---')
const lineResult = { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' }
check('成功行', matchResultLine(lineResult, 'Debug unlocked') === 'unlocked')
check('失败行', matchResultLine(lineResult, 'Debug denied') === 'rejected')
check('其他行不判定', matchResultLine(lineResult, 'ok') === undefined)
check('成功行必须整行匹配（前有提示符不算）', matchResultLine(lineResult, '> Debug unlocked') === undefined)

console.log('--- 口令重复提示 ---')
check('重新索要口令', isPromptLine('Password:', 'Password:') === true)
check('提示后带输入回显也算', isPromptLine('Password: ***', 'Password:') === true)
check('首尾空白容错', isPromptLine('  Password: ', 'Password:') === true)
check('无关键不命中', isPromptLine('Login OK', 'Password:') === false)

console.log('--- 触发词 ---')
check('整行等于触发词', isTriggerWord('debug', ['debug']) === true)
check('允许 shell 提示符前缀', isTriggerWord('# debug', ['debug']) === true)
check('允许空格与重定向符号', isTriggerWord('$   debug', ['debug']) === true)
check('大小写敏感', isTriggerWord('Debug', ['debug']) === false)
check('带参数不算触发词', isTriggerWord('debug on', ['debug']) === false)
check('空触发词表不命中', isTriggerWord('debug', []) === false)

if (fail > 0) {
  console.log(`\ndevice-action-match-test: ${fail} FAILED, ${pass} passed`)
  process.exit(1)
}
console.log(`\ndevice-action-match-test: all ${pass} passed`)
