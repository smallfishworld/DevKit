import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import { disposeAllPanels, registerService, registerToolIpc, setMainWindow } from '../../src/main/ipc'
import { setSection } from '../../src/main/services/macro/configStore'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { SerialService } from '../../src/main/services/serial'
import { PluginService } from '../../src/main/services/plugins'
import { parseDeviceActionsConfig } from '../../src/main/services/serial/device-actions-config'
import { createDeviceActionProvider } from '../../src/main/services/serial/device-actions-provider'
import { settingsService } from '../../src/main/services/settings'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'

const portName = 'COM-SMOKE'
const challenge = 'SIM_CHALLENGE_47'
const autoChallenge = 'QUJDREVGR0hJSktMTU5P='
const responseCode = 'SIM_UNLOCK_8561'
const sent: string[] = []
let oaVisits = 0
let issueRequests = 0
let rejectNext = false
let holdChallenge = false
let authOrigin = ''
let serviceOrigin = ''
let cookieSeen = false

const oa = createServer((_req, res) => {
  oaVisits++
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<title>Mock OA</title><a id="sign-in" href="${serviceOrigin}/approved">模拟登录</a>`)
})
const site = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.url === '/login') {
    res.writeHead(302, { Location: `${authOrigin}/oa` }).end()
    return
  }
  if (req.url === '/approved') {
    res.setHeader('Set-Cookie', 'debug_fixture=authorized; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600')
    res.end('模拟登录成功')
    return
  }
  const authorized = !!req.headers.cookie?.split('; ').includes('debug_fixture=authorized')
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/status') {
    res.statusCode = authorized ? 200 : 401
    res.end(JSON.stringify({ authenticated: authorized }))
    return
  }
  if (req.url === '/issue' && req.method === 'POST') {
    issueRequests++
    cookieSeen ||= authorized
    let body = ''
    for await (const chunk of req) body += chunk
    if (!authorized || rejectNext ||
      (body !== JSON.stringify({ challenge }) && body !== JSON.stringify({ challenge: autoChallenge }))) {
      res.writeHead(403).end('{}')
      return
    }
    res.end(JSON.stringify({ response: responseCode }))
    return
  }
  res.writeHead(404).end('{}')
})

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('没有模拟服务地址'))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

async function until<T>(check: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 180; i++) {
    const result = await check()
    if (result) return result
    await delay(50)
  }
  throw new Error(`等待 ${label} 超时`)
}

async function main(): Promise<void> {
  app.setPath('userData', process.env.DEVKIT_SMOKE_USER_DATA ?? process.argv[2])
  await app.whenReady()
  const [loginOrigin, portalOrigin] = await Promise.all([listen(oa), listen(site)])
  authOrigin = loginOrigin
  serviceOrigin = portalOrigin
  const config = parseDeviceActionsConfig({
    loginUrl: `${serviceOrigin}/login`,
    authOrigins: [authOrigin],
    authCheck: { type: 'json', url: `${serviceOrigin}/status`, field: 'authenticated' },
    issue: {
      url: `${serviceOrigin}/issue`, body: { challenge: '$challenge' }, responsePath: 'response',
      retryLoginOnce: false
    },
    profiles: [{
      id: 'fixture', label: '模拟 Release 设备',
      detect: { type: 'prefix', prefix: 'Challenge:' },
      result: { type: 'line', successLine: 'Debug unlocked', failureLine: 'Debug denied' },
      command: 'debug'
    }, {
      id: 'auto-fixture', label: '模拟自动应答设备', trigger: 'auto', triggerWords: ['debug'],
      detect: { type: 'base64-line' },
      result: { type: 'prompt-repeat', decisionDelayMs: 150, silenceMs: 3000 },
      holdInput: { maxBytes: 4096, maxMs: 5000 }
    }]
  }, true)
  const service = new SerialService(async () => createDeviceActionProvider(config))
  const simulated = SerialPort as unknown as {
    list: () => Promise<unknown[]>
    ports: Array<{ emit: (name: string, data: Buffer) => void }>
    prototype: { write: (this: { emit: (name: string, data: Buffer) => void }, bytes: Buffer, done?: () => void) => void }
  }
  simulated.list = async () => [{ path: portName, friendlyName: 'Device action fixture' }]
  simulated.prototype.write = function (bytes, done) {
    const text = bytes.toString()
    sent.push(text)
    done?.()
    if (text === 'debug\r' && !holdChallenge) {
      this.emit('data', Buffer.from('Chall'))
      setTimeout(() => this.emit('data', Buffer.from(`enge: ${challenge}\r\n`)), 60)
    }
    if (text === `${responseCode}\r`) {
      this.emit('data', Buffer.from(responseCode.slice(0, 7)))
      setTimeout(() => this.emit('data', Buffer.from(`${responseCode.slice(7)}\r\nDebug unlocked\r\n`)), 60)
    }
  }
  await setSection('serial', { ...DEFAULT_SERIAL_CONFIG, last: { ...DEFAULT_SERIAL_PARAMS, path: portName } })
  registerService('serial', service)
  registerService('plugins', new PluginService(service.pluginBridge, [service.oaPlugin], {
    hostPath: join(process.cwd(), 'out/main/plugin-host.js')
  }))
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'device-actions-smoke' }))
  const win = new BrowserWindow({ width: 1280, height: 900, webPreferences: {
    preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  setMainWindow(win)
  await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code)
  const click = (selector: string, label?: string): Promise<boolean> => js(`(() => {
    const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x =>
      x.getClientRects().length && !x.disabled && (${JSON.stringify(label ?? null)} === null || x.textContent.trim() === ${JSON.stringify(label ?? null)}));
    if (!item) return false;
    item.click(); return true;
  })()`)
  const fill = (selector: string, value: string): Promise<boolean> => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`)
  await until(() => click('.toolbox .tool-row strong', '串口助手'), '串口面板')
  await until(() => js(`document.querySelector('.conn-bar').textContent.includes('${portName}')`), '模拟串口配置')
  await until(() => click('.conn-bar button', '连接'), '打开串口')
  await until(() => js(`!!document.querySelector('.port-status.online')`), '串口连接成功')
  await until(() => click('[aria-label="新建快捷命令"]'), '快捷命令编辑器')
  await until(() => fill('input[placeholder="如：上电自检流程"]', '模拟解锁并查版本'), '宏名称')
  await until(() => click('.steps-head button', '设备动作'), '添加设备动作步骤')
  if (!(await js(`document.querySelector('.step-row').textContent.includes('模拟 Release 设备')`))) {
    await until(() => click('.step-row .el-select__wrapper'), '打开设备配置')
    await until(() => click('.el-select-dropdown__item', '模拟 Release 设备'), '选择设备配置')
  }
  await until(() => click('.steps-head button', '命令'), '添加普通步骤')
  await until(() => fill('input[placeholder="命令文本"]', 'version'), '版本查询命令')
  await until(() => click('.el-dialog__footer button', '保存'), '保存快捷命令')
  const play = () => click('.cmd-name', '模拟解锁并查版本')
  const versionCount = () => sent.filter((text) => text === 'version\r\n').length
  await until(play, '运行快捷命令')
  const login = await until(() => BrowserWindow.getAllWindows().find((item) => item !== win), 'OA 登录窗口')
  await until(() => login.webContents.getURL().startsWith(authOrigin) &&
    login.webContents.executeJavaScript(`!!document.querySelector('#sign-in')`), '模拟 OA 页面')
  assert.deepEqual(sent, [], '登录完成前不可发送 debug')
  assert.equal(await login.webContents.executeJavaScript(`typeof window.api`), 'undefined')
  await login.webContents.executeJavaScript(`document.querySelector('#sign-in').click()`)
  await until(() => versionCount() === 1, '解锁后才发送版本查询')
  assert.deepEqual(sent, ['debug\r', `${responseCode}\r`, 'version\r\n'])
  assert.equal(cookieSeen, true)
  assert.equal(oaVisits, 1)

  await delay(80)
  await until(play, '再次运行快捷命令')
  await until(() => versionCount() === 2, '使用登录会话再次解锁')
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  assert.equal(oaVisits, 1)

  await delay(80)
  rejectNext = true
  await until(play, '运行被拒绝的快捷命令')
  await until(() => issueRequests === 3, '接口拒绝请求')
  await until(() => js(`document.body.textContent.includes('登录已失效')`), '界面显示登录失效')
  assert.equal(versionCount(), 2)
  assert.equal(sent.at(-1), 'debug\r')
  assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(responseCode)})`), false)

  rejectNext = false
  const port = simulated.ports.at(-1)!
  const autoCount = () => sent.filter((text) => text === `${responseCode}\r`).length
  const beforeAuto = autoCount()
  await until(() => click('.el-checkbox', '自动应答'), '勾选自动应答')
  await delay(500)
  port.emit('data', Buffer.from('debug\r\n'))
  port.emit('data', Buffer.from(`${autoChallenge}\r\n`))
  await until(() => autoCount() === beforeAuto + 1, '自动应答注入口令')
  await until(() => js(`document.body.textContent.includes('设备动作成功')`), '自动应答成功提示')
  assert.equal(versionCount(), 2)
  assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(responseCode)})`), false)

  await until(() => click('.el-checkbox', '自动应答'), '取消自动应答')
  await delay(300)
  port.emit('data', Buffer.from(`${autoChallenge}\r\n`))
  await delay(500)
  assert.equal(autoCount(), beforeAuto + 1)

  holdChallenge = true
  await until(play, '启动待取消的设备动作')
  await until(() => js('!!document.querySelector(".device-action-strip")'), '终端顶部显示动作进度')
  await until(() => click('[aria-label="会话与快捷命令"]'), '折叠快捷命令侧栏')
  await until(() => js('!document.querySelector(".sessions").getClientRects().length'), '侧栏已隐藏')
  await until(() => click('.device-action-strip button', '取消动作'), '侧栏隐藏时取消动作')
  await until(() => js('!document.querySelector(".device-action-strip")'), '取消后顶部状态消失')
  assert.equal(versionCount(), 2, '取消后不再发送宏的后续命令')

  // 可视化配置：空目录 → 创建示例 → 保存落盘
  const userData = process.env.DEVKIT_SMOKE_USER_DATA ?? process.argv[2]
  await until(() => click('.term-opts button', '设备动作'), '打开设备动作配置')
  await until(() => js(`[...document.querySelectorAll('.el-dialog__title')].some(x =>
    x.getClientRects().length && x.textContent.includes('设备动作配置'))`), '设备动作配置弹窗')
  await until(() => click('button', '创建示例配置'), '创建示例配置')
  await until(() => click('button', '保存'), '保存设备动作配置')
  await until(() => js(`document.body.textContent.includes('设备动作配置已保存')`), '保存成功提示')
  const saved = JSON.parse(await readFile(join(userData, 'device-actions.json'), 'utf8'))
  assert.equal(saved.loginUrl, 'https://oa.example.com/login')
  assert.equal(saved.profiles.length, 2)
  await until(() => click('button', '关闭'), '关闭设备动作配置')

  // 配置损坏时仍可在弹窗内直接修复
  await writeFile(join(userData, 'device-actions.json'), '{ broken', 'utf8')
  await until(() => click('.term-opts button', '设备动作'), '重新打开设备动作配置')
  await until(() => js(`document.body.textContent.includes('原配置文件无法解析')`), '损坏配置提示')
  await until(() => js(`[...document.querySelectorAll('textarea')].some(x =>
    x.getClientRects().length && x.value === '{ broken')`), '损坏内容可直接编辑')
  await until(() => click('button', '关闭'), '关闭配置修复视图')
  console.log('PASS Electron UI: create macro, OA login, same-session Cookie reuse, serial confirmation, login-expiry stops playback, auto answer only while armed, visual config saves and repairs')
}

void main().then(() => 0, (error: unknown) => { console.error(error); return 1 }).then(async (status) => {
  await disposeAllPanels()
  for (const server of [oa, site]) server.close()
  app.exit(status)
})
