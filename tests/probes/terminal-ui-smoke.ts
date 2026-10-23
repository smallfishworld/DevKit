/** Cross-platform manual terminal UI probe; uses actual renderer, IPC, settings and SSH service.
 * npm run build
 * npx esbuild tests/probes/terminal-ui-smoke.ts --bundle --platform=node --packages=external --outfile=tests/.terminal-ui-smoke.cjs
 * npx electron tests/.terminal-ui-smoke.cjs
 * Open SSH and connect to the prefilled loopback fixture. Type flood + Enter for 120k lines.
 * All config/logs are isolated in a temporary userData directory. No Win32 input service is loaded.
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { Server } from 'ssh2'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { sshService } from '../../src/main/services/ssh'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'
import { DEFAULT_SSH_CONFIG, DEFAULT_SSH_PARAMS } from '../../src/shared/ssh'

const dir = mkdtempSync(join(tmpdir(), 'devkit-terminal-ui-'))
app.setPath('userData', dir)
console.log('Terminal smoke data:', dir)
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})
const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (acceptPty) => acceptPty?.())
    session.on('window-change', (acceptResize) => acceptResize?.())
    session.on('shell', (acceptShell) => {
      const stream = acceptShell()
      stream.write('DevKit terminal smoke: type flood to print 120000 lines.\r\n$ ')
      let input = ''
      let line = 0
      let flooding = false
      const pump = (): void => {
        if (stream.destroyed) return
        let chunk = ''
        for (let i = 0; i < 512 && line < 120_000; i++, line++) {
          chunk += `ROW-${line} 中文 \x1b[32mPASS\x1b[0m ${line === 50_000 ? 'NEEDLE-50000' : '0123456789'.repeat(4)}\r\n`
        }
        const ready = stream.write(chunk)
        if (line >= 120_000) { flooding = false; stream.write('FLOOD-DONE\r\n$ '); return }
        if (ready) setImmediate(pump); else stream.once('drain', pump)
      }
      stream.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        stream.write(text.replace(/\r/g, '\r\n'))
        input += text
        if (input.includes('\r')) {
          if (input.trim() === 'flood' && !flooding) { line = 0; flooding = true; setImmediate(pump) }
          else stream.write('$ ')
          input = ''
        }
      })
    })
  }))
})

void app.whenReady().then(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await setSection('ssh', { ...DEFAULT_SSH_CONFIG, last: { ...DEFAULT_SSH_PARAMS, host: '127.0.0.1', port: address.port, username: 'smoke', password: 'smoke' } })
  registerService('ssh', sshService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  const window = new BrowserWindow({ width: 1280, height: 900, title: 'DevKit Terminal Smoke', webPreferences: {
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
  void disposeAllPanels().finally(() => { server.close(); complete = true; app.quit() })
})
