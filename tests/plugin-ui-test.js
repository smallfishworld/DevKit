/* Plugin UI logic: configuration preservation, action availability and awaited macro playback. */
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const output = path.join(__dirname, '.plugin-ui-test.cjs')
buildSync({
  entryPoints: [path.join(__dirname, 'plugin-ui-entry.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: output, logLevel: 'error'
})
const {
  configFields, defaultPluginConfig, parseConfigJson, pluginActionKey,
  canStopPlugin, availablePluginActions, validatePlayback, migrateQuickCmd,
  stepPreview, useTermMacros
} = require(output)

let count = 0
function check(name, test) {
  test()
  count++
  console.log('  [PASS] ' + name)
}
async function main() {
  const schema = {
    type: 'object', required: ['trigger'], properties: {
      trigger: { type: 'string', title: '触发内容', default: 'PING' },
      enabled: { type: 'boolean', default: false },
      delay: { type: 'integer', default: 0 },
      mode: { type: 'string', enum: ['text', 'hex'] },
      rules: { type: 'array', default: [{ match: 'PING', reply: 'PONG' }] }
    }
  }
  check('schema controls keep booleans/numbers and complex JSON distinct', () => {
    const fields = configFields(schema)
    assert.deepEqual(fields.map(field => field.widget), ['string', 'boolean', 'number', 'enum', 'json'])
    assert.equal(fields[0].required, true)
    assert.equal(fields[0].title, '触发内容')
  })
  check('defaults preserve false/zero and do not mutate a shared schema', () => {
    const config = defaultPluginConfig(schema)
    assert.equal(config.enabled, false)
    assert.equal(config.delay, 0)
    assert.equal(config.mode, undefined)
    config.rules[0].reply = 'changed'
    assert.equal(defaultPluginConfig(schema).rules[0].reply, 'PONG')
  })
  check('JSON editor rejects arrays/null/syntax errors without replacing a config', () => {
    for (const text of ['[]', 'null', 'true', '{ invalid']) {
      assert.equal(parseConfigJson(text).config, undefined)
      assert.ok(parseConfigJson(text).error)
    }
    assert.deepEqual(parseConfigJson('{"future":{"field":1}}').config, { future: { field: 1 } })
  })
  check('action keys cannot collide through separators in IDs', () => {
    assert.notEqual(pluginActionKey('a/b', 'c'), pluginActionKey('a', 'b/c'))
  })
  check('stop remains available during awaited run and suppresses double cancellation', () => {
    assert.equal(canStopPlugin(true, 'run', false), true)
    assert.equal(canStopPlugin(true, '', false), true)
    assert.equal(canStopPlugin(true, 'run', true), false)
    assert.equal(canStopPlugin(false, 'run', false), false)
    assert.equal(canStopPlugin(true, 'install', false), false)
  })

  const packages = [{ id: 'sample.reply', actions: [{ id: 'send', label: '立即发送' }] }]
  const instances = [
    { id: 'enabled', pluginId: 'sample.reply', label: '设备 A', enabled: true },
    { id: 'disabled', pluginId: 'sample.reply', label: '设备 B', enabled: false },
    { id: 'missing', pluginId: 'missing.plugin', label: '保留的旧配置', enabled: true }
  ]
  const actions = availablePluginActions(packages, instances)
  check('macro choices exclude disabled/missing plugins without deleting their configs', () => {
    assert.deepEqual(actions.map(action => action.instanceId), ['enabled'])
    assert.equal(instances.length, 3)
  })
  check('macro choices cannot claim a configuration bound to a different panel', () => {
    const status = [{ instanceId: 'enabled', panelId: 'other', state: 'ready', bound: true }]
    assert.equal(availablePluginActions(packages, instances, status, 'current').length, 0)
    assert.equal(availablePluginActions(packages, instances, status, 'other').length, 1)
  })
  const step = { type: 'plugin-action', instanceId: 'enabled', actionId: 'send' }
  const macro = { name: 'test', steps: [{ type: 'cmd', text: 'before' }, step] }
  check('all macro steps are validated before execution on unsupported terminals', () => {
    assert.match(validatePlayback(macro), /仅支持串口/)
    assert.match(validatePlayback(macro, []), /找不到/)
    assert.equal(validatePlayback(macro, actions), undefined)
    assert.match(validatePlayback({ name: 'bad', steps: [{ ...step, actionId: 'missing' }] }, actions), /找不到/)
  })
  check('import keeps stable references while stripping plugin code/credentials', () => {
    const migrated = migrateQuickCmd({
      name: 'imported', steps: [{ ...step, code: 'unexpected', password: 'secret', config: { url: 'unexpected' } }]
    })
    assert.deepEqual(migrated.steps, [step])
    assert.match(stepPreview(step), /enabled.*send/)
    // 已移除的「设备动作」步骤在导入时被丢弃，只保留仍然支持的步骤
    assert.deepEqual(
      migrateQuickCmd({ name: 'legacy', steps: [{ type: 'device-action', profile: 'debug' }, { type: 'cmd', text: 'x' }] }).steps,
      [{ type: 'cmd', text: 'x' }])
  })

  const { playCmd } = useTermMacros()
  const events = []
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const playback = playCmd(
    { name: 'ordered', steps: [step, { type: 'cmd', text: 'after' }] },
    async command => { events.push(command.text) }, () => true,
    async ref => { assert.deepEqual(ref, { instanceId: 'enabled', actionId: 'send' }); events.push('start'); await waiting; events.push('complete') }
  )
  await Promise.resolve()
  assert.deepEqual(events, ['start'])
  release()
  await playback
  check('macro awaits plugin completion before issuing the following command', () => {
    assert.deepEqual(events, ['start', 'complete', 'after'])
  })

  const failureEvents = []
  await assert.rejects(() => playCmd(
    { name: 'failure', steps: [step, { type: 'cmd', text: 'must-not-send' }] },
    command => failureEvents.push(command.text), () => true,
    async () => { throw new Error('plugin failed') }
  ), /plugin failed/)
  check('plugin failure aborts later macro commands', () => { assert.deepEqual(failureEvents, []) })

  let connected = true
  const reconnectEvents = []
  await playCmd(
    { name: 'reconnect', steps: [step, { type: 'cmd', text: 'must-not-send' }] },
    command => reconnectEvents.push(command.text), () => connected,
    async () => { connected = false }
  )
  check('connection change after an action prevents subsequent macro writes', () => {
    assert.deepEqual(reconnectEvents, [])
  })
  console.log('plugin-ui-test: all ' + count + ' passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
