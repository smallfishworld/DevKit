import { BrowserWindow, Menu, app, clipboard, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { disposeAllPanels, registerService, registerToolIpc, setMainWindow } from './ipc'
import { inputService, fullSelfTest } from './services/input'
import { tftpService } from './services/tftp'
import { macroService } from './services/macro'
import { serialService } from './services/serial'
import { sshService } from './services/ssh'
import { quickCmdsService } from './services/quickcmds'
import { netService } from './services/net'
import { colorService } from './services/color'
import { diffService } from './services/diff'
import { codecService } from './services/codec'

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
    node: process.versions.node
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
    // 无边框窗口最大化时，Windows 可能把窗口铺到任务栏之上导致底部被遮挡；
    // 显式把窗口限制到当前所在显示器的工作区（不含任务栏）边界。
    // 用窗口中心点定位显示器，避免 getBounds 在最大化瞬间返回旧值而选错屏。
    const b = mainWindow!.getBounds()
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    const wa = screen.getDisplayNearestPoint(center).workArea
    mainWindow?.setBounds(wa)
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  registerService('input', inputService)
  registerService('tftp', tftpService)
  registerService('macro', macroService)
  registerService('serial', serialService)
  registerService('ssh', sshService)
  registerService('quickcmds', quickCmdsService)
  registerService('net', netService)
  registerService('color', colorService)
  registerService('codec', codecService)
  registerService('diff', diffService)
  void macroService.init()
  registerToolIpc()
  registerWindowIpc()

  // 原生模块自检：结果同时打到 dev 控制台与面板
  console.log('[devkit] input selftest:', JSON.stringify(fullSelfTest()))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  disposeAllPanels()
})
