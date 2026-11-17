const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { SerialPort } = require('serialport')
const { SerialTxBroker } = require('../src/main/services/serial/tx-broker')
const { SerialService } = require('../src/main/services/serial')
const { OaDevicePlugin } = require('../src/main/services/serial/oa-plugin')
const { DEFAULT_SERIAL_PARAMS } = require('../src/shared/serial')
const { setMainWindow } = require('../src/main/ipc')

async function brokerTransactions() {
  const pending = []
  const broker = new SerialTxBroker((bytes, done) => pending.push({ bytes: [...bytes], done }), () => true)
  const first = await broker.acquire('first', new AbortController().signal)
  const write = first.write(new Uint8Array([1, 2]))
  assert.throws(() => broker.writeNow(new Uint8Array([9])), /正在使用/)
  let secondAcquired = false
  const waiting = broker.acquire('second', new AbortController().signal).then((lease) => { secondAcquired = true; return lease })
  first.release()
  await Promise.resolve()
  assert.equal(secondAcquired, false, 'lease release must wait for pending port writes')
  pending.shift().done()
  await write
  const second = await waiting
  assert.equal(secondAcquired, true)
  await assert.rejects(first.write(new Uint8Array([3])), /事务已结束/)
  const cancelled = new AbortController()
  const rejected = assert.rejects(broker.acquire('cancelled', cancelled.signal), /cancel waiting/)
  cancelled.abort(new Error('cancel waiting'))
  await rejected
  const thirdWaiting = broker.acquire('third', new AbortController().signal)
  second.release()
  const third = await thirdWaiting
  const failedWrite = third.write(new Uint8Array([4]))
  const failed = assert.rejects(failedWrite, /driver failure/)
  pending.shift().done(new Error('driver failure'))
  await failed
  third.release()
  const last = await broker.acquire('last', new AbortController().signal)
  const closedWaiting = assert.rejects(broker.acquire('after-last', new AbortController().signal), /disconnected/)
  broker.close(new Error('disconnected'))
  await closedWaiting
  await assert.rejects(last.write(new Uint8Array([5])), /disconnected/)
  assert.equal(pending.length, 0)
  console.log('  PASS Serial broker: transaction exclusion, FIFO, cancelled waiter, write drain and stale lease')
}

async function serialBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-plugin-serial-'))
  globalThis.terminalTestDir = dir
  const service = new SerialService()
  const panel = 'serial#plugin-bridge'
  const sent = []
  setMainWindow({ isDestroyed: () => false, webContents: { setBackgroundThrottling() {}, send(_channel, event) {
    if (event.type === 'data') queueMicrotask(() => service.invoke(panel, 'output:ack', event.payload))
  } } })
  const open = async () => {
    assert.equal((await service.invoke(panel, 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM88' })).ok, true)
    const port = SerialPort.ports.at(-1)
    port.write = (bytes, done) => { sent.push([...bytes]); done?.() }
    return port
  }
  try {
    const port = await open()
    const firstConnection = service.pluginBridge.describe(panel).connectionId
    const raw = []
    service.pluginBridge.subscribe(panel, (event) => { if (event.type === 'data') event.bytes[0] = 42 })
    service.pluginBridge.subscribe(panel, (event) => raw.push(event))
    port.emit('data', Buffer.from([255, 0]))
    port.emit('data', Buffer.from([0xe4]))
    port.emit('data', Buffer.from([0xb8, 0xad]))
    assert.equal(raw.length, 3, 'raw events must not wait for the 32 ms terminal batch')
    assert.deepEqual(raw[0].bytes, [255, 0], 'binary bytes and listeners must remain independent')
    assert.equal(raw[1].text, '')
    assert.equal(raw[2].text, '中', 'text decoding must retain split UTF-8 characters')
    assert.deepEqual(raw.map((event) => event.sequence), [1, 2, 3])

    const controller = new AbortController()
    const lease = await service.pluginBridge.acquire(panel, 'plugin-one', controller.signal)
    assert.equal(service.invoke(panel, 'write', { mode: 'ascii', text: 'blocked', newline: 'cr' }).ok, false)
    assert.equal((await service.invoke(panel, 'file:recv', { protocol: 'ymodem', dir })).ok, false)
    await lease.write(new Uint8Array([0xa5, 0, 0xff]))
    assert.deepEqual(sent.at(-1), [0xa5, 0, 0xff])
    const secret = 'PLUGIN_SECRET_807'
    const privateEvents = []
    const stopPrivate = service.pluginBridge.subscribe(panel, (event) => privateEvents.push(event), 'plugin-one')
    const observerStart = raw.length
    await lease.write(Buffer.from(secret + '\r'), { secret: true })
    port.emit('data', Buffer.from(secret.slice(0, 5)))
    port.emit('data', Buffer.from(secret.slice(5) + '\r\n'))
    const bytesOf = (events) => Buffer.concat(events.filter((event) => event.type === 'data').map((event) => Buffer.from(event.bytes))).toString('utf8')
    assert.match(bytesOf(privateEvents), new RegExp(secret), 'the owning exchange must retain its own protocol bytes')
    assert.doesNotMatch(bytesOf(raw.slice(observerStart)), new RegExp(secret), 'passive observers must not receive secret echoes')
    assert.match(bytesOf(raw.slice(observerStart)), /REDACTED/)
    await delay(80)
    const history = await service.invoke(panel, 'history:query', {})
    assert.doesNotMatch(history.rows.map((row) => row.text).join('\n'), new RegExp(secret))
    lease.release()
    stopPrivate()
    // An old echo begins before a new owner subscribes, then completes during the new transaction.
    const lateStart = raw.length
    port.emit('data', Buffer.from(secret.slice(0, 7)))
    const nextOwnerEvents = []
    const stopNextOwner = service.pluginBridge.subscribe(panel, (event) => nextOwnerEvents.push(event), 'plugin-two')
    const nextOwnerLease = await service.pluginBridge.acquire(panel, 'plugin-two', new AbortController().signal)
    const nextSecret = 'SECOND_PLUGIN_SECRET_192'
    await nextOwnerLease.write(Buffer.from(nextSecret + '\r'), { secret: true })
    port.emit('data', Buffer.from(secret.slice(7) + '\r\n' + nextSecret.slice(0, 6)))
    port.emit('data', Buffer.from(nextSecret.slice(6) + '\r\n'))
    assert.doesNotMatch(bytesOf(nextOwnerEvents), /SECRET_807/, 'a later transaction must still redact the previous owner secret, including its delayed suffix')
    assert.match(bytesOf(nextOwnerEvents), /REDACTED/)
    assert.match(bytesOf(nextOwnerEvents), new RegExp(nextSecret), 'a transaction may read its own secret response')
    assert.doesNotMatch(bytesOf(raw.slice(lateStart)), /PLUGIN_SECRET_807|SECOND_PLUGIN_SECRET_192/)
    nextOwnerLease.release()
    const afterRelease = nextOwnerEvents.length
    port.emit('data', Buffer.from(nextSecret.slice(0, 4)))
    port.emit('data', Buffer.from(nextSecret.slice(4) + '\r\n'))
    assert.doesNotMatch(bytesOf(nextOwnerEvents.slice(afterRelease)), new RegExp(nextSecret), 'released owners receive the shared redacted stream')
    stopNextOwner()
    const beforeStaleWrite = sent.length
    await assert.rejects(lease.write(Buffer.from('late')), /事务已结束/)
    assert.equal(sent.length, beforeStaleWrite)
    assert.equal(service.invoke(panel, 'write', { mode: 'ascii', text: 'ordinary', newline: 'cr' }).ok, true)

    // File transfers share the same lease, including their cancel bytes.
    const transfer = service.invoke(panel, 'file:recv', { protocol: 'ymodem', dir })
    assert.equal(service.invoke(panel, 'write', { mode: 'ascii', text: 'not-during-file', newline: 'cr' }).ok, false)
    let granted = false
    const afterTransfer = service.pluginBridge.acquire(panel, 'after-transfer', new AbortController().signal).then((value) => { granted = true; return value })
    await Promise.resolve()
    assert.equal(granted, false)
    const transferEchoStart = raw.length
    // A late password echo can straddle the exclusive file-transfer boundary.
    port.emit('data', Buffer.from(secret.slice(0, 7)))
    service.invoke(panel, 'file:cancel')
    await transfer
    const transferLease = await afterTransfer
    assert.equal(granted, true)
    port.emit('data', Buffer.from(secret.slice(7) + '\r\n'))
    assert.doesNotMatch(bytesOf(raw.slice(transferEchoStart)), /SECRET_807/, 'file-transfer cleanup must preserve an already buffered secret prefix')
    assert.match(bytesOf(raw.slice(transferEchoStart)), /REDACTED/)
    transferLease.release()

    const stale = await service.pluginBridge.acquire(panel, 'stale', new AbortController().signal)
    await service.invoke(panel, 'close')
    assert.equal(raw.at(-1).type, 'closed')
    const oldCount = raw.length
    port.emit('data', Buffer.from('old-device'))
    await assert.rejects(stale.write(Buffer.from('late')), /连接已变化/)
    const nextPort = await open()
    assert.notEqual(service.pluginBridge.describe(panel).connectionId, firstConnection)
    nextPort.emit('data', Buffer.from('new-device'))
    assert.equal(raw.length, oldCount, 'subscriptions must be removed with the old connection')

    const resumedEvents = []
    service.pluginBridge.subscribe(panel, (event) => resumedEvents.push(event))
    const beforeSleep = service.pluginBridge.describe(panel).connectionId
    const sleeping = await service.pluginBridge.acquire(panel, 'sleeping', new AbortController().signal)
    const waitingSleep = assert.rejects(service.pluginBridge.acquire(panel, 'sleep-waiter', new AbortController().signal), /休眠/)
    service.onSystemSuspend()
    await waitingSleep
    assert.equal(service.pluginBridge.describe(panel), undefined)
    assert.equal(resumedEvents.at(-1).reason, 'system-suspend')
    await assert.rejects(sleeping.write(Buffer.from('late-sleep')), /连接已变化/)
    service.onSystemResume()
    assert.notEqual(service.pluginBridge.describe(panel).connectionId, beforeSleep)
    assert.equal(service.invoke(panel, 'write', { mode: 'ascii', text: 'after-resume', newline: 'cr' }).ok, true)
    console.log('  PASS Serial bridge: exact binary RX, streaming text, private secret exchange, observer/late-echo redaction, file arbitration and connection fencing')
  } finally {
    await service.dispose('*')
    setMainWindow(null)
    await rm(dir, { recursive: true, force: true })
  }
}

async function independentOaInstances() {
  const sessions = new Map(['one', 'two', 'auto'].map((panelId) => [panelId, { connectionId: panelId, suspendedAt: null }]))
  const sent = []
  const issued = []
  let adapter
  const host = {
    session: (id) => sessions.get(id),
    connected: (id, session) => sessions.get(id) === session && session.suspendedAt === null,
    transferActive: () => false,
    flush() {}, emit() {}, note() {}, beginHold() {}, releaseHold() {}, async replayHold() {},
    async acquire(panelId) {
      return {
        connectionId: panelId, release() {},
        async write(bytes, options) {
          sent.push([panelId, Buffer.from(bytes).toString('ascii')])
          const line = options?.secret ? 'OK\r\n' : 'Challenge: FRESH_CHALLENGE\r\n'
          adapter.receive(panelId, sessions.get(panelId), line, Date.now())
        }
      }
    }
  }
  const configuration = (command) => ({
    loginUrl: 'https://oa.example.invalid/login', authOrigins: [],
    authCheck: { type: 'json', url: 'https://oa.example.invalid/status', field: 'data.authenticated' },
    issue: { url: 'https://oa.example.invalid/issue', body: { challenge: '$challenge' } },
    profiles: [{ id: 'fixture', command, detect: { type: 'prefix', prefix: 'Challenge:' }, result: { type: 'line', successLine: 'OK', failureLine: 'FAIL' } }]
  })
  adapter = new OaDevicePlugin(host, async () => { throw new Error('global legacy config must not be loaded') }, (config) => ({
    config, async authenticate() {}, async issue(challenge) { issued.push([config.profiles[0].command, challenge]); return `TOKEN_${config.profiles[0].command}` }
  }))
  const context = (panelId, config, controller = new AbortController(), autoEnabled = false) => ({
    config, session: { panelId, connectionId: panelId, path: panelId, encoding: 'utf8' }, autoEnabled,
    signal: controller.signal, serial: {}, log() {}, state() {}
  })
  const input = configuration('command-one')
  const one = await adapter.definition.activate(context('one', { deviceActions: input, profileId: 'fixture' }))
  const two = await adapter.definition.activate(context('two', { deviceActions: configuration('command-two'), profileId: 'fixture' }))
  input.profiles[0].command = 'mutated-after-activation'
  await one.run('run')
  await two.run('run')
  assert.deepEqual(issued, [['command-one', 'FRESH_CHALLENGE'], ['command-two', 'FRESH_CHALLENGE']])
  assert.deepEqual(sent, [['one', 'command-one\r'], ['one', 'TOKEN_command-one\r'], ['two', 'command-two\r'], ['two', 'TOKEN_command-two\r']])
  const automatic = configuration('ignored')
  automatic.profiles = ['a', 'b'].map((id) => ({ ...automatic.profiles[0], id, trigger: 'auto', command: undefined }))
  const stop = new AbortController()
  const auto = await adapter.definition.activate(context('auto', { deviceActions: automatic, profileId: 'b' }, stop, true))
  assert.deepEqual(sessions.get('auto').watch.profiles.map((profile) => profile.id), ['b'])
  stop.abort(new Error('instance disabled'))
  assert.equal(sessions.get('auto').watch, undefined)
  await auto.dispose()
  await one.dispose()
  await two.dispose()
  console.log('  PASS OA adapter: independent instance configs, immutable run snapshots, selected profile and lifecycle cleanup')
}

async function main() {
  await brokerTransactions()
  await serialBridge()
  await independentOaInstances()
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
