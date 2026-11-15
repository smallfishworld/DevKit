import assert from 'node:assert/strict'
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
import { parseDebugUnlockConfig } from '../../src/main/services/serial/debug-unlock-config'
import { createDebugUnlockProvider } from '../../src/main/services/serial/debug-unlock-provider'
import { settingsService } from '../../src/main/services/settings'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'

const portName = 'COM-SMOKE'
const challenge = 'SIM_CHALLENGE_47'
const responseCode = 'SIM_UNLOCK_8561'
const sent: string[] = []
let oaVisits = 0
let issueRequests = 0
let rejectNext = false
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
    if (!authorized || rejectNext || body !== JSON.stringify({ challenge })) {
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
  app.setPath('userData', process.argv[2])
  await app.whenReady()
  const [loginOrigin, portalOrigin] = await Promise.all([listen(oa), listen(site)])
  authOrigin = loginOrigin
  serviceOrigin = portalOrigin
  const config = parseDebugUnlockConfig({
    loginUrl: `${serviceOrigin}/login`, statusUrl: `${serviceOrigin}/status`, issueUrl: `${serviceOrigin}/issue`,
    authOrigins: [authOrigin], profiles: [{ id: 'fixture', label: '模拟 Release 设备',
      challengePrefix: 'Challenge:', successLine: 'Debug unlocked', failureLine: 'Debug denied' }]
  }, true)
  const service = new SerialService(async () => createDebugUnlockProvider(config))
  const simulated = SerialPort as unknown as {
    list: () => Promise<unknown[]>
    prototype: { write: (this: { emit: (name: string, data: Buffer) => void }, bytes: Buffer, done?: () => void) => void }
  }
  simulated.list = async () => [{ path: portName, friendlyName: 'Debug fixture' }]
  simulated.prototype.write = function (bytes, done) {
    const text = bytes.toString()
    sent.push(text)
    done?.()
    if (text === 'debug\r') {
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
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'debug-smoke' }))
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
  await until(() => click('.tool-card .tool-name', '串口助手'), '串口面板')
  await until(() => js(`document.querySelector('.conn-bar').textContent.includes('${portName}')`), '模拟串口配置')
  await until(() => click('.conn-bar button', '打开'), '打开串口')
  await until(() => js(`!!document.querySelector('.com-badge')`), '串口连接成功')
  await until(() => click('[aria-label="新建快捷命令"]'), '快捷命令编辑器')
  await until(() => fill('input[placeholder="如：上电自检流程"]', '模拟解锁并查版本'), '宏名称')
  await until(() => click('.steps-head button', '解锁 Debug'), '添加解锁步骤')
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
  await until(() => js(`document.body.textContent.includes('取码接口拒绝请求')`), '界面显示拒绝')
  assert.equal(versionCount(), 2)
  assert.equal(sent.at(-1), 'debug\r')
  assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(responseCode)})`), false)
  console.log('PASS Electron UI: create macro, OA login, same-session Cookie reuse, serial confirmation and 403 stops playback')
}

void main().then(() => 0, (error: unknown) => { console.error(error); return 1 }).then(async (status) => {
  await disposeAllPanels()
  for (const server of [oa, site]) server.close()
  app.exit(status)
})
