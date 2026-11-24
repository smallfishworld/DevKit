import { BrowserWindow, ipcMain, screen } from 'electron'
import type { TabWindowCommand, WorkbenchVisibility } from '../shared/types'
import { applyWindowsAppDetails, getWindowIconPath } from './branding'
import { setHasDetachedTabs } from './ipc'

/** Same-origin blank windows can display the workbench's existing panel DOM. */
export function registerTabWindows(owner: BrowserWindow, quitting: () => boolean): void {
  const windows = new Map<string, BrowserWindow>()
  const contents = owner.webContents
  let ownerClosed = false
  const publishVisibility = (visibility: WorkbenchVisibility) => contents.send('win:workbench-visibility', visibility)

  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== 'about:blank' || !/^devkit-tab-\d+$/.test(frameName) ||
      windows.has(frameName)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1080,
        height: 720,
        minWidth: 680,
        minHeight: 420,
        frame: false,
        show: false,
        backgroundColor: '#141414',
        icon: getWindowIconPath(),
        webPreferences: { sandbox: false }
      }
    }
  })

  contents.on('did-create-window', (win, { frameName }) => {
    applyWindowsAppDetails(win)
    windows.set(frameName, win)
    setHasDetachedTabs(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.once('closed', () => {
      windows.delete(frameName)
      setHasDetachedTabs(windows.size > 0)
      if (contents.isDestroyed()) return
      contents.send('win:tab-window-closed', frameName, windows.size === 0 && ownerClosed && !quitting())
    })
  })

  owner.on('close', (event) => {
    if (!windows.size || quitting()) return
    event.preventDefault()
    ownerClosed = true
    owner.hide()
    publishVisibility('closed')
  })
  owner.on('show', () => {
    ownerClosed = false
    publishVisibility('shown')
  })
  owner.on('minimize', () => publishVisibility('minimized'))
  owner.on('restore', () => publishVisibility('shown'))

  const control: Parameters<typeof ipcMain.on>[1] = (event, name: string, command: TabWindowCommand) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !command) return
    const win = windows.get(name)
    if (!win || win.isDestroyed()) return
    switch (command.action) {
      case 'move': {
        if (!Number.isFinite(command.offsetX) || !Number.isFinite(command.offsetY)) return
        if (win.isMaximized()) win.unmaximize()
        const cursor = screen.getCursorScreenPoint()
        const bounds = win.getBounds()
        const { x, y, width, height } = screen.getDisplayNearestPoint(cursor).workArea
        // Keep a portion of the title bar reachable at screen edges.
        const left = Math.round(Math.min(x + width - 72, Math.max(x + 72 - bounds.width, cursor.x - command.offsetX)))
        const top = Math.round(Math.min(y + height - 42, Math.max(y, cursor.y - command.offsetY)))
        if (bounds.x !== left || bounds.y !== top) win.setPosition(left, top)
        break
      }
      case 'show': if (!win.isVisible()) win.showInactive(); break
      case 'hide': win.hide(); break
      case 'focus':
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        break
      case 'minimize': win.minimize(); break
      case 'toggle-maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break
      case 'attach':
        ownerClosed = false
        if (owner.isMinimized()) owner.restore()
        owner.show()
        owner.focus()
        win.close()
        break
      case 'close': win.close(); break
    }
  }
  ipcMain.on('win:tab-window', control)
  owner.once('closed', () => ipcMain.removeListener('win:tab-window', control))
}
