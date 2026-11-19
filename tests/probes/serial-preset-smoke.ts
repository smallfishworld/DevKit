/** 连接参数预设探针（诊断用，不在 npm test 内）
 *  验证「已存会话」收进连接参数浮层后：侧栏不再有会话块、预设可套用、可保存、可删除，
 *  并且套用预设不会自动连接；顺带截一张浮层展开的图。
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const dir = mkdtempSync(join(tmpdir(), 'devkit-preset-probe-'))
app.setPath('userData', dir)

const simulated = SerialPort as unknown as {
  list: () => Promise<unknown[]>
  prototype: { write: (data: Buffer, done?: (error?: Error) => void) => void }
}
simulated.list = async () => [{ path: 'COM1', friendlyName: 'probe' }, { path: 'COM2', friendlyName: 'probe2' }]
simulated.prototype.write = (_data, done) => { done?.() }

void app.whenReady().then(async () => {
  await setSection('serial', {
    ...DEFAULT_SERIAL_CONFIG,
    last: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1' },
    portLabels: { COM1: '黑色串口板子' },
    sessions: [
      { name: '调试口', params: { ...DEFAULT_SERIAL_PARAMS, path: 'COM2', baudRate: 921600 } },
      { name: '烧录口', params: { ...DEFAULT_SERIAL_PARAMS, path: 'COM1', baudRate: 115200 } }
    ]
  })
  registerService('serial', serialService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'preset-probe' }))
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
    await js(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === '串口助手');
      if (el) el.click(); return !!el;
    })()`)
    for (let i = 0; i < 60; i++) {
      if (await js<boolean>(`!!document.querySelector('.serial-panel')`)) break
      await delay(100)
    }
    await delay(900)

    // ---- 侧栏不再有「已存会话」块 ----
    console.log('sidebar:', JSON.stringify(await js(`(() => {
      const side = document.querySelector('.serial-panel .sessions')
      return {
        hasSessionList: !!document.querySelector('.serial-panel .session-item'),
        hasSessionHead: !!document.querySelector('.serial-panel .sessions-head'),
        sideText: side?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60),
        hasQuickCmds: !!side?.querySelector('.cmd-head')
      }
    })()`)))

    // ---- 打开连接参数浮层：应看到「已存预设」行 ----
    console.log('open popover:', await js(`(() => {
      const btn = document.querySelector('.serial-panel .conn-bar button[aria-label="连接参数"]')
      if (!btn) return 'no button'
      btn.click(); return 'clicked'
    })()`))
    await delay(600)
    console.log('popover:', JSON.stringify(await js(`(() => {
      const sec = [...document.querySelectorAll('.connection-editor')].find(e => e.getBoundingClientRect().height > 0)
      if (!sec) return { missing: true, poppers: document.querySelectorAll('.connection-editor').length }
      const labels = [...sec.querySelectorAll('.conn-field > span')].map(s => s.textContent)
      const presetSelect = sec.querySelector('.conn-preset-field .el-select')
      return {
        fields: labels,
        hasPresetField: !!presetSelect,
        presetPlaceholder: (presetSelect?.querySelector('.el-select__placeholder')?.textContent
          ?? presetSelect?.querySelector('input')?.getAttribute('placeholder'))?.trim(),
        presetColumn: getComputedStyle(sec.querySelector('.conn-preset-field')).gridColumn,
        buttons: [...sec.querySelectorAll('.conn-preset-field button')].map(b => b.getAttribute('title'))
      }
    })()`)))

    // 初次打开的浮层（未交互）单独截一张
    writeFileSync(join(process.cwd(), 'tests/.preset-popover.png'),
      (await win.webContents.capturePage({ x: 0, y: 80, width: 760, height: 520 })).toPNG())

    // ---- 保存新预设：在「保存为预设」输入框里写名字后点 + ----
    console.log('save:', JSON.stringify(await js(`(async () => {
      const sec = [...document.querySelectorAll('.connection-editor')].find(e => e.getBoundingClientRect().height > 0)
      const nameInput = sec.querySelector('.conn-save-as-field input')
      const placeholder = nameInput?.getAttribute('placeholder')
      nameInput.value = '新预设'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 150))
      const saveBtn = [...sec.querySelectorAll('.conn-save-as-field button')].find(b => b.getAttribute('title')?.includes('保存'))
      saveBtn?.click()
      await new Promise(r => setTimeout(r, 800))
      const cfg = await window.api.invoke('serial', 'config:get', 'x')
      return { placeholder, inputCleared: nameInput.value === '',
               sessions: cfg.sessions.map(s => [s.name, s.params.path, s.params.baudRate]),
               labels: cfg.portLabels,
               delDisabled: [...sec.querySelectorAll('.conn-preset-field button')].find(b => b.getAttribute('title')?.includes('删除'))?.disabled }
    })()`)))

    // ---- 套用预设：选「调试口」→ 草稿变成 COM2 @ 921600，且不自动连接 ----
    console.log('apply:', JSON.stringify(await js(`(async () => {
      const sec = [...document.querySelectorAll('.connection-editor')].find(e => e.getBoundingClientRect().height > 0)
      sec.querySelector('.conn-preset-field .el-select__wrapper')?.click()
      await new Promise(r => setTimeout(r, 300))
      const opts = [...document.querySelectorAll('.el-select-dropdown__item')].filter(o => o.offsetParent)
      const opt = opts.find(o => o.textContent?.includes('调试口'))
      opt?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 400))
      const fieldText = (label) => [...sec.querySelectorAll('.conn-field')]
        .find(f => f.querySelector('span')?.textContent === label)?.querySelector('.el-select')?.textContent?.trim()
      return {
        optionCount: opts.length,
        clicked: !!opt,
        portShows: fieldText('串口')?.slice(0, 20),
        baudShows: fieldText('波特率')?.slice(0, 10),
        remark: sec.querySelectorAll('.conn-field input')[1]?.value,
        status: document.querySelector('.serial-panel .port-status')?.textContent?.trim()
      }
    })()`)))


    // ---- 删除预设：确认框 → 从配置里消失 ----
    console.log('delete:', JSON.stringify(await js(`(async () => {
      const sec = [...document.querySelectorAll('.connection-editor')].find(e => e.getBoundingClientRect().height > 0)
      const delBtn = [...sec.querySelectorAll('.conn-preset-field button')].find(b => b.getAttribute('title')?.includes('删除'))
      const disabled = delBtn?.disabled
      delBtn?.click()
      await new Promise(r => setTimeout(r, 600))
      const armedText = delBtn?.textContent?.trim()
      const second = [...sec.querySelectorAll('.conn-preset-field button')].find(b => b.getAttribute('title')?.includes('确认'))
      second?.click()
      await new Promise(r => setTimeout(r, 900))
      const cfg = await window.api.invoke('serial', 'config:get', 'x')
      const stillOpen = [...document.querySelectorAll('.connection-editor')].some(e => e.getBoundingClientRect().height > 0)
      return { disabled, armedText, sessions: cfg.sessions.map(s => s.name), popoverStillOpen: stillOpen }
    })()`)))
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })
