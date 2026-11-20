/** 串口页顶部布局量测 + 截图（诊断用，不在 npm test 内）
 *  量标签栏 / 连接栏 / 会话栏 / 终端操作栏 / 发送栏 / 状态栏的实际高度与内边距，
 *  并截一张图到 tests/.serial-layout.png，用于人工核对疏密。
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialPort } from 'serialport'
import { serialService } from '../../src/main/services/serial'
import { sshService } from '../../src/main/services/ssh'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'

const dir = mkdtempSync(join(tmpdir(), 'devkit-layout-probe-'))
app.setPath('userData', dir)

const simulated = SerialPort as unknown as {
  list: () => Promise<unknown[]>
  prototype: { write: (data: Buffer, done?: (error?: Error) => void) => void }
}
simulated.list = async () => [{ path: 'COM1', friendlyName: 'probe' }]
simulated.prototype.write = (_data, done) => { done?.() }

void app.whenReady().then(async () => {
  await setSection('serial', {
    ...DEFAULT_SERIAL_CONFIG,
    last: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' },
    portLabels: { COM1: '黑色串口板子' },
    sessions: [{ name: '黑色串口板子', params: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' } }]
  })
  registerService('serial', serialService)
  registerService('ssh', sshService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'layout-probe' }))
  ipcMain.handle('win:clipboard-read', () => clipboard.readText())
  ipcMain.handle('win:clipboard-write', (_e, text) => { clipboard.writeText(text); return true })
  ipcMain.on('win:minimize', () => {})
  ipcMain.on('win:toggle-maximize', () => {})
  ipcMain.on('win:close', () => {})

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: { preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false }
  })
  setMainWindow(win)
  const js = <T>(source: string): Promise<T> => win.webContents.executeJavaScript(source)
  try {
    await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await delay(800)
    writeFileSync(join(process.cwd(), 'tests/.home-layout.png'), (await win.webContents.capturePage()).toPNG())
    console.log('HOME:', JSON.stringify(await js(`(() => {
      // 全部分类共用一个栅格：列宽在 .tool-lists 上，分类标题横跨整行
      const list = document.querySelector('.tool-lists')
      const cards = [...document.querySelectorAll('.toolbox .tool-row')].map(c => {
        const r = c.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      })
      return { viewport: window.innerWidth,
               cols: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0,
               cardWidths: [...new Set(cards.map(c => c.w))], cardHeights: [...new Set(cards.map(c => c.h))],
               groups: [...document.querySelectorAll('.toolbox .group-head')].map(h => h.querySelector('h2')?.textContent),
               rows: cards.length,
               scrollHeight: document.querySelector('.tab-page.active, .tab-page')?.scrollHeight }
    })()`)))
    await js(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === '串口助手');
      if (el) el.click(); return !!el;
    })()`)
    for (let i = 0; i < 60; i++) {
      if (await js<boolean>(`!!document.querySelector('.serial-panel')`)) break
      await delay(100)
    }
    await delay(1000)

    const metrics = await js(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return {
          h: Math.round(r.height), w: Math.round(r.width),
          top: Math.round(r.top),
          pad: s.padding, gap: s.gap,
          mt: s.marginTop, mb: s.marginBottom,
          font: s.fontSize
        }
      }
      const pick = (sel) => document.querySelector(sel)
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } }
      return {
        header: box('.app-header'),
        tabBar: box('.tab-bar'),
        tabItem: rect(pick('.tab-item')),
        connBar: box('.serial-panel .conn-bar'),
        h1: box('.serial-panel .conn-bar h1'),
        connBtn: rect(pick('.serial-panel .conn-bar .el-button')),
        body: box('.serial-panel .body'),
        sessions: box('.serial-panel .sessions'),
        cmdHead: box('.serial-panel .cmd-head'),
        firstCmd: rect(pick('.serial-panel .cmd-item')),
        termOpts: box('.serial-panel .term-opts'),
        termOptBtn: rect(pick('.serial-panel .term-opts .el-button')),
        sendBar: box('.serial-panel .send-bar'),
        status: box('.serial-panel .serial-status'),
        winControls: rect(pick('.win-controls')),
        headerActions: [...document.querySelectorAll('.app-header .header-action')].map(e => rect(e)),
        term: rect(pick('.serial-panel .term')),
        searchBtnText: pick('.serial-panel .term-opts .el-button')?.textContent?.trim()
      }
    })()`)
    console.log('METRICS:', JSON.stringify(metrics, null, 1))

    const png = await win.webContents.capturePage()
    writeFileSync(join(process.cwd(), 'tests/.serial-layout.png'), png.toPNG())
    console.log('shot: tests/.serial-layout.png')
    // 顶部条状区域另存一份放大版（只看标签栏 + 连接栏 + 操作栏）
    const top = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 240 })
    writeFileSync(join(process.cwd(), 'tests/.serial-layout-top.png'), top.toPNG())

    // ---- SSH 终端：同样的顶部结构与间距，顺便量一下 ----
    await js(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === 'SSH 终端');
      if (el) el.click(); return !!el;
    })()`)
    for (let i = 0; i < 60; i++) {
      if (await js<boolean>(`!!document.querySelector('.ssh-panel')`)) break
      await delay(100)
    }
    await delay(600)
    console.log('SSH METRICS:', JSON.stringify(await js(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return { h: Math.round(r.height), pad: s.padding, gap: s.gap }
      }
      return {
        connBar: box('.ssh-panel > .panel-section'),
        sessions: box('.ssh-panel .sessions'),
        cmdHead: box('.ssh-panel .cmd-head'),
        termOpts: box('.ssh-panel .term-opts'),
        term: box('.ssh-panel .term')
      }
    })()`)))
    // 窄窗口：确认加宽后的栏位会换行而不是挤压/溢出
    win.setSize(980, 760)
    await delay(900)
    console.log('NARROW:', JSON.stringify(await js(`(() => {
      const q = (sel) => { const el = document.querySelector(sel); if (!el) return null
        const r = el.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right) } }
      return {
        viewport: window.innerWidth,
        connBar: q('.serial-panel .conn-bar'),
        termOpts: q('.ssh-panel .term-opts'),
        sendBar: q('.serial-panel .send-bar'),
        overflowX: document.documentElement.scrollWidth > window.innerWidth
      }
    })()`)))
    writeFileSync(join(process.cwd(), 'tests/.narrow-layout.png'), (await win.webContents.capturePage()).toPNG())
    const sshPng = await win.webContents.capturePage()
    writeFileSync(join(process.cwd(), 'tests/.ssh-layout.png'), sshPng.toPNG())
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
