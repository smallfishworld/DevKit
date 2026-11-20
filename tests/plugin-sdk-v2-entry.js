const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const {
  applyDefaults,
  compareSemver,
  createMockPluginContext,
  isFieldVisible,
  parseManifest,
  satisfiesMinVersion,
  validateConfig,
  validateSchema
} = require('../packages/plugin-sdk/src/index')
const { PluginSources } = require('../src/main/services/plugins/sources')
const { PluginService } = require('../src/main/services/plugins/index')
const { PluginStore } = require('../src/main/services/plugins/store')
const { configFields, visibleConfigFields } = require('../src/renderer/src/components/plugin-config-form')

function makeMemoryBridge(transport, target) {
  const listeners = new Map()
  const writes = []
  let active = true
  let seq = 0
  return {
    writes,
    setOpen(open) { active = open },
    emitData(panelId, text) {
      const set = listeners.get(panelId)
      if (!set) return
      const event = {
        type: 'data',
        connectionId: `conn-${transport}`,
        bytes: [...Buffer.from(text, 'utf8')],
        text,
        receivedAt: Date.now(),
        sequence: ++seq
      }
      for (const fn of [...set]) fn(event)
    },
    bridge: {
      transport,
      describe: (panelId) => active ? { panelId, connectionId: `conn-${transport}`, transport, target, encoding: 'utf8' } : undefined,
      subscribe: (panelId, listener) => {
        const set = listeners.get(panelId) ?? new Set()
        listeners.set(panelId, set)
        set.add(listener)
        return () => set.delete(listener)
      },
      acquire: async (_panelId, _owner, signal) => {
        signal.throwIfAborted()
        return {
          connectionId: `conn-${transport}`,
          write: async (bytes) => { writes.push(Buffer.from(bytes).toString('utf8')) },
          release: () => {}
        }
      }
    }
  }
}

async function test() {
  // 1. SDK Schema: x-visibleWhen + object array defaults + hidden required skip
  const schema = {
    type: 'object',
    required: ['mode', 'newline', 'rules'],
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['text', 'hex'], default: 'text' },
      newline: { type: 'string', enum: ['crlf', 'lf'], default: 'crlf', 'x-visibleWhen': { field: 'mode', equals: 'text' } },
      rules: {
        type: 'array',
        default: [],
        items: {
          type: 'object',
          required: ['match', 'reply'],
          properties: {
            match: { type: 'string', default: 'PING' },
            reply: { type: 'string', default: 'PONG' }
          }
        }
      }
    }
  }
  validateSchema(schema)
  assert.equal(isFieldVisible(schema.properties.newline, { mode: 'text' }), true)
  assert.equal(isFieldVisible(schema.properties.newline, { mode: 'hex' }), false)
  // Hidden required field 'newline' is skipped when mode === 'hex'
  validateConfig({ mode: 'hex', rules: [{ match: 'AA', reply: 'BB' }] }, schema)
  const defaulted = applyDefaults({ mode: 'text', rules: [{}] }, schema)
  assert.equal(defaulted.newline, 'crlf')
  assert.deepEqual(defaulted.rules, [{ match: 'PING', reply: 'PONG' }])
  assert.equal(configFields(schema).find((f) => f.key === 'rules')?.widget, 'array')
  assert.deepEqual(visibleConfigFields(schema, { mode: 'hex' }).map((f) => f.key), ['mode', 'rules'])
  console.log('  PASS SDK Schema x-visibleWhen 条件显隐与对象数组默认值')

  // 2. SDK Manifest & Semver
  assert.equal(compareSemver('0.2.0', '0.1.10') > 0, true)
  assert.equal(satisfiesMinVersion('0.1.10', '0.1.9'), true)
  assert.equal(satisfiesMinVersion('0.1.10', '0.2.0'), false)
  const manifest = parseManifest({
    id: 'devkit.multi-responder',
    name: 'Multi Responder',
    version: '2.0.0',
    apiVersion: 2,
    minHostVersion: '0.1.10',
    entry: 'src/index.cjs',
    transports: ['serial', 'ssh', 'net'],
    configSchema: schema,
    actions: [{ id: 'ping', label: 'Ping' }],
    autoRespond: true,
    capabilities: ['stream.read', 'stream.write']
  })
  assert.deepEqual(manifest.transports, ['serial', 'ssh', 'net'])
  assert.throws(() => parseManifest({ ...manifest, apiVersion: 1 }), /apiVersion/)
  assert.throws(() => parseManifest({ ...manifest, transports: [] }), /transports/)
  console.log('  PASS SDK Manifest v2 校验与语义版本比较')

  // 3. SDK Official Mock Harness
  const harness = createMockPluginContext({ config: { mode: 'text' }, session: { transport: 'ssh', target: 'root@10.0.0.1:22' } })
  await harness.ctx.stream.write('HELLO\n')
  assert.equal(harness.writes.length, 1)
  harness.controller.abort(new Error('stopped'))
  await assert.rejects(harness.ctx.stream.write('AFTER'), /stopped/)
  console.log('  PASS SDK createMockPluginContext 夹具与 AbortSignal 中止')

  const protocol = createMockPluginContext({
    onWrite(data) { protocol.emitData(String(data) === 'CHALLENGE' ? 'DEVICE-CHALLENGE' : 'OK') },
    onAuthLogin: async () => {},
    onAuthRequest: async () => ({ status: 200, text: 'TOKEN' })
  })
  const received = []
  const stopListening = protocol.ctx.stream.subscribe(event => received.push(event.text))
  const protocolLease = await protocol.ctx.stream.acquire()
  await protocol.ctx.stream.hold({ maxBytes: 512, maxMs: 1000 })
  await protocolLease.write('CHALLENGE')
  assert.deepEqual(received, ['DEVICE-CHALLENGE'], 'subscribe is active before immediate protocol replies')
  await protocol.ctx.auth.login({ loginUrl: 'https://test.invalid/login', check: { type: 'http-ok', url: 'https://test.invalid/session' } })
  const token = await protocol.ctx.auth.request({ loginUrl: 'https://test.invalid/login', url: 'https://test.invalid/token' })
  await protocolLease.write(token.text, { secret: true })
  assert.equal(protocol.writes.at(-1).options.secret, true)
  await protocol.ctx.stream.releaseHold(true)
  await protocolLease.release()
  assert.deepEqual(protocol.leases, { active: false, acquired: 1, released: 1 })
  assert.deepEqual(protocol.holds.releases, [true])
  stopListening()
  protocol.emitData('unsubscribed')
  assert.deepEqual(received, ['DEVICE-CHALLENGE', 'OK'])
  await assert.rejects(protocolLease.write('stale'), /事务已结束/)
  console.log('  PASS SDK v2 explicit lease, input hold, immediate subscription and auth protocol fixtures')

  // 4. Sources v2 governance (minHostVersion + yanked + deprecated)
  const root = await fs.mkdtemp(join(tmpdir(), 'devkit-sdk-v2-'))
  try {
    const indexUrl = 'https://example.test/v2/index.json'
    const pkgBytes = Buffer.from(JSON.stringify({ manifest, files: { 'src/index.cjs': 'module.exports = {}' } }))
    const sha256 = createHash('sha256').update(pkgBytes).digest('hex')
    const yankedEntry = { id: 'devkit.yanked', name: 'Yanked', version: '1.0.0', apiVersion: 2, url: 'y.json', sha256, yanked: true }
    const futureEntry = { id: 'devkit.future', name: 'Future', version: '1.0.0', apiVersion: 2, url: 'f.json', sha256, minHostVersion: '9.0.0' }
    const okEntry = { id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 2, url: 'ok.json', sha256, minHostVersion: '0.1.10', deprecated: '请升级至 v3' }
    const idxBuf = Buffer.from(JSON.stringify({ version: 2, plugins: [yankedEntry, futureEntry, okEntry] }))
    const sources = new PluginSources(root, async (u) => u === indexUrl ? idxBuf : pkgBytes, '0.1.10')
    const [, added] = await sources.add('V2 Source', indexUrl)
    const [, refreshed] = await sources.refresh(added.id)
    assert.equal(refreshed.entries[2].deprecated, '请升级至 v3')
    await assert.rejects(sources.package(added.id, yankedEntry.id, sha256, 4096), /撤回/)
    await assert.rejects(sources.package(added.id, futureEntry.id, sha256, 4096), /DevKit >= 9\.0\.0/)
    assert.deepEqual(await sources.package(added.id, okEntry.id, sha256, 4096), pkgBytes)
    console.log('  PASS 扩展源 v2 版本兼容、yanked 拦截与 deprecated 透传')

    const sourceService = new PluginService({}, [], {
      userData: root, hostVersion: '0.1.10', emit() {},
      download: async (url) => url === indexUrl ? idxBuf : pkgBytes
    })
    const sourced = await sourceService.invoke('plugin-catalog', 'sources:install', { sourceId: added.id, pluginId: okEntry.id, sha256 })
    assert.equal(sourced.ok, true, sourced.error)
    assert.deepEqual(sourced.plugin.installSource, { name: 'V2 Source', url: indexUrl })
    assert.deepEqual((await new PluginStore(root).listInstalled())[0].installSource, sourced.plugin.installSource, 'source provenance survives host restart')
    const localBundle = join(root, 'local.json')
    await fs.writeFile(localBundle, pkgBytes)
    assert.equal((await new PluginStore(root).install(localBundle, new Set())).installSource, undefined, 'local replacement clears previous source provenance')
    assert.equal((await new PluginStore(root).listInstalled())[0].installSource, undefined)
    await fs.writeFile(localBundle, JSON.stringify({ manifest, files: { 'src/index.cjs': 'exports.activate=()=>({})', '.devkit-install-source.json': '{}' } }))
    await assert.rejects(new PluginStore(root).install(localBundle, new Set()), /宿主保留文件/, 'packages cannot forge source provenance')
    await sourceService.dispose('*')
    console.log('  PASS v2 source install provenance persists across restart and rejects forged package metadata')

    // 5. PluginService multi-transport (SSH + Net + Serial)
    const serial = makeMemoryBridge('serial', 'COM3')
    const ssh = makeMemoryBridge('ssh', 'root@192.168.1.1:22')
    const net = makeMemoryBridge('net', 'tcp://127.0.0.1:9000')
    const builtin = {
      manifest,
      activate(ctx) {
        return {
          async run(actionId) {
            if (actionId === 'ping') {
              await ctx.stream.write(`PING@${ctx.session.transport}`)
              return { transport: ctx.session.transport }
            }
            throw new Error('unknown')
          }
        }
      }
    }
    const events = []
    const service = new PluginService(
      { serial: serial.bridge, ssh: ssh.bridge, net: net.bridge },
      [builtin],
      { userData: root, hostVersion: '0.1.10', emit: (panelId, type, payload) => events.push({ panelId, type, payload }) }
    )
    const saved = await service.invoke('plugin-catalog', 'instance:save', {
      instance: { id: 'inst-ssh', pluginId: manifest.id, label: 'SSH Responder', config: { mode: 'hex', rules: [] }, enabled: true, autoEnabled: false }
    })
    assert.equal(saved.ok, true)
    const bound = await service.invoke('panel-ssh-1', 'bind', { instanceId: 'inst-ssh', transport: 'ssh' })
    assert.equal(bound.ok, true)
    assert.equal(bound.status.transport, 'ssh')
    const ran = await service.invoke('panel-ssh-1', 'run', { instanceId: 'inst-ssh', actionId: 'ping' })
    assert.equal(ran.ok, true)
    assert.deepEqual(ran.result, { transport: 'ssh' })
    assert.deepEqual(ssh.writes, ['PING@ssh'])
    await service.dispose('*')
    console.log('  PASS PluginService 多传输桥接（SSH 绑定、流租约写入与增量事件）')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test().catch((error) => { console.error(error); process.exitCode = 1 })
