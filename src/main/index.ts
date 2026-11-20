import { BrowserWindow, Menu, app, clipboard, ipcMain, powerMonitor, screen } from 'electron'
import { join } from 'node:path'
import { disposeAllPanels, registerService, registerToolIpc, setMainWindow } from './ipc'
import { tftpService } from './services/tftp'
import { PluginService } from './services/plugins'
import { serialService } from './services/serial'
import { sshService } from './services/ssh'
import { quickCmdsService } from './services/quickcmds'
import { netService } from './services/net'
import { diffService } from './services/diff'
import { codecService } from './services/codec'
import { bridgeService } from './services/bridge'
import { settingsService } from './services/settings'
import { localTerminalService } from './services/localTerminal'

let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/** 无边框窗口：自绘标题栏需要的窗口控制与版本信息 */
function registerWindowIpc(): void {
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())
  ipcMain.handle('win:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))
  // 终端复制粘贴：选中复制 / 右键粘贴（渲染端 clipboard API 受限，走主进程）
  ipcMain.handle('win:clipboard-read', () => clipboard.readText())
  ipcMain.handle('win:clipboard-write', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'DevKit 嵌入式开发套件',
    backgroundColor: '#141414',
    show: false,
    frame: false, // VS Code 风格：无边框，标题栏由渲染端自绘
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 最大化状态推给渲染端，用于切换 最大化/还原 按钮图标
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('win:maximized', true)
    if (process.platform === 'win32') {
      const b = mainWindow!.getBounds()
      const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      const wa = screen.getDisplayNearestPoint(center).workArea
      mainWindow?.setBounds(wa)
    }
  })
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized', false))

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'bottom' })
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setMainWindow(mainWindow)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  registerService('tftp', tftpService)
  registerService('serial', serialService)
  registerService('ssh', sshService)
  registerService('local-terminal', localTerminalService)
  registerService('net', netService)
  registerService('plugins', new PluginService({
    serial: serialService.pluginBridge,
    ssh: sshService.pluginBridge,
    net: netService.pluginBridge
  }))
  serialService.startLogRetention()
  registerService('quickcmds', quickCmdsService)
  registerService('codec', codecService)
  registerService('diff', diffService)
  registerService('bridge', bridgeService)
  registerService('settings', settingsService)

  // Windows 专属服务按平台条件加载，避免 macOS / Linux 启动时触发 Windows API 依赖
  if (process.platform === 'win32') {
    const [{ inputService, fullSelfTest }, { macroService }, { colorService }] = await Promise.all([
      import('./services/input'),
      import('./services/macro'),
      import('./services/color')
    ])
    registerService('input', inputService)
    registerService('macro', macroService)
    registerService('color', colorService)
    void macroService.init()
    console.log('[devkit] input selftest:', JSON.stringify(fullSelfTest()))
  }

  registerToolIpc()
  registerWindowIpc()

  // 休眠/唤醒：串口链路在长休眠后会失步，主进程记录系统休眠区间；唤醒后不丢弃已接收字节
  powerMonitor.on('suspend', () => serialService.onSystemSuspend())
  powerMonitor.on('resume', () => serialService.onSystemResume())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shutdownComplete = false
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  void disposeAllPanels().finally(() => { shutdownComplete = true; app.quit() })
})
