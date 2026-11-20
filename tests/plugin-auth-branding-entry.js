const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const portable = process.env.PORTABLE_EXECUTABLE_FILE
Object.defineProperty(process, 'platform', { value: 'win32' })
delete process.env.PORTABLE_EXECUTABLE_FILE

const { PluginAuthHost } = require('../src/main/services/plugins/auth')
const input = {
  loginUrl: 'https://oa.example.invalid/login',
  title: 'Device service sign in',
  check: { type: 'http-ok', url: 'https://oa.example.invalid/session' }
}

function reset(identityError) {
  return globalThis.pluginAuthBrandingState = {
    calls: [], windows: [], identityError,
    controller: new AbortController(),
    cancelled: new Error('cancelled by the user')
  }
}

async function main() {
  const host = new PluginAuthHost()
  const current = reset()
  await assert.rejects(host.login(input, current.controller.signal), (error) => error === current.cancelled)
  assert.equal(current.windows.length, 1)
  const win = current.windows[0]
  assert.equal(win.options.show, false, 'login window must not show before native identity is ready')
  assert.equal(win.options.title, input.title, 'plugin login title remains available')
  assert.equal(win.options.icon, path.join(process.cwd(), 'resources', 'branding', 'devkit.ico'))
  assert.ok(fs.existsSync(win.options.icon), 'login window must point to a real runtime ICO')
  const identityCalls = current.calls.filter((call) => call.type === 'details')
  assert.ok(identityCalls.length > 0, 'login window must use the shared Windows application identity')
  const details = identityCalls.find((call) => call.details.relaunchCommand)?.details
  assert.ok(details, 'login window must have a DevKit relaunch command')
  assert.equal(details.appId, 'com.embedded.devkit')
  assert.equal(details.appIconPath, process.execPath,
    'packaged shell identity must use the DevKit executable icon, not an ASAR-only path')
  assert.equal(details.appIconIndex, 0)
  assert.ok(!JSON.stringify(details).includes('oa.example.invalid'),
    'login URL must not become a taskbar relaunch target')
  assert.equal(current.calls.find((call) => call.type === 'load')?.url, input.loginUrl)
  const showIndex = current.calls.findIndex((call) => call.type === 'show')
  const lastIdentityIndex = current.calls.map((call) => call.type).lastIndexOf('details')
  assert.ok(lastIdentityIndex >= 0 && showIndex > lastIdentityIndex,
    'all Windows identity updates must finish before the login window is visible')
  assert.equal(win.destroyed, true, 'cancelled login must still close its child window')
  console.log('PASS plugin auth native branding is applied before show; login URL stays out of shell identity')

  const failure = new Error('native identity failed')
  const failed = reset(failure)
  await assert.rejects(host.login(input, failed.controller.signal), (error) => error === failure)
  assert.equal(failed.windows[0].destroyed, true, 'native identity failure must clean up the hidden window')
  assert.equal(failed.calls.some((call) => call.type === 'show'), false)
  const retry = reset()
  await assert.rejects(host.login(input, retry.controller.signal), (error) => error === retry.cancelled)
  assert.equal(retry.windows.length, 1, 'failed native identity must not leave the login partition locked')
  console.log('PASS plugin auth identity failure cleans up and permits a new login')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (portable === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE
  else process.env.PORTABLE_EXECUTABLE_FILE = portable
  delete globalThis.pluginAuthBrandingState
})
