/* 测试入口：被 logic-test.js 打包执行 */
const { parseHex, toHex, buildPayload, newlineBytes } = require('../src/shared/hexutil')
const { evalExpr, byteLayout, fmtBin, fmtHex, toSigned } = require('../src/renderer/src/tools/calc/engine')

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
function eqArr(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

console.log('== hexutil ==')
check('parseHex 空格分隔', eqArr([...(parseHex('AA BB') ?? [])], [0xaa, 0xbb]))
check('parseHex 连续写法', eqArr([...(parseHex('aabb') ?? [])], [0xaa, 0xbb]))
check('parseHex 0x+逗号', eqArr([...(parseHex('0xAA,0xBB') ?? [])], [0xaa, 0xbb]))
check('parseHex 奇数位 null', parseHex('AAB') === null)
check('parseHex 非法字符 null', parseHex('GG') === null)
check('parseHex 空 → 长度0', parseHex('  ') !== null && parseHex('  ').length === 0)
check('toHex 大写空格', toHex(new Uint8Array([0x01, 0xab])) === '01 AB')
check('newlineBytes crlf', eqArr([...newlineBytes('crlf')], [0x0d, 0x0a]))
check('buildPayload hex+crlf', eqArr([...(buildPayload('hex', 'AA BB', 'crlf') ?? [])], [0xaa, 0xbb, 0x0d, 0x0a]))
check('buildPayload ascii', eqArr([...(buildPayload('ascii', 'AB', 'none') ?? [])], [0x41, 0x42]))
check('buildPayload ascii中文+lf', eqArr([...(buildPayload('ascii', '中', 'lf') ?? [])], [0xe4, 0xb8, 0xad, 0x0a]))
check('buildPayload hex非法 null', buildPayload('hex', 'ZZ', 'none') === null)

console.log('== calc engine ==')
const w = 8
check('1+2*3 = 7', evalExpr('1+2*3', 32).value === 7n)
check('(1+2)*3 = 9', evalExpr('(1+2)*3', 32).value === 9n)
check('0xFF & 0x0F = 15', evalExpr('0xFF & 0x0F', 32).value === 15n)
check('~0 w8 → 0xFF', evalExpr('~0', 8).value === 255n)
check('-1 w8 → 255 truncated', (() => { const r = evalExpr('-1', 8); return r.value === 255n && r.truncated })())
check('1<<3 = 8', evalExpr('1<<3', 32).value === 8n)
check('-8>>1 w8 → 0xFC(有符号算术移位)', evalExpr('-8>>1', 8).value === 0xfcn)
check('0xFF>>>4 w8 → 0x0F', evalExpr('0xFF>>>4', 8).value === 0x0fn)
check('5/2 = 2', evalExpr('5/2', 32).value === 2n)
check('-5/2 w8 = -2 → 254', evalExpr('-5/2', 8).value === 254n)
check('5%3 = 2', evalExpr('5%3', 32).value === 2n)
check('-5%3 w8 = -2 → 254(余数随被除数)', evalExpr('-5%3', 8).value === 254n)
check('0b1010 | 0o7 = 15', evalExpr('0b1010 | 0o7', 32).value === 15n)
check('下划线 2_0+1 = 21', evalExpr('2_0+1', 32).value === 21n)
check('移位量取低16位不崩', evalExpr('1 << 70000', 32).truncated === true)
check('除0报错', evalExpr('1/0', 32).error !== null)
check('0x 残缺报错', evalExpr('0x', 32).error !== null)
check('1+ 意外结束报错', evalExpr('1+', 32).error !== null)
check('括号不闭合报错', evalExpr('(1+2', 32).error !== null)
check('64位移位 1n<<40 合法', evalExpr('1<<40', 64).value === (1n << 40n))
check('toSigned(-1回绕)', toSigned(255n, 8) === -1n)
const bl = byteLayout(0x12345678n, 32)
check('byteLayout BE', eqArr(bl.be, ['12', '34', '56', '78']))
check('byteLayout LE 反序', eqArr(bl.le, ['78', '56', '34', '12']))
check('fmtBin 分组', fmtBin(0xfn, 8) === '0000 1111')
check('fmtHex 分组带前缀', fmtHex(0x1234n, 16) === '0x12 34')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
