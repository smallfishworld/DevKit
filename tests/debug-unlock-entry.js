const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { EventEmitter } = require('node:events')
const electron = require('electron')
const { SerialPort } = require('serialport')
const { parseDebugUnlockConfig } = require('../src/main/services/serial/debug-unlock-config')
const { DEFAULT_SERIAL_PARAMS } = require('../src/shared/serial')
const { migrateQuickCmd, validatePlayback } = require('../src/shared/term-macro')

const base = 'https://debug.example.invalid'
const input = {
  loginUrl: `${base}/login`, statusUrl: `${base}/status`, issueUrl: `${base}/issue`,
  authOrigins: ['https://oa.example.invalid'],
  profiles: [{ id: 'fixture', challengePrefix: 'Challenge:', successLine: 'Debug unlocked',
    failureLine: 'Debug denied', challengeTimeoutMs: 1000, challengeTtlMs: 2000, resultTimeoutMs: 450 }]
}
const code = 'FIXTURE_PASSWORD_756'
const config = parseDebugUnlockConfig(input)
const panel = 'serial#debug-test'
let authenticated = false
let loginOpened = 0
const browserSessions = new Map()
electron.session = {
  fromPartition(partition) {
    assert.match(partition, /^persist:devkit-debug-unlock-/)
    if (!browserSessions.has(partition)) browserSessions.set(partition, {
      setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
      async fetch(url, init) {
        assert.equal(init.credentials, 'include')
        assert.equal(init.redirect, 'manual')
        if (url === config.statusUrl) return Response.json({ authenticated }, { status: authenticated ? 200 : 401 })
        assert.equal(url, config.issueUrl)
        assert.equal(init.method, 'POST')
        assert.deepEqual(JSON.parse(init.body), { challenge: 'FRESH_CHALLENGE_1' })
        return authenticated ? Response.json({ response: code }) : Response.json({}, { status: 403 })
      }
    })
    return browserSessions.get(partition)
  }
}
electron.BrowserWindow = class extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {} })
  destroyed = false
  constructor(options) {
    super()
    assert.equal(options.webPreferences.sandbox, true)
    assert.equal(options.webPreferences.preload, undefined)
    assert.equal(options.webPreferences.session, browserSessions.values().next().value)
    loginOpened++
  }
  async loadURL(url) {
    assert.equal(url, config.loginUrl)
    authenticated = true
  }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('closed') }
}

const { SerialService } = require('../src/main/services/serial')
const { setMainWindow } = require('../src/main/ipc')
const { createDebugUnlockProvider } = require('../src/main/services/serial/debug-unlock-provider')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(test) {
  for (let i = 0; i < 150; i++) {
    if (test()) return
    await delay(10)
  }
  throw new Error('串口模拟状态未出现')
}

async function main() {
  assert.throws(() => parseDebugUnlockConfig({ ...input, issueUrl: 'https://other.example.invalid/issue' }), /同源/)
  assert.throws(() => parseDebugUnlockConfig({ ...input, loginUrl: 'http://127.0.0.1' }), /HTTPS/)
  const macro = migrateQuickCmd({ name: 'Example', steps: [
    { type: 'cmd', text: 'version' }, { type: 'debug-unlock', profile: 'fixture', url: base, token: code }
  ] })
  assert.deepEqual(macro.steps[1], { type: 'debug-unlock', profile: 'fixture' })
  assert.match(validatePlayback(macro), /仅支持串口/)
  assert.match(validatePlayback(macro, []), /找不到/)
  assert.equal(validatePlayback(macro, ['fixture']), undefined)

  const firstProvider = createDebugUnlockProvider(config)
  await firstProvider.authenticate(new AbortController().signal, () => { assert.equal(authenticated, false) })
  assert.equal(loginOpened, 1)
  const nextProvider = createDebugUnlockProvider(config)
  await nextProvider.authenticate(new AbortController().signal, () => assert.fail('有效会话应复用'))
  assert.equal(await nextProvider.issue('FRESH_CHALLENGE_1', new AbortController().signal), code)
  authenticated = false
  await assert.rejects(nextProvider.issue('FRESH_CHALLENGE_1', new AbortController().signal), /403/)
  console.log('  PASS Debug unlock configured OA session, Cookie request path, session reuse and refusal')

  const dir = await mkdtemp(join(tmpdir(), 'devkit-debug-test-'))
  globalThis.terminalTestDir = dir
  let verify = 'success'
  let challenge = true
  let loginGate
  let issueGate
  let requests = 0
  let rejectIssue = false
  const sent = []
  const events = []
  const service = new SerialService(async () => ({
    config,
    async authenticate(_signal, onLogin) {
      if (loginGate) { onLogin(); await loginGate.promise }
    },
    async issue(value) {
      assert.equal(value, 'FRESH_CHALLENGE_1')
      requests++
      if (issueGate) await issueGate.promise
      if (rejectIssue) throw new Error('取码接口拒绝请求（HTTP 403）')
      return code
    }
  }))
  setMainWindow({ isDestroyed: () => false, webContents: { setBackgroundThrottling() {}, send(_channel, event) {
    events.push(event)
    if (event.type === 'data') queueMicrotask(() => service.invoke(panel, 'output:ack', event.payload))
  } } })
  async function open() {
    assert.equal((await service.invoke(panel, 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM99' })).ok, true)
    const port = SerialPort.ports.at(-1)
    port.write = (data, callback) => {
      const text = data.toString('ascii')
      sent.push(text)
      callback?.()
      if (text === 'debug\r' && challenge) {
        port.emit('data', Buffer.from('boot noise\r\n\x1b[32mChall'))
        setTimeout(() => port.emit('data', Buffer.from('enge: FRESH_CHALLENGE_1\x1b[0m\r\n')), 55)
      }
      if (text === `${code}\r`) {
        port.emit('data', Buffer.from(`echo ${code.slice(0, 9)}`))
        setTimeout(() => port.emit('data', Buffer.from(`${code.slice(9)}\r\n${verify === 'success' ? 'Debug unlocked\r\n' : verify === 'reject' ? 'Debug denied\r\n' : ''}`)), 55)
      }
    }
    return port
  }
  const run = () => service.invoke(panel, 'debug:run', { profile: 'fixture' })
  try {
    const port = await open()
    port.emit('data', Buffer.from('Challenge: OLD_CHALLENGE\r\nDebug unlocked\r\n'))
    loginGate = deferred()
    const first = run()
    await waitFor(() => events.some((e) => e.payload?.stage === 'login'))
    assert.deepEqual(sent, [])
    loginGate.resolve()
    assert.deepEqual(await first, { ok: true })
    loginGate = undefined
    assert.deepEqual(sent, ['debug\r', `${code}\r`])

    verify = 'reject'
    assert.match((await run()).error, /明确拒绝/)
    verify = 'silent'
    assert.match((await run()).error, /未收到设备的明确结果/)

    rejectIssue = true
    const beforeReject = sent.length
    assert.match((await run()).error, /403/)
    assert.deepEqual(sent.slice(beforeReject), ['debug\r'])
    rejectIssue = false

    issueGate = deferred()
    const beforeCancel = requests
    const cancelled = run()
    await waitFor(() => requests > beforeCancel)
    assert.match(service.invoke(panel, 'write', { mode: 'ascii', text: 'manual', newline: 'cr' }).error, /正在使用/)
    assert.match((await service.invoke(panel, 'file:recv', { protocol: 'ymodem', dir })).error, /正在使用/)
    service.invoke(panel, 'debug:cancel')
    issueGate.resolve()
    assert.match((await cancelled).error, /取消/)
    assert.equal(sent.at(-1), 'debug\r')

    issueGate = deferred()
    const beforeClose = requests
    const disconnected = run()
    await waitFor(() => requests > beforeClose)
    await service.invoke(panel, 'close')
    const page = await service.invoke(panel, 'history:query', {})
    const history = page.rows.map(({ text }) => text).join('\n')
    assert.match(history, /口令已隐藏/)
    assert.doesNotMatch(history + JSON.stringify(events), new RegExp(code))
    await open()
    issueGate.resolve()
    assert.match((await disconnected).error, /串口已断开/)
    assert.equal(sent.at(-1), 'debug\r')
    assert.equal(sent.filter((text) => text === `${code}\r`).length, 3)

    issueGate = undefined
    challenge = false
    const beforeTimeout = requests
    assert.match((await run()).error, /挑战码超时/)
    assert.equal(requests, beforeTimeout)
    assert.equal(service.invoke(panel, 'write', { mode: 'ascii', text: 'version', newline: 'cr' }).ok, true)
    console.log('  PASS Debug unlock profile/macro validation, fresh RX, split echo, rejection, cancel, reconnect and timeouts')
  } finally {
    await service.dispose('*')
    setMainWindow(null)
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
