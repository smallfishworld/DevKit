/** 第三轮 UI 诊断探针（不在 npm test 内）
 *  1) 首页工具卡片：各组卡片宽度/高度是否一致
 *  2) 串口/SSH 侧栏：快捷命令列表实际占了多高、底部空白有多少
 *  3) 标题栏：DevKit 图标、标签、右侧按钮的垂直中心是否对齐
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

const dir = mkdtempSync(join(tmpdir(), 'devkit-round3-probe-'))
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
    // 服务端读取的是 { list, groups }（旧字段 cmds 会被忽略，落到默认两条）
    list: [
      { name: '复位(Atlas)', steps: [{ type: 'cmd', text: 'reset', mode: 'ascii', crlf: true }] },
      { name: '查询版本', steps: [{ type: 'cmd', text: 'version', mode: 'ascii', crlf: true }] },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `压测命令 ${i + 1}`, steps: [{ type: 'cmd', text: `cmd${i + 1}`, mode: 'ascii', crlf: true }] }))
    ]
  })
  registerService('serial', serialService)
  registerService('ssh', sshService)
  registerService('local-terminal', localTerminalService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'round3-probe' }))
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
  const capture = async (name: string, rect?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    writeFileSync(join(process.cwd(), `tests/.${name}.png`), (await win.webContents.capturePage(rect)).toPNG())
  }

  try {
    await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await delay(900)

    // ---------- 1) 首页卡片 ----------
    console.log('HOME:', JSON.stringify(await js(`(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left) } }
      const lists = document.querySelector('.tool-lists')
      return { cols: lists ? getComputedStyle(lists).gridTemplateColumns : null,
               cards: [...document.querySelectorAll('.toolbox .tool-row')].map(box),
               heads: [...document.querySelectorAll('.toolbox .group-head')].map(box) }
    })()`)))
    console.log('HOME SCROLL:', JSON.stringify(await js(`(() => {
      const el = document.querySelector('.app-body')
      return { bodyH: Math.round(el.getBoundingClientRect().height), scrollH: el.scrollHeight }
    })()`)))
    console.log('HOME ALIGN:', JSON.stringify(await js(`(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), h: +b.height.toFixed(1), mid: +(b.top + b.height / 2).toFixed(1) } }
      return [...document.querySelectorAll('.toolbox .tool-row')].slice(0, 3).map(row => ({
        card: r(row), icon: r(row.querySelector('.tool-icon')), iconSvg: r(row.querySelector('.tool-icon svg')),
        name: r(row.querySelector('.tool-name')), desc: r(row.querySelector('.tool-desc'))
      }))
    })()`)))
    await capture('r3-home')
    await capture('r3-home-cards', { x: 0, y: 120, width: 1440, height: 700 })

    // ---------- 3) 标题栏垂直对齐 ----------
    console.log('HEADER:', JSON.stringify(await js(`(() => {
      const mid = (sel) => { const el = document.querySelector(sel); if (!el) return null
        const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), mid: +(b.top + b.height / 2).toFixed(1) } }
      return { header: mid('.app-header'), logoIcon: mid('.app-logo .el-icon'), logoText: mid('.app-logo span'),
               tabBar: mid('.tab-bar'), tabIcon: mid('.tab-item .el-icon'), tab: mid('.tab-item'),
               actionIcon: mid('.header-action .el-icon'), winIcon: mid('.win-btn .el-icon') }
    })()`)))
    await capture('r3-header', { x: 0, y: 0, width: 1440, height: 90 })

    // ---------- 2) 侧栏高度 ----------
    await openTool('串口助手', '.serial-panel')
    console.log('SERIAL SIDEBAR:', JSON.stringify(await js(`(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null
        const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
      return { side: box('.serial-panel .sessions'), quickCmd: box('.serial-panel .quick-cmd'),
               list: box('.serial-panel .cmd-list'), tail: box('.serial-panel .cmd-tail'),
               lastItem: box('.serial-panel .cmd-item:last-of-type') }
    })()`)))
    console.log('SIDEBAR ALIGN:', JSON.stringify(await js(`(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), h: +b.height.toFixed(1), mid: +(b.top + b.height / 2).toFixed(1) } }
      const head = document.querySelector('.serial-panel .cmd-head')
      const opts = document.querySelector('.serial-panel .term-opts')
      return { head: r(head), headText: r(head?.querySelector('span')), headBtn: r(head?.querySelector('.el-button')),
               opts: r(opts), optsBtn: r(opts?.querySelector('.el-button')), optsBtnText: r(opts?.querySelector('.el-button span')),
               optsIcon: r(opts?.querySelector('.el-button .el-icon')) }
    })()`)))
    await capture('r3-serial')

    await openTool('SSH 终端', '.ssh-panel')
    console.log('SSH SIDEBAR:', JSON.stringify(await js(`(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null
        const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) } }
      return { side: box('.ssh-panel .sessions'), quickCmd: box('.ssh-panel .quick-cmd'),
               list: box('.ssh-panel .cmd-list'), tail: box('.ssh-panel .cmd-tail') }
    })()`)))
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
