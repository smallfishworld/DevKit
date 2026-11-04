/** Isolated real-renderer serial fixture. Build with esbuild alias serialport=tests/terminal-serial-mock.js.
 * Connect COM-SMOKE, scroll up, switch tabs, then type sleep + Enter to simulate wake after a minimized burst.
 * This exercises application recovery; it does not suspend the OS or exercise a USB driver.
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SerialPort } from 'serialport'
import { serialService } from '../../src/main/services/serial'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'

const dir = mkdtempSync(join(tmpdir(), 'devkit-terminal-ui-'))
app.setPath('userData', dir)
console.log('Terminal smoke data:', dir)
let window: BrowserWindow
let input = ''
let row = 0
const simulatedPort = SerialPort as unknown as { ports: Array<{ emit: (event: string, data: Buffer) => void }> ; list: () => Promise<unknown[]>; prototype: { write: (data: Buffer, done?: (error?: Error) => void) => void } }
simulatedPort.list = async () => [{ path: 'COM-SMOKE', friendlyName: 'Isolated serial fixture' }]
simulatedPort.prototype.write = function (data, done) {
  input += data.toString()
  done?.()
  if (!input.includes('\r')) return
  if (input.trim() === 'sleep') {
    serialService.onSystemSuspend()
    window.minimize()
    setTimeout(() => {
      const clock = Date.now
      Date.now = () => clock() + 60_000
      serialService.onSystemResume()
      Date.now = clock
      let batch = 0
      const pump = setInterval(() => {
        const text = Array.from({ length: 128 }, () => `WAKE-${row++} 中文 \x1b[32mPASS\x1b[0m\r\n`).join('')
        simulatedPort.ports.at(-1)?.emit('data', Buffer.from(text))
        if (++batch === 80) { clearInterval(pump); window.show() }
      }, 10)
    }, 2000)
  }
  input = ''
}
const ticker = setInterval(() => {
  simulatedPort.ports.at(-1)?.emit('data', Buffer.from(`LIVE-${row++} 中文 \x1b[32mPASS\x1b[0m ${row % 8 === 0 ? 'NEEDLE-SMOKE' : ''}\r\n`))
}, 32)

void app.whenReady().then(async () => {
  await setSection('serial', { ...DEFAULT_SERIAL_CONFIG, last: { ...DEFAULT_SERIAL_PARAMS, path: 'COM-SMOKE' } })
  registerService('serial', serialService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  window = new BrowserWindow({ width: 1280, height: 900, title: 'DevKit Terminal Smoke', webPreferences: {
    preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  setMainWindow(window)
  ipcMain.handle('win:info', () => ({ version: 'terminal-smoke', electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }))
  ipcMain.handle('win:clipboard-read', () => clipboard.readText())
  ipcMain.handle('win:clipboard-write', (_e, text) => { clipboard.writeText(text); return true })
  ipcMain.on('win:minimize', () => window.minimize())
  ipcMain.on('win:toggle-maximize', () => window.isMaximized() ? window.unmaximize() : window.maximize())
  ipcMain.on('win:close', () => window.close())
  window.on('closed', () => { setMainWindow(null); app.quit() })
  await window.loadFile(join(process.cwd(), 'out/renderer/index.html'))
})
let complete = false
let closing = false
app.on('before-quit', (event) => {
  if (complete) return
  event.preventDefault()
  if (closing) return
  closing = true
  void disposeAllPanels().finally(() => { clearInterval(ticker); complete = true; app.quit() })
})
