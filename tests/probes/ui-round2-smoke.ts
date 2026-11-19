/** 第二轮 UI 诊断探针（不在 npm test 内）
 *  1) 串口/SSH 侧栏「快捷命令」标题上方的空白与多余分隔线量测
 *  2) 本地终端：快捷命令栏、顶部配置栏、终端操作条的实际位置关系
 *  3) 外观浮层：当前布局截图
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialPort } from 'serialport'
import { serialService } from '../../src/main/services/serial'
import { sshService } from '../../src/main/services/ssh'
import { localTerminalService } from '../../src/main/services/localTerminal'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'

const dir = mkdtempSync(join(tmpdir(), 'devkit-round2-probe-'))
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
    portLabels: { COM1: '黑色串口板子' }
  })
  await setSection('quickCmds', {
    cmds: [
      { name: '复位(Atlas)', steps: [{ type: 'cmd', text: 'reset', mode: 'ascii', crlf: true }] },
      { name: '查询版本', steps: [{ type: 'cmd', text: 'version', mode: 'ascii', crlf: true }] }
    ]
  })
  registerService('serial', serialService)
  registerService('ssh', sshService)
  registerService('local-terminal', localTerminalService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'round2-probe' }))
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
  const openTool = async (label: string, selector: string): Promise<void> => {
    await js(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === ${JSON.stringify(label)});
      if (el) el.click(); return !!el;
    })()`)
    for (let i = 0; i < 80; i++) {
      if (await js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) break
      await delay(100)
    }
    await delay(700)
  }

  try {
    await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await delay(900)
    writeFileSync(join(process.cwd(), 'tests/.r2-home.png'), (await win.webContents.capturePage()).toPNG())

    // ---------- 1) 串口侧栏 ----------
    await openTool('串口助手', '.serial-panel')
    console.log('SERIAL SIDEBAR:', JSON.stringify(await js(`(() => {
      const side = document.querySelector('.serial-panel .sessions')
      const head = side?.querySelector('.cmd-head')
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const s = getComputedStyle(el)
        return { top: Math.round(b.top), h: Math.round(b.height), mt: s.marginTop, pt: s.paddingTop, bt: s.borderTopWidth } }
      return { side: r(side), sidePad: side ? getComputedStyle(side).padding : null, head: r(head),
               firstItem: r(side?.querySelector('.cmd-item')) }
    })()`)))
    writeFileSync(join(process.cwd(), 'tests/.r2-serial.png'), (await win.webContents.capturePage()).toPNG())
    writeFileSync(join(process.cwd(), 'tests/.r2-sidebar.png'),
      (await win.webContents.capturePage({ x: 0, y: 80, width: 420, height: 420 })).toPNG())

    // ---------- 2) 本地终端 ----------
    await openTool('本地终端', '.local-terminal-panel')
    await delay(1200)
    console.log('LOCAL TERM:', JSON.stringify(await js(`(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null
        const b = el.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) } }
      return {
        toolbar: box('.local-terminal-panel .terminal-toolbar'),
        quickCol: box('.local-terminal-panel .quick-cmd-col'),
        cmdHead: box('.local-terminal-panel .cmd-head'),
        opts: box('.local-terminal-panel .local-term-opts'),
        term: box('.local-terminal-panel .term'),
        toolbarText: document.querySelector('.local-terminal-panel .terminal-toolbar')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120)
      }
    })()`)))
    writeFileSync(join(process.cwd(), 'tests/.r2-local-term.png'), (await win.webContents.capturePage()).toPNG())

    // ---------- 3) 外观浮层 ----------
    await js(`(() => {
      const btn = [...document.querySelectorAll('.app-header .header-action')].find(b => b.textContent?.includes('外观'))
      btn?.click(); return !!btn
    })()`)
    await delay(600)
    console.log('APPEARANCE:', JSON.stringify(await js(`(() => {
      const pop = [...document.querySelectorAll('.appearance-popper')].find(e => e.getBoundingClientRect().height > 0)
      if (!pop) return { missing: true }
      const r = pop.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height),
               presets: pop.querySelectorAll('.skin-presets button').length,
               hasDetails: !!pop.querySelector('details'),
               summary: pop.querySelector('summary')?.textContent,
               text: pop.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) }
    })()`)))
    writeFileSync(join(process.cwd(), 'tests/.r2-appearance.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
