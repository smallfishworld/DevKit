const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const outfile = path.join(__dirname, '.plugin-rx-redactor-test.cjs')
buildSync({
  entryPoints: [path.join(__dirname, '../src/main/services/serial/plugin-rx-redactor.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error'
})
const { PluginRxRedactor } = require(outfile)
const HIDDEN = Buffer.from('[REDACTED]', 'ascii')
let count = 0
function check(name, run) { run(); count++; console.log('  [PASS] ' + name) }
function filter(secrets, chunks) {
  const redactor = new PluginRxRedactor()
  secrets.forEach(secret => redactor.add(Buffer.from(secret)))
  return Buffer.concat([...chunks.map(chunk => redactor.push(Buffer.from(chunk))), redactor.finish()])
}

check('unrelated binary bytes are preserved exactly', () => {
  const data = Buffer.from([0, 255, 254, 128, 1, 0xc3, 0x28, 13, 10])
  assert.deepEqual(filter(['PASSWORD'], [data]), data)
  const fresh = new PluginRxRedactor()
  const source = Buffer.from([1,2,3])
  const copied = fresh.push(source)
  source[0] = 99
  assert.deepEqual(copied, Buffer.from([1,2,3]))
})
check('whole and repeated secrets are hidden without decoding the stream', () => {
  assert.deepEqual(filter(['secret'], ['a secret b secret c']), Buffer.concat([
    Buffer.from('a '), HIDDEN, Buffer.from(' b '), HIDDEN, Buffer.from(' c')
  ]))
})
check('every split of a binary secret is hidden', () => {
  const secret = Buffer.from([0, 255, 0xc3, 0xa9, 128, 4])
  const prefix = Buffer.from([7,8])
  const suffix = Buffer.from([9,10])
  for (let split = 0; split <= secret.length; split++) {
    assert.deepEqual(filter([secret], [
      Buffer.concat([prefix, secret.subarray(0,split)]),
      Buffer.concat([secret.subarray(split), suffix])
    ]), Buffer.concat([prefix, HIDDEN, suffix]))
  }
})
check('one-byte chunks and consecutive matches are safe', () => {
  assert.deepEqual(filter(['TOKEN'], [...Buffer.from('TOKENTOKEN')].map(byte => Buffer.from([byte]))),
    Buffer.concat([HIDDEN,HIDDEN]))
})
check('only matching tail prefixes are buffered', () => {
  const redactor = new PluginRxRedactor()
  redactor.add(Buffer.from('SECRET'))
  assert.equal(redactor.push(Buffer.from('abcSE')).toString(), 'abc')
  assert.equal(redactor.push(Buffer.from('Xdef')).toString(), 'SEXdef')
  assert.equal(redactor.finish().length, 0)
})
check('longest secret wins at the same start even across chunks', () => {
  const redactor = new PluginRxRedactor()
  redactor.add(Buffer.from('TOKEN'))
  redactor.add(Buffer.from('TOKEN-LONG'))
  assert.equal(redactor.push(Buffer.from('TOKEN')).length, 0)
  assert.deepEqual(redactor.push(Buffer.from('-LONG!')), Buffer.concat([HIDDEN,Buffer.from('!')]))
  assert.equal(redactor.finish().length, 0)
  assert.deepEqual(filter(['TOKEN-LONG','TOKEN'], ['TOKEN!']), Buffer.concat([HIDDEN,Buffer.from('!')]))
})
check('finish hides an unfinished prefix and is idempotent', () => {
  const redactor = new PluginRxRedactor()
  redactor.add(Buffer.from('SECRET'))
  assert.equal(redactor.push(Buffer.from('ok SEC')).toString(), 'ok ')
  assert.deepEqual(redactor.finish(), HIDDEN)
  assert.equal(redactor.finish().length, 0)
})
check('patterns persist for delayed echo after flush or transaction completion', () => {
  const redactor = new PluginRxRedactor()
  redactor.add(Buffer.from('TOKEN'))
  assert.deepEqual(redactor.push(Buffer.from('TOKEN!')), Buffer.concat([HIDDEN,Buffer.from('!')]))
  redactor.finish()
  assert.equal(redactor.push(Buffer.from('TO')).length, 0)
  assert.deepEqual(redactor.push(Buffer.from('KEN\r\n')), Buffer.concat([HIDDEN,Buffer.from('\r\n')]))
})
check('overlapping full matches keep leftmost longest replacement semantics', () => {
  assert.deepEqual(filter(['abcd','bc','cdef'], ['abcdef!']), Buffer.concat([HIDDEN,Buffer.from('ef!')]))
  assert.deepEqual(filter(['abc','bcdz','de'], ['abcd','e!']), Buffer.concat([HIDDEN,HIDDEN,Buffer.from('!')]))
})
check('registered secrets are copied and duplicate registration is idempotent', () => {
  const redactor = new PluginRxRedactor()
  const secret = Buffer.from('TOKEN')
  redactor.add(secret)
  secret[0] = 88
  for (let index = 0; index < 100; index++) redactor.add(Buffer.from('TOKEN'))
  assert.deepEqual(redactor.push(Buffer.from('TOKEN!')), Buffer.concat([HIDDEN,Buffer.from('!')]))
})
check('secret count and per-secret byte limits are enforced', () => {
  const redactor = new PluginRxRedactor()
  redactor.add(Buffer.alloc(0))
  for (let index = 0; index < 64; index++) redactor.add(Buffer.from('token-' + index))
  assert.throws(() => redactor.add(Buffer.from('one-too-many')), /64/)
  assert.throws(() => new PluginRxRedactor().add(Buffer.alloc(65537)), /64KiB/)
})
check('64KiB secret and a driver chunk larger than the work block are handled', () => {
  const secret = Buffer.alloc(65536, 0x61)
  secret[secret.length-1] = 0x62
  const prefix = Buffer.alloc(70000, 0xff)
  const suffix = Buffer.from([0,255,3])
  assert.deepEqual(filter([secret], [Buffer.concat([prefix,secret,suffix])]), Buffer.concat([prefix,HIDDEN,suffix]))
})
check('output is independent of chunk boundaries for ambiguous overlapping prefixes', () => {
  const secrets = ['abab','ababa','babb','XYZ']
  const input = Buffer.from('0ababababbXYZ1ababa!2ab')
  const expected = filter(secrets,[input])
  for (let split = 0; split <= input.length; split++) {
    assert.deepEqual(filter(secrets,[input.subarray(0,split),input.subarray(split)]), expected)
  }
  assert.deepEqual(filter(secrets,[...input].map(byte => Buffer.from([byte]))), expected)
})
console.log('plugin-rx-redactor-test: all ' + count + ' passed')
