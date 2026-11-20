/** UI fixes probe (diagnostic; not part of npm test).
 *  #1 首页不再两侧大面积留白（工具卡按容器自适应分栏）
 *  #2 标签页显示端口备注：「黑色串口板子 (COM1)」
 *  #4 会话栏折叠把手位于分割线上，折叠后留 16px 细条
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialPort } from 'serialport'
import { serialService } from '../../src/main/services/serial'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'

const dir = mkdtempSync(join(tmpdir(), 'devkit-ui-probe-'))
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
    sessions: [{ name: '黑色串口板子', params: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' } }]
  })
  registerService('serial', serialService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'ui-probe' }))
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

    // ---- #1 首页：工具卡实际占用的左右边界 vs 窗口 ----
    console.log('home:', JSON.stringify(await js(`(() => {
      const box = document.querySelector('.toolbox')
      const rows = [...document.querySelectorAll('.tool-row')]
      const list = document.querySelector('.tool-lists')
      const b = box.getBoundingClientRect()
      return {
        viewport: window.innerWidth,
        toolbox: [Math.round(b.left), Math.round(window.innerWidth - b.right)],
        rowNames: rows.map(r => r.querySelector('strong')?.textContent),
        groups: [...document.querySelectorAll('.toolbox .group-head')].map(h => h.querySelector('h2')?.textContent),
        cardWidths: [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().width)))],
        rowGrid: list ? getComputedStyle(list).gridTemplateColumns.split(' ').length : 0,
        rowWidth: Math.round(rows[0]?.getBoundingClientRect().width ?? 0)
      }
    })()`)))

    // 打开串口助手
    await js(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === '串口助手');
      if (el) el.click(); return !!el;
    })()`)
    for (let i = 0; i < 60; i++) {
      if (await js<boolean>(`!!document.querySelector('.serial-panel')`)) break
      await delay(100)
    }
    await delay(700)

    // ---- #2 标签页标题应带备注 ----
    console.log('tab:', JSON.stringify(await js(`(() => {
      const tabs = [...document.querySelectorAll('.tab-bar .tab-title')].map(t => t.textContent.trim())
      return { tabs, h1: document.querySelector('.serial-panel h1')?.textContent }
    })()`)))

    // ---- #4 折叠把手位置 ----
    // 重新载入端口的路径：切走再切回（refreshPorts 会按配置重算标题）
    console.log('after reopen:', JSON.stringify(await js(`(() => ({
      tabs: [...document.querySelectorAll('.tab-bar .tab-title')].map(t => t.textContent.trim())
    }))()`)))

    console.log('sidebar:', JSON.stringify(await js(`(() => {
      const split = document.querySelector('.serial-panel .sidebar-split')
      const toggle = split?.querySelector('.split-toggle')
      const sessions = document.querySelector('.serial-panel .sessions')
      const r = split?.getBoundingClientRect(), t = toggle?.getBoundingClientRect()
      return {
        split: r ? [Math.round(r.left), Math.round(r.width), Math.round(r.height)] : null,
        toggle: t ? [Math.round(t.left), Math.round(t.width), Math.round(t.height)] : null,
        toggleCenteredOnSplit: r && t ? Math.abs((t.left + t.width / 2) - (r.left + r.width / 2)) < 2 : null,
        sessionsRight: sessions ? Math.round(sessions.getBoundingClientRect().right) : null
      }
    })()`)))
    await js(`document.querySelector('.serial-panel .split-toggle')?.click(); true`)
    await delay(400)
    console.log('collapsed:', JSON.stringify(await js(`(() => {
      const strip = document.querySelector('.serial-panel .sidebar-collapsed')
      const h1 = document.querySelector('.serial-panel h1')?.textContent
      return {
        strip: strip ? Math.round(strip.getBoundingClientRect().width) : null,
        sessionsGone: !document.querySelector('.serial-panel .sessions'),
        activeElement: document.activeElement?.className,
        h1
      }
    })()`)))
    await js(`document.querySelector('.serial-panel .sidebar-collapsed')?.click(); true`)
    await delay(400)
    console.log('expanded again:', JSON.stringify(await js(`(() => ({
      sessions: !!document.querySelector('.serial-panel .sessions'),
      toggle: !!document.querySelector('.serial-panel .split-toggle')
    }))()`)))
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })