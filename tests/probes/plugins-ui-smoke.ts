import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
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
  }
  const serial = new SerialService()
  const invoke = serial.invoke.bind(serial)
  serial.invoke = (id, action, payload) => {
    if (action === 'open') panelId = id
    return invoke(id, action, payload)
  }
  const plugins = new PluginService(serial.pluginBridge, [], {
    userData, hostPath: join(process.cwd(), 'out/main/plugin-host.js'),
    hostFactory: (path) => {
      const child = utilityProcess.fork(path, [], { stdio: 'ignore', serviceName: 'DevKit Device Extension' })
      children.push(child)
      return child
    }
  })
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
  await until(() => click('.conn-bar [aria-label=设备插件]'), '打开插件入口')
  await until(() => click('.el-popper button', '插件管理'), '打开插件管理')
  await until(() => click('.el-tabs__item', '已安装插件'), '插件安装页')
  await until(() => fill('input[placeholder="插件目录或 JSON 插件包路径"]', join(userData, 'responder.json')), '插件包路径')
  await until(() => click('.install-row button', '安装'), '安装独立JSON插件包')
  await until(() => click('.el-message-box__btns button', '信任来源并安装'), '确认可信插件代码执行')
  await until(() => text('.package-card', 'devkit.text-hex-responder'), '插件注册成功')
  await until(() => js<boolean>('(() => {const card=[...document.querySelectorAll(".package-card")].find(x=>x.textContent.includes("devkit.text-hex-responder"));const b=card&&[...card.querySelectorAll("button")].find(x=>x.textContent.includes("新建配置"));if(!b)return false;b.click();return true;})()'), '新建插件配置')
  await until(() => fill('input[placeholder="如：COM3 调试设备"]', '插件集成测试'), '实例名称')
  await until(() => click('.editor-toggles .el-switch', '绑定后自动监听'), '打开自动监听设置')
  await until(() => click('.el-dialog__footer button', '保存配置'), '保存schema配置')
  await until(() => click('.el-tabs__item', '配置与当前串口'), '会话绑定页')
  await until(() => text('.instance-card', '插件集成测试'), '新实例')
  await until(() => click('.instance-controls button', '绑定到本串口'), '绑定插件')
  await until(() => text('.instance-card', '已就绪'), '独立utilityProcess启动')
  assert.ok(panelId)

  const port = simulated.ports.at(-1)!
  port.emit('data', Buffer.from('PI'))
  await delay(100)
  assert.equal(sent.length, 0, '半行不触发')
  port.emit('data', Buffer.from('NG\r\nPING\n'))
  await until(() => sent.length === 2, '跨批次与连续帧应答')
  assert.deepEqual(sent, ['PONG\r\n', 'PONG\r\n'])
  await until(() => click('.action-row button', '发送配置的回复'), '手动插件动作')
  await until(() => sent.length === 3, '手动动作完成')

  await until(() => click('.el-dialog__footer button', '关闭'), '关闭插件管理')
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
  await until(() => click('.el-popper button', '插件管理'), '重新打开插件管理')
  await until(() => click('.instance-controls button', '停止'), '停止插件并回收资源')
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
    ignoreCase: false, replyDelayMs: 0, maxBufferBytes: 8192 }
  const saved = await plugins.invoke(panelId, 'instance:save', { instance: {
    id: instanceId, pluginId: 'devkit.text-hex-responder', label: 'HEX regression',
    enabled: true, autoEnabled: true, config: hexConfig
  } }) as { ok: boolean; error?: string }
  assert.equal(saved.ok, true, saved.error)
  const bound = await plugins.invoke(panelId, 'bind', { instanceId }) as { ok: boolean; error?: string }
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

  const rebound = await plugins.invoke(panelId, 'bind', { instanceId }) as { ok: boolean; error?: string }
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
  const restart = await plugins.invoke(panelId, 'bind', { instanceId }) as { ok: boolean; error?: string }
  assert.equal(restart.ok, true, restart.error)
  const finalStop = await plugins.invoke(panelId, 'stop', { instanceId }) as { ok: boolean }
  assert.equal(finalStop.ok, true)
  await writeFile(join(process.cwd(), 'out/plugins-smoke.png'), (await win.capturePage()).toPNG())
  console.log('PASS Electron plugin UI: JSON install, schema config, binding, utilityProcess, split RX, manual action, macro ordering, stop and lock release')
  if (process.env.DEVKIT_PLUGIN_SMOKE_HOLD === '1') {
    console.log('HOLD: fixture window is available for interactive inspection')
    await new Promise<void>(() => {})
  }
}
void main().then(() => 0, async(error: unknown) => {
  console.error(error)
  if (win) {
    console.error(await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'UI unavailable'))
    await writeFile(join(process.cwd(), 'out/plugins-smoke-failure.png'), (await win.capturePage()).toPNG()).catch(() => {})
  }
  return 1
}).then(async(status) => { await disposeAllPanels(); app.exit(status) })