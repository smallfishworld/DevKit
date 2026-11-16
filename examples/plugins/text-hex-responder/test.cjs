'use strict'
const assert = require('node:assert/strict')
const { activate } = require('./index.cjs')
const defaults = Object.fromEntries(Object.entries(require('./manifest.json').configSchema.properties).map(([k,v]) => [k,v.default]))
async function fixture(extra = {}) {
  const writes = []
  const instance = await activate({
    config: { ...defaults, ...extra }, session: {},
    serial: { write: async data => writes.push(data) },
    log() {}, state() {}
  })
  return { instance, writes }
}
async function main() {
  let { instance, writes } = await fixture()
  await instance.onData({ text: 'PI', bytes: [80,73] })
  assert.equal(writes.length, 0)
  await instance.onData({ text: 'NG\r\nPING\nnoise\n', bytes: [] })
  assert.deepEqual(writes, ['PONG\r\n', 'PONG\r\n'])
  await instance.run('send')
  assert.equal(writes.length, 3)
  await instance.dispose()
  await instance.onData({ text: 'PING\n', bytes: [] })
  assert.equal(writes.length, 3)

  ;({ instance, writes } = await fixture({ mode: 'hex', match: 'AA 01', response: '55 FE' }))
  await instance.onData({ bytes: [0,170], text: '' })
  await instance.onData({ bytes: [1,170,1], text: '' })
  assert.deepEqual(writes, [[85,254], [85,254]])
  await instance.dispose()

  ;({ instance, writes } = await fixture({ replyDelayMs: 500 }))
  const pending = instance.run('send')
  await instance.dispose()
  await pending
  assert.equal(writes.length, 0)

  await assert.rejects(() => activate({
    config: {...defaults, mode:'hex', match:'Z1', response:'01'},
    serial:{}, log(){}, state(){}
  }), /十六进制/)
  console.log('PASS standalone responder: split text, multiple frames, HEX, manual action, dispose and validation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
