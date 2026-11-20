import { EventEmitter } from 'node:events'

const state = () => globalThis.pluginAuthBrandingState

export const app = {
  isPackaged: true,
  getAppPath: () => process.cwd(),
  getPath: (name) => name === 'exe' ? 'C:\\Program Files\\DevKit\\DevKit.exe' : process.cwd(),
  getName: () => 'DevKit'
}
export const ipcMain = { handle() {} }
export const session = {
  fromPartition() {
    return {
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      async fetch() { return new Response(null, { status: 401 }) }
    }
  }
}

export class BrowserWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.destroyed = false
    this.webContents = new EventEmitter()
    this.webContents.setWindowOpenHandler = () => {}
    state().windows.push(this)
    state().calls.push({ type: 'create', options })
  }

  setAppDetails(details) {
    state().calls.push({ type: 'details', details: { ...details } })
    if (state().identityError) throw state().identityError
  }

  show() { state().calls.push({ type: 'show' }) }

  async loadURL(url) {
    state().calls.push({ type: 'load', url })
    state().controller.abort(state().cancelled)
  }

  isDestroyed() { return this.destroyed }

  destroy() {
    this.destroyed = true
    state().calls.push({ type: 'destroy' })
    this.emit('closed')
  }
}
