const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { generateKeyPairSync } = require('node:crypto')
const { Server } = require('ssh2')
const { SerialPort } = require('serialport')
const { serialService } = require('../src/main/services/serial')
const { sshService } = require('../src/main/services/ssh')
const { SessionHistory } = require('../src/main/services/terminal/history')
const { setMainWindow } = require('../src/main/ipc')
const { DEFAULT_SERIAL_PARAMS } = require('../src/shared/serial')
const { DEFAULT_SSH_PARAMS } = require('../src/shared/ssh')

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function waitFor(condition) {
  for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('condition timed out')
}

async function main() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'devkit-terminal-services-'))
  globalThis.terminalTestDir = dir
  const events = []
  const failures = []
  let acknowledge = true
  setMainWindow({ isDestroyed: () => false, webContents: { send: (_channel, event) => {
    events.push(event)
    if (event.type === 'error') failures.push(event.payload)
    if (acknowledge && event.type === 'data') queueMicrotask(() => {
      const service = event.tool === 'serial' ? serialService : sshService
      service.invoke(event.panelId, 'output:ack', event.payload)
    })
  } } })
  const clients = new Set()
  let server
  try {
    assert.equal((await serialService.invoke('serial-1', 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' })).ok, true)
    const port = SerialPort.ports.at(-1)
    // The final incomplete UTF-8 chunk must be flushed on disconnect, not left in a timer.
    const text = Buffer.from('开头\r\n中文😀TAIL')
    port.emit('data', text.subarray(0, text.length - 3)); port.emit('data', text.subarray(text.length - 3))
    await serialService.invoke('serial-1', 'close')
    const page = await serialService.invoke('serial-1', 'history:query', {})
    assert.ok(page.rows.some((r) => r.text.includes('中文😀TAIL')))
    assert.equal(serialService.runtime.options.size, 0)
    globalThis.terminalExportPath = join(dir, 'serial-export.log')
    assert.equal((await serialService.invoke('serial-1', 'log:mem-save')).ok, true)
    await Promise.all([serialService.dispose('serial-1'), serialService.dispose('serial-1')])
    await tick(); assert.equal(serialService.runtime.histories.size, 0)
    assert.equal(port.isOpen, false)
    console.log('  PASS serial disconnect/export and duplicate panel disposal')

    const opening = serialService.invoke('serial-pending', 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM2' })
    const disposing = serialService.dispose('serial-pending')
    await Promise.all([opening, disposing]); await tick()
    assert.equal(SerialPort.ports.at(-1).isOpen, false)
    assert.equal(serialService.runtime.histories.size, 0)
    console.log('  PASS dispose while serial open is pending')

    acknowledge = false
    await serialService.invoke('serial-flow', 'open', { ...DEFAULT_SERIAL_PARAMS, path: 'COM3', rtscts: true })
    const flowPort = SerialPort.ports.at(-1)
    flowPort.emit('data', Buffer.alloc(150 * 1024, 120))
    assert.equal(flowPort.paused, true)
    for (const event of events.filter((e) => e.panelId === 'serial-flow' && e.type === 'data')) serialService.invoke('serial-flow', 'output:ack', event.payload)
    await waitFor(() => !flowPort.paused)
    flowPort.emit('data', Buffer.from('\nAFTER-PAUSE'))
    flowPort.isOpen = false; flowPort.emit('close')
    await waitFor(() => serialService.runtime.options.size === 0)
    const afterClose = await serialService.invoke('serial-flow', 'history:query', { query: 'AFTER-PAUSE' })
    assert.ok(afterClose.rows.some((r) => r.text.includes('AFTER-PAUSE')))
    await serialService.dispose('*'); acknowledge = true
    console.log('  PASS serial hardware flow control and unexpected close tail flushing')

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    let remoteStream
    server = new Server({ hostKeys: [privateKey] }, (client) => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {})
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => {
          remoteStream = acceptShell()
          remoteStream.write('SSH-HELLO\r\n')
          remoteStream.stderr.write('STDERR-ONLY\n')
        })
      }))
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const connected = await sshService.invoke('ssh-1', 'connect', { ...DEFAULT_SSH_PARAMS, host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test' })
    assert.equal(connected.ok, true, connected.error)
    await waitFor(() => events.some((e) => e.panelId === 'ssh-1' && e.type === 'data' && e.payload.text.includes('STDERR-ONLY')))
    remoteStream.write('中文😀LAST-LINE')
    await waitFor(() => events.some((e) => e.panelId === 'ssh-1' && e.type === 'data' && e.payload.text.includes('LAST-LINE')))
    await sshService.invoke('ssh-1', 'close')
    const sshPage = await sshService.invoke('ssh-1', 'history:query', {})
    assert.ok(sshPage.rows.some((r) => r.text.includes('LAST-LINE')))
    assert.ok(sshPage.rows.some((r) => r.text.includes('STDERR-ONLY')))
    await Promise.all([sshService.dispose('ssh-1'), sshService.dispose('*')]); await tick()
    assert.equal(sshService.runtime.histories.size, 0); assert.equal(sshService.runtime.options.size, 0)
    assert.deepEqual(failures, [])
    console.log('  PASS real SSH loopback, stderr, tail history and wildcard disposal')

    const createHistory = SessionHistory.create
    let releaseHistory
    const historyGate = new Promise((resolve) => { releaseHistory = resolve })
    let creating = false
    SessionHistory.create = async (...args) => {
      creating = true
      await historyGate
      return createHistory.call(SessionHistory, ...args)
    }
    try {
      let openFinished = false
      const opening = sshService.invoke('ssh-race', 'connect', { ...DEFAULT_SSH_PARAMS, host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test' })
        .then((result) => { openFinished = true; return result })
      await waitFor(() => creating)
      for (const client of clients) client.end()
      await waitFor(() => clients.size === 0)
      let disposed = false
      const disposing = sshService.dispose('ssh-race').then(() => { disposed = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      const prematurelyFinished = openFinished || disposed
      releaseHistory()
      const result = await opening
      await disposing
      assert.equal(prematurelyFinished, false)
      assert.equal(result.ok, false)
      assert.equal(sshService.runtime.histories.size, 0)
      assert.equal(sshService.runtime.options.size, 0)
      console.log('  PASS SSH disconnect during log creation waits for cleanup before dispose')
    } finally { releaseHistory(); SessionHistory.create = createHistory }
  } finally {
    await serialService.dispose('*'); await sshService.dispose('*')
    for (const client of clients) client.end()
    if (server) await new Promise((resolve) => server.close(resolve))
    setMainWindow(null)
    await fs.rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
