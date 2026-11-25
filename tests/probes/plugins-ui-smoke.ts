import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
import { SerialPort } from 'serialport'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { SerialService } from '../../src/main/services/serial'
import { PluginService } from '../../src/main/services/plugins'
import { setSection } from '../../src/main/services/macro/configStore'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { settingsService } from '../../src/main/services/settings'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'

const portName = 'COM-PLUGIN-SMOKE'
const sent: string[] = []
const sentBytes: Buffer[] = []
const children: Array<{ kill(): unknown }> = []
let panelId = ''
let win: BrowserWindow | undefined
let diagnostics: (() => Promise<unknown>) | undefined

// Synthetic relay fixture: only the auth boundary is mocked; serial, IPC and the
// external plugin's utilityProcess execute the same code as the application.
const relayReply = 'REPLY_UI_SMOKE_1'
const relayConfig = {
  auto: true,
  replySource: 'http',
  loginUrl: 'https://relay.example.invalid/login',
  authOrigins: '',
  authCheckType: 'json',
  authCheckUrl: 'https://relay.example.invalid/api/session',
  authCheckField: 'authenticated',
  fetchMethod: 'POST',
  fetchUrl: 'https://relay.example.invalid/api/reply',
  fetchBody: { input: '$value' },
  fetchResponsePath: 'response',
  fetchLoginExpiredHttp: '401,403',
  fetchLoginExpiredCodes: '',
  fetchRetryLoginOnce: true,
  replyCharset: 'base64',
  replyMinLength: 4,
  replyMaxLength: 4096,
  rules: [
    {
      id: 'manual', label: '手动取数回传', actionLabel: '执行取数回传', trigger: 'manual',
      match: 'prefix', prefix: 'Challenge:',
      result: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied',
      command: 'debug', newline: 'cr', inputTimeoutMs: 2000, valueTtlMs: 30000, resultTimeoutMs: 2000
    },
    {
      id: 'auto', label: '自动取数回传', actionLabel: '自动取数回传', trigger: 'auto',
      triggerWords: 'debug',
      match: 'base64-line', shortMin: 20, shortMax: 21, longMin: 300, longMinDecoded: 260,
      result: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied',
      newline: 'cr', inputTimeoutMs: 2000, valueTtlMs: 30000, resultTimeoutMs: 2000,
      holdInput: true, holdMaxBytes: 4096, holdMaxMs: 15000
    }
  ]
}

async function until<T>(check: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 120; i++) {
    const value = await check()
    if (value) return value as NonNullable<T>
    await delay(75)
  }
  throw new Error('等待超时：' + label)
}

async function main(): Promise<void> {
  const userData = process.env.DEVKIT_SMOKE_USER_DATA ?? process.argv[2]
  app.setPath('userData', userData)
  await app.whenReady()
  const packagePath = join(userData, 'responder.json')
  const { manifest } = JSON.parse(await readFile(packagePath, 'utf8'))
  const isRelay = manifest.id === 'devkit.serial-url-relay'
  const configName = isRelay ? '串口取数回传插件集成测试' : '插件集成测试'
  let issueDelayMs = 0
  let loginCalls = 0
  let issueCalls = 0
  Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [packagePath] }) })
  const simulated = SerialPort as unknown as {
    ports: Array<{ emit(type: string, bytes: Buffer): void }>
    list(): Promise<unknown[]>
    prototype: { write(data: Buffer, done?: (error?: Error) => void): void }
  }
  simulated.list = async () => [{ path: portName, manufacturer: 'DevKit fixture' }]
  simulated.prototype.write = function(data, done) {
    sentBytes.push(Buffer.from(data))
    sent.push(Buffer.from(data).toString('utf8'))
    done?.()
    if (isRelay) {
      const value = Buffer.from(data).toString('utf8')
      if (value === 'debug\r') setImmediate(() => simulated.ports.at(-1)?.emit('data', Buffer.from('Challenge: CHALLENGE_UI_SMOKE\r\n')))
      if (value === relayReply + '\r') setImmediate(() => simulated.ports.at(-1)?.emit('data', Buffer.from(relayReply + '\r\nDebug unlocked\r\n')))
    }
  }
  const serial = new SerialService()
  const invoke = serial.invoke.bind(serial)
  serial.invoke = (id, action, payload) => {
    if (action === 'open') panelId = id
    return invoke(id, action, payload)
  }
  const plugins = new PluginService({ serial: serial.pluginBridge }, [], {
    userData, hostPath: join(process.cwd(), 'out/main/plugin-host.js'),
    auth: {
      async login(options, signal) {
        assert.equal((options as { loginUrl: string }).loginUrl, relayConfig.loginUrl)
        signal.throwIfAborted()
        loginCalls++
      },
      async request(options, signal) {
        const request = options as { url: string; body: string }
        assert.equal(request.url, relayConfig.fetchUrl)
        assert.ok(JSON.parse(request.body).input)
        issueCalls++
        if (issueDelayMs) await delay(issueDelayMs, undefined, { signal })
        signal.throwIfAborted()
        return { status: 200, text: JSON.stringify({ response: relayReply }) }
      }
    },
    hostFactory: (path) => {
      const child = utilityProcess.fork(path, [], { stdio: 'ignore', serviceName: 'DevKit Device Extension' })
      children.push(child)
      return child
    }
  })
  diagnostics = async () => ({ sent, loginCalls, issueCalls, status: await plugins.invoke(panelId, 'status', {}) })
  await setSection('serial', { ...DEFAULT_SERIAL_CONFIG, last: { ...DEFAULT_SERIAL_PARAMS, path: portName } })
  registerService('serial', serial)
  registerService('plugins', plugins)
  registerService('quickcmds', quickCmdsService)
  registerService('settings', settingsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'plugin-integration-smoke' }))
  win = new BrowserWindow({ width: 1240, height: 760, webPreferences: {
    preload: join(process.cwd(), 'out/preload/index.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  setMainWindow(win)
  await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
  const js = <T>(code: string): Promise<T> => win!.webContents.executeJavaScript(code)
  const click = (selector: string, label?: string): Promise<boolean> => js('(() => {' +
    'const target=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(el=>' +
    'el.getClientRects().length&&!el.disabled&&(' + JSON.stringify(label ?? null) + '===null||el.textContent.trim()===' + JSON.stringify(label ?? null) + '));' +
    'if(!target)return false;target.click();return true;})()')
  const fill = (selector: string, value: string): Promise<boolean> => js('(() => {' +
    'const el=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(x=>x.getClientRects().length);' +
    'if(!el)return false;el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event("input",{bubbles:true}));return true;})()')
  const text = (selector: string, contains: string): Promise<boolean> => js(
    '[...document.querySelectorAll(' + JSON.stringify(selector) + ')].some(x=>x.getClientRects().length&&x.textContent.includes(' + JSON.stringify(contains) + '))')

  await until(() => click('.toolbox .tool-row strong', '串口助手'), '打开串口面板')
  await until(() => text('.conn-bar', portName), '模拟设备参数')
  await until(() => click('.conn-bar button', '连接'), '连接模拟串口')
  await until(() => text('.port-status.online', '已连接'), '串口已连接')
  await until(() => click('.app-header button', '扩展'), '打开全局扩展中心')
  await until(() => click('.extension-center button', '从文件安装…'), '打开插件包安装')
  await until(() => click('.el-message-box button', '选择文件'), '确认可信插件并选择 JSON 包')
  await until(() => text('.extension-layout article', manifest.name), '插件注册成功')
  await until(() => click('.extension-layout article button', '新建配置'), '新建插件配置')
  const editor = '.el-dialog:has(.plugin-config-form)'
  await until(() => fill(editor + ' .el-form > .el-form-item input', configName), '实例名称')
  await until(() => click(editor + ' .el-checkbox input:not(:checked)'), '打开自动监听设置')
  await until(() => click(editor + ' .el-dialog__footer button', '保存配置'), '保存schema配置')
  await until(() => text('.instance-row', configName), '新实例')
  if (isRelay) {
    // The extension-center editor only exposes the schema form (no whole-config JSON field),
    // so the full relay fixture is applied through the same instance:save IPC the app uses.
    const listed = await plugins.invoke(panelId, 'instance:list', {}) as { instances: Array<{ id: string; pluginId: string; label: string }> }
    const created = listed.instances.find(x => x.pluginId === manifest.id && x.label === configName)
    assert.ok(created, 'schema-form instance was saved')
    const updated = await plugins.invoke(panelId, 'instance:save', { instance: {
      id: created.id, pluginId: manifest.id, label: configName,
      enabled: true, autoEnabled: true, config: relayConfig
    } }) as { ok: boolean; error?: string }
    assert.equal(updated.ok, true, updated.error)
  }
  const returnToSerial = () => js<boolean>(`(() => {
    const tab = [...document.querySelectorAll('.tab-select')].find(el => el.textContent.includes(${JSON.stringify(portName)}));
    if (!tab) return false; tab.click(); return true;
  })()`)
  await until(returnToSerial, '返回已连接串口')
  await until(() => click('.conn-bar [aria-label=设备插件]'), '打开当前串口插件')
  await until(() => text('.plugin-title', '当前串口插件'), '当前会话插件浮层')
  await until(() => click('.plugin-actions .el-select__wrapper'), '选择实例')
  await until(() => click('.el-select-dropdown__item', configName), '选择新实例')
  await until(() => click('.plugin-actions button', '绑定到当前串口'), '绑定插件')
  await until(() => text('.conn-bar', '监听中'), '独立utilityProcess启动')
  assert.ok(panelId)

  const port = simulated.ports.at(-1)!
  if (isRelay) {
    const actionLabel = manifest.actions.find((action: { id: string }) => action.id === 'run')?.label
    assert.ok(actionLabel, 'relay manifest exposes the stable run action')
    const state = async () => {
      const result = await plugins.invoke(panelId, 'status', {}) as {
        statuses: Array<{ bound: boolean; state: string; value?: { running?: boolean } }>; logs: unknown[]
      }
      return result
    }
    const settled = (automatic = false) => until(async () => (await state()).statuses.some(status =>
      status.bound && status.state === 'ready' && (!automatic || status.value?.running === false)), '取数回传动作完成并释放事务')
    const openPopover = async () => {
      if (!await text('.plugin-title', '当前串口插件')) await until(() => click('.conn-bar [aria-label=设备插件]'), '打开当前串口插件')
    }
    const sendFromUi = async (value: string) => {
      await until(() => fill('input[aria-label="发送内容"]', value), '填写用户发送内容')
      await until(() => click('.send-bar button', '发送'), '从会话发送用户内容')
    }
    await until(() => click('.bound-instance button', actionLabel), '执行外置取数回传手动动作')
    await until(() => sent.includes(relayReply + '\r'), '真实插件匹配设备输出并写入取回的内容')
    await settled()
    assert.equal(loginCalls, 1)
    assert.equal(issueCalls, 1)
    assert.deepEqual(sent.slice(0, 2), ['debug\r', relayReply + '\r'])

    // Cross-callback exclusive lease plus user-input hold/replay, through the UI.
    issueDelayMs = 350
    port.emit('data', Buffer.from('debug\r\nQ0hBTExFTkdFX0FCQ0Q=\r\n'))
    await until(() => issueCalls === 2, '自动订阅跨回调取得设备输出和事务')
    const heldStart = sent.length
    await sendFromUi('HELD')
    assert.equal(sent.length, heldStart, '回传期间用户输入由宿主扣住')
    await until(() => sent.includes('HELD\r\n'), '成功后按原序补发扣住的用户输入')
    assert.deepEqual(sent.slice(heldStart), [relayReply + '\r', 'HELD\r\n'])
    await settled(true)
    assert.equal(JSON.stringify(await state()).includes(relayReply), false, '回传内容不进入状态和诊断日志')

    // Stop while a real plugin RPC is waiting; the stop button must stay usable.
    issueDelayMs = 1000
    await openPopover()
    await until(() => click('.bound-instance button', actionLabel), '启动待取消取数回传动作')
    await until(() => issueCalls === 3, '取数请求在途')
    const beforeCancel = sent.length
    await until(() => click('.bound-instance button', '停止插件'), 'UI 停止在途取数回传动作')
    await until(async () => !(await state()).statuses.some(status => status.bound), '停止并回收绑定')
    await delay(1200)
    assert.equal(sent.length, beforeCancel, '取消后不得发送迟到内容')
    await sendFromUi('USER')
    await until(() => sent.includes('USER\r\n'), '取消后回收串口控制权')

    await openPopover()
    await until(() => click('.plugin-actions .el-select__wrapper'), '重新选择取数回传实例')
    await until(() => click('.el-select-dropdown__item', configName), '选择取数回传配置')
    await until(() => click('.plugin-actions button', '绑定到当前串口'), '重新绑定取数回传插件')
    await until(() => text('.conn-bar', '监听中'), '取数回传插件重新就绪')
    await until(() => click('.bound-instance button', actionLabel), '启动待异常退出取数回传动作')
    await until(() => issueCalls === 4, '异常退出时持有事务')
    const beforeCrash = sent.length
    assert.ok(children.at(-1), 'relay plugin runs in a real utilityProcess')
    children.at(-1)!.kill()
    await until(async () => (await state()).statuses.some(status => status.state === 'error'), '插件进程退出诊断')
    await delay(1200)
    assert.equal(sent.length, beforeCrash, '退出进程不得继续写入内容')
    await sendFromUi('RECOVER')
    await until(() => sent.includes('RECOVER\r\n'), '异常退出后回收独占事务与扣键')
    await openPopover()
    await until(() => click('.error-row button', '一键重试绑定'), 'UI 重试异常退出的插件')
    await until(() => text('.conn-bar', '监听中'), '重试绑定成功')
    await until(() => click('.bound-instance button', '停止插件'), '结束取数回传插件回归')
    await writeFile(join(process.cwd(), 'out/plugins-relay-smoke.png'), (await win.capturePage()).toPNG())
    console.log('PASS Electron serial-url-relay plugin UI: API v2 JSON install, schema config, manual/automatic device-output match, secret write, input hold/replay, in-flight stop, process-exit cleanup and retry')
    return
  }

  port.emit('data', Buffer.from('PI'))
  await delay(100)
  assert.equal(sent.length, 0, '半行不触发')
  port.emit('data', Buffer.from('NG\r\nPING\n'))
  await until(() => sent.length === 2, '跨批次与连续帧应答')
  assert.deepEqual(sent, ['PONG\r\n', 'PONG\r\n'])
  await until(() => click('.bound-instance button', '发送配置的回复'), '手动插件动作')
  await until(() => sent.length === 3, '手动动作完成')

  await until(() => click('.conn-bar [aria-label=设备插件]'), '收起当前串口插件')
  await until(() => click('[aria-label="新建快捷命令"]'), '新建宏')
  await until(() => fill('input[placeholder="如：上电自检流程"]', '插件应答宏'), '宏名称')
  await until(() => click('.steps-head button', '插件动作'), '宏插入插件动作')
  await until(() => text('.step-row', '发送配置的回复'), '宏动作候选')
  await until(() => click('.steps-head button', '命令'), '宏后续命令')
  await until(() => fill('input[placeholder="命令文本"]', 'AFTER'), '后续命令内容')
  await until(() => click('.el-dialog__footer button', '保存'), '保存宏')
  await until(() => click('.cmd-name', '插件应答宏'), '执行插件宏')
  await until(() => sent.length >= 5, '插件动作后继续宏')
  assert.deepEqual(sent.slice(-2), ['PONG\r\n', 'AFTER\r\n'])

  await until(() => click('.conn-bar [aria-label=设备插件]'), '重新打开插件入口')
  await until(() => click('.bound-instance button', '停止插件'), '停止插件并回收资源')
  await delay(300)
  const before = sent.length
  port.emit('data', Buffer.from('PING\n'))
  await delay(250)
  assert.equal(sent.length, before, '停止后不得继续自动写入')
  const manual = await serial.invoke(panelId, 'write', { text: 'USER', mode: 'ascii', newline: 'none' }) as { ok?: boolean }
  assert.equal(manual.ok, true, '停止后串口控制权回收')
  const instances = await plugins.invoke(panelId, 'instance:list', {}) as { ok: boolean; instances: Array<{ id: string; pluginId: string }> }
  assert.equal(instances.ok, true)
  const instanceId = instances.instances.find(x => x.pluginId === 'devkit.text-hex-responder')?.id
  assert.ok(instanceId)
  const hexConfig = { mode: 'hex', match: 'AA 55', response: '00 FF', newline: 'none',
    ignoreCase: false, replyDelayMs: 0, maxBufferBytes: 8192,
    ...(manifest.configSchema.properties.rules ? { rules: [] } : {}) }
  const saved = await plugins.invoke(panelId, 'instance:save', { instance: {
    id: instanceId, pluginId: 'devkit.text-hex-responder', label: 'HEX regression',
    enabled: true, autoEnabled: true, config: hexConfig
  } }) as { ok: boolean; error?: string }
  assert.equal(saved.ok, true, saved.error)
  const bound = await plugins.invoke(panelId, 'bind', { instanceId, transport: 'serial' }) as { ok: boolean; error?: string }
  assert.equal(bound.ok, true, bound.error)
  const hexStart = sentBytes.length
  port.emit('data', Buffer.from([0xaa]))
  await delay(100)
  assert.equal(sentBytes.length, hexStart, 'partial HEX match must not respond')
  port.emit('data', Buffer.from([0x55]))
  await until(() => sentBytes.length === hexStart + 1, 'split HEX match')
  assert.deepEqual([...sentBytes.at(-1)!], [0, 255], 'binary response exact bytes')
  const hexManual = await plugins.invoke(panelId, 'run', { instanceId, actionId: 'send' }) as { ok: boolean; error?: string }
  assert.equal(hexManual.ok, true, hexManual.error)
  await until(() => sentBytes.length === hexStart + 2, 'manual HEX action')
  assert.deepEqual([...sentBytes.at(-1)!], [0, 255])

  const delayed = await plugins.invoke(panelId, 'instance:save', { instance: {
    id: instanceId, pluginId: 'devkit.text-hex-responder', label: 'Cancellation regression',
    enabled: true, autoEnabled: true, config: { ...hexConfig, replyDelayMs: 1000 }
  } }) as { ok: boolean; error?: string }
  assert.equal(delayed.ok, true, delayed.error)
  const beforeCancel = sentBytes.length
  port.emit('data', Buffer.from([0xaa, 0x55]))
  await delay(100)
  const stopped = await plugins.invoke(panelId, 'stop', { instanceId }) as { ok: boolean }
  assert.equal(stopped.ok, true)
  await delay(1200)
  assert.equal(sentBytes.length, beforeCancel, 'stop cancels delayed response')

  const rebound = await plugins.invoke(panelId, 'bind', { instanceId, transport: 'serial' }) as { ok: boolean; error?: string }
  assert.equal(rebound.ok, true, rebound.error)
  const child = children.at(-1)
  assert.ok(child, 'real utilityProcess was forked')
  child.kill()
  await until(async () => {
    const result = await plugins.invoke(panelId, 'status', {}) as { statuses: Array<{ instanceId: string; state: string }> }
    return result.statuses.some(x => x.instanceId === instanceId && x.state === 'error')
  }, 'utilityProcess exit cleanup')
  const afterCrash = sentBytes.length
  port.emit('data', Buffer.from([0xaa, 0x55]))
  await delay(1200)
  assert.equal(sentBytes.length, afterCrash, 'dead process must not write')
  const userWrite = await serial.invoke(panelId, 'write', { text: 'RECOVER', mode: 'ascii', newline: 'none' }) as { ok?: boolean }
  assert.equal(userWrite.ok, true, 'serial lease released after process exit')
  const restart = await plugins.invoke(panelId, 'bind', { instanceId, transport: 'serial' }) as { ok: boolean; error?: string }
  assert.equal(restart.ok, true, restart.error)
  const finalStop = await plugins.invoke(panelId, 'stop', { instanceId }) as { ok: boolean }
  assert.equal(finalStop.ok, true)
  await writeFile(join(process.cwd(), 'out/plugins-smoke.png'), (await win.capturePage()).toPNG())
  console.log('PASS Electron plugin UI: extension-center JSON install, schema config, current-session binding, utilityProcess, split text/HEX, manual action, macro ordering, delayed cancellation, process exit and lock release')
  if (process.env.DEVKIT_PLUGIN_SMOKE_HOLD === '1') {
    console.log('HOLD: fixture window is available for interactive inspection')
    await new Promise<void>(() => {})
  }
}
void main().then(() => 0, async(error: unknown) => {
  console.error(error)
  if (diagnostics) console.error('PLUGIN DIAGNOSTICS', JSON.stringify(await diagnostics().catch(() => 'Unavailable')))
  if (win) {
    console.error(await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'UI unavailable'))
    await writeFile(join(process.cwd(), 'out/plugins-smoke-failure.png'), (await win.capturePage()).toPNG()).catch(() => {})
  }
  return 1
}).then(async(status) => { await disposeAllPanels(); app.exit(status) })