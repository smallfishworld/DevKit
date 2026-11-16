const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { EventEmitter } = require('node:events')
const electron = require('electron')
const { SerialPort } = require('serialport')
const { parseDeviceActionsConfig } = require('../src/main/services/serial/device-actions-config')
const { DEFAULT_SERIAL_PARAMS } = require('../src/shared/serial')
const { migrateQuickCmd, validatePlayback } = require('../src/shared/term-macro')

const base = 'https://debug.example.invalid'
const input = {
  loginUrl: `${base}/login`,
  authOrigins: ['https://oa.example.invalid'],
  authCheck: { type: 'json', url: `${base}/status`, field: 'authenticated' },
  issue: { url: `${base}/issue`, body: { challenge: '$challenge' }, responsePath: 'response' },
  profiles: [{
    id: 'fixture', detect: { type: 'prefix', prefix: 'Challenge:' },
    result: { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' },
    command: 'debug', challengeTimeoutMs: 1000, challengeTtlMs: 2000, resultTimeoutMs: 450
  }]
}
const code = 'FIXTURE_PASSWORD_756'
const config = parseDeviceActionsConfig(input)
const panel = 'serial#action-test'
let authenticated = false
let loginOpened = 0
/** 模拟 Electron session.fetch 遇到 redirect:'manual' 跳转时的固定报错 */
let cancelRedirectOnce = false
const browserSessions = new Map()
electron.session = {
  fromPartition(partition) {
    assert.match(partition, /^persist:devkit-device-actions-/)
    if (!browserSessions.has(partition)) browserSessions.set(partition, {
      setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
      async fetch(url, init) {
        assert.equal(init.credentials, 'include')
        assert.equal(init.redirect, 'manual')
        assert.equal(url, config.authCheck.url)
        if (cancelRedirectOnce) {
          cancelRedirectOnce = false
          throw new Error('Redirect was cancelled')
        }
        return Response.json({ authenticated }, { status: authenticated ? 200 : 401 })
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
const { createDeviceActionProvider, LoginExpiredError } = require('../src/main/services/serial/device-actions-provider')

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

function issueTransport(expectedChallenge, expectedBody, response) {
  return async ({ url, headers, body }) => {
    assert.equal(url, config.issue.url)
    assert.equal(headers.Origin, base)
    assert.equal(headers.Referer, config.loginUrl)
    assert.equal(headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(body), expectedBody ?? { challenge: expectedChallenge })
    if (!authenticated) return { status: 403, text: '{}' }
    return { status: 200, text: JSON.stringify(response ?? { response: code }) }
  }
}

async function main() {
  assert.throws(() => parseDeviceActionsConfig({ ...input, issue: { ...input.issue, url: 'https://other.example.invalid/issue' } }), /同源/)
  assert.throws(() => parseDeviceActionsConfig({ ...input, loginUrl: 'http://127.0.0.1' }), /HTTPS/)
  assert.deepEqual(
    parseDeviceActionsConfig({ ...input, authOrigins: ['http://sso.example.invalid'] }).authOrigins,
    ['http://sso.example.invalid']
  )
  assert.throws(
    () => parseDeviceActionsConfig({ ...input, authOrigins: ['http://sso.example.invalid/path'] }),
    /只能包含/
  )
  assert.throws(() => parseDeviceActionsConfig({ ...input, issue: { ...input.issue, body: { challenge: 'x' } } }), /\$challenge/)
  assert.throws(() => parseDeviceActionsConfig({ ...input, profiles: [{ ...input.profiles[0], command: undefined }] }), /command/)
  const macro = migrateQuickCmd({ name: 'Example', steps: [
    { type: 'cmd', text: 'version' }, { type: 'device-action', profile: 'fixture', url: base, token: code }
  ] })
  assert.deepEqual(macro.steps[1], { type: 'device-action', profile: 'fixture' })
  assert.match(validatePlayback(macro), /仅支持串口/)
  assert.match(validatePlayback(macro, []), /找不到/)
  assert.equal(validatePlayback(macro, ['fixture']), undefined)

  const firstProvider = createDeviceActionProvider(config, {
    issue: issueTransport('FRESH_CHALLENGE_1'), cookies: async () => 'debug_fixture=1'
  })
  await firstProvider.authenticate(new AbortController().signal, () => { assert.equal(authenticated, false) })
  assert.equal(loginOpened, 1)
  const nextProvider = createDeviceActionProvider(config, {
    issue: issueTransport('FRESH_CHALLENGE_1'), cookies: async () => 'debug_fixture=1'
  })
  await nextProvider.authenticate(new AbortController().signal, () => assert.fail('有效会话应复用'))
  assert.equal(await nextProvider.issue('FRESH_CHALLENGE_1', new AbortController().signal), code)
  authenticated = false
  await assert.rejects(nextProvider.issue('FRESH_CHALLENGE_1', new AbortController().signal), /登录已失效/)

  // 未登录的业务页 302 到 SSO：Electron 会抛 Redirect was cancelled，应打开登录窗口
  cancelRedirectOnce = true
  const redirectProvider = createDeviceActionProvider(config, {
    issue: issueTransport('FRESH_CHALLENGE_1'), cookies: async () => 'debug_fixture=1'
  })
  await redirectProvider.authenticate(new AbortController().signal, () => { assert.equal(authenticated, false) })
  assert.equal(loginOpened, 2)

  const nested = parseDeviceActionsConfig({
    ...input,
    issue: { ...input.issue, url: `${base}/issue`, responsePath: 'data.data', loginExpiredCodes: ['003'] }
  })
  const nestedProvider = createDeviceActionProvider(nested, {
    issue: async () => ({ status: 200, text: JSON.stringify({ code: '000000', data: { data: code } }) }),
    cookies: async () => ''
  })
  assert.equal(await nestedProvider.issue('C', new AbortController().signal), code)
  const flatProvider = createDeviceActionProvider(nested, {
    issue: async () => ({ status: 200, text: JSON.stringify({ code: '000000', data: code }) }),
    cookies: async () => ''
  })
  assert.equal(await flatProvider.issue('C', new AbortController().signal), code)
  const shapeProvider = createDeviceActionProvider(nested, {
    issue: async () => ({ status: 200, text: JSON.stringify({ code: '999', data: { message: 'no token' } }) }),
    cookies: async () => ''
  })
  await assert.rejects(shapeProvider.issue('C', new AbortController().signal), (error) => {
    assert.match(error.message, /code=999/)
    assert.match(error.message, /data=object\{message\}/)
    return !error.message.includes('no token')
  })
  const expiredProvider = createDeviceActionProvider(nested, {
    issue: async () => ({ status: 200, text: JSON.stringify({ code: '003' }) }),
    cookies: async () => ''
  })
  await assert.rejects(expiredProvider.issue('C', new AbortController().signal), (error) =>
    error instanceof LoginExpiredError)
  const templated = parseDeviceActionsConfig({
    ...input, issue: { ...input.issue, body: { customMsg: '$challenge', source: '$challenge' } }
  })
  authenticated = true
  const templatedProvider = createDeviceActionProvider(templated, {
    issue: issueTransport('CODE_9', { customMsg: 'CODE_9', source: 'CODE_9' }), cookies: async () => ''
  })
  assert.equal(await templatedProvider.issue('CODE_9', new AbortController().signal), code)
  console.log('  PASS Device action config, OA session, Cookie request path, response path and login expiry')

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
  const manualProvider = {
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
  }
  const service = new SerialService(async () => manualProvider)
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
  const run = () => service.invoke(panel, 'action:run', { profile: 'fixture' })
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
    service.invoke(panel, 'action:cancel')
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
    console.log('  PASS Device action profile/macro validation, fresh RX, split echo, rejection, cancel, reconnect and timeouts')
  } finally {
    await service.dispose('*')
  }

  await runAutoScenario(events, dir)

  setMainWindow(null)
  await rm(dir, { recursive: true, force: true })
}

async function runAutoScenario(events, dir) {
  const autoChallenge = 'QUJDREVGR0hJSktMTU5P='
  const autoPassword = 'AUTO_FIXTURE_PASSWORD_737'
  const autoInput = {
    ...input,
    profiles: [{
      id: 'auto-fixture', label: '自动应答', trigger: 'auto', triggerWords: ['debug'],
      detect: { type: 'base64-line' },
      result: { type: 'prompt-repeat', promptText: 'Password:', decisionDelayMs: 20, silenceMs: 200 },
      holdInput: { maxBytes: 4096, maxMs: 5000 }
    }]
  }
  const autoConfig = parseDeviceActionsConfig(autoInput)
  const autoPanel = 'serial#auto-test'
  const sent = []
  let verdict = 'accept'
  let issueGate
  let armed = false
  const provider = {
    config: autoConfig,
    async authenticate() {},
    async issue(value) {
      assert.equal(value, autoChallenge)
      if (issueGate) await issueGate.promise
      return autoPassword
    }
  }
  const service = new SerialService(async () => provider)
  // 复用同一主窗口事件通道（上一个 service 已 dispose）
  setMainWindow({ isDestroyed: () => false, webContents: { setBackgroundThrottling() {}, send(_channel, event) {
    events.push(event)
    if (event.type === 'data') queueMicrotask(() => service.invoke(autoPanel, 'output:ack', event.payload))
  } } })
  try {
    assert.equal((await service.invoke(autoPanel, 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM98' })).ok, true)
    const port = SerialPort.ports.at(-1)
    port.write = (data, callback) => {
      const text = data.toString('ascii')
      sent.push(text)
      callback?.()
      if (text === 'debug\r') {
        port.emit('data', Buffer.from('debug\r\n'))
        setTimeout(() => port.emit('data', Buffer.from(`${autoChallenge}\r\n`)), 15)
      } else if (text === `${autoPassword}\r`) {
        setTimeout(() => port.emit('data', Buffer.from(verdict === 'reject' ? 'Password:\r\n' : 'OK\r\n')), 10)
      }
    }

    const armedResult = await service.invoke(autoPanel, 'action:watch', { enabled: true })
    assert.equal(armedResult.ok, true)
    armed = true
    const profileList = await service.invoke(autoPanel, 'action:profiles', {})
    assert.equal(profileList.armed, true)
    assert.equal(profileList.profiles[0].trigger, 'auto')

    // 用户手敲 debug；回显触发扣键，裸特征码到达后自动取口令并注入
    issueGate = deferred()
    assert.equal(service.invoke(autoPanel, 'write', { mode: 'ascii', text: 'debug', newline: 'cr' }).ok, true)
    await waitFor(() => events.some((e) => e.payload?.source === 'auto' && e.payload.stage === 'issue'))
    // 取码期间用户按键被扣住，不落设备
    const held = service.invoke(autoPanel, 'write', { mode: 'ascii', text: 'ls', newline: 'cr' })
    assert.deepEqual(held, { ok: true, bytes: 3, held: true })
    assert.equal(sent.includes('ls\r'), false)
    issueGate.resolve()
    issueGate = undefined
    await waitFor(() => sent.includes(`${autoPassword}\r`))
    await waitFor(() => sent.includes('ls\r'))
    await waitFor(() => events.some((e) => e.payload?.source === 'auto' && e.payload.running === false && e.payload.ok === true))

    // 设备重新索要口令 → 判定拒绝，扣住的按键丢弃
    verdict = 'reject'
    issueGate = deferred()
    const beforeReject = sent.length
    port.emit('data', Buffer.from(`${autoChallenge}\r\n`))
    await waitFor(() => events.filter((e) => e.payload?.source === 'auto' && e.payload.stage === 'issue').length >= 2)
    service.invoke(autoPanel, 'write', { mode: 'ascii', text: 'rm -rf /', newline: 'cr' })
    issueGate.resolve()
    issueGate = undefined
    await waitFor(() => events.some((e) => e.payload?.source === 'auto' && e.payload.running === false && /拒绝/.test(e.payload.error ?? '')))
    await delay(30)
    assert.equal(sent.slice(beforeReject).includes('rm -rf /\r'), false)

    // 关闭自动应答后不再响应特征码
    assert.equal((await service.invoke(autoPanel, 'action:watch', { enabled: false })).ok, true)
    armed = false
    const beforeDisarm = sent.length
    port.emit('data', Buffer.from(`${autoChallenge}\r\n`))
    await delay(80)
    assert.equal(sent.length, beforeDisarm)

    assert.match((await service.invoke(autoPanel, 'action:run', { profile: 'auto-fixture' })).error, /自动应答/)
    assert.equal(armed, false)
    const log = await service.invoke(autoPanel, 'history:query', {})
    assert.doesNotMatch(log.rows.map(({ text }) => text).join('\n') + JSON.stringify(events), new RegExp(autoPassword))
    console.log('  PASS Auto device action: echo hold, feature-code trigger, injection verdict, replay/discard and disarm')
  } finally {
    await service.dispose('*')
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
