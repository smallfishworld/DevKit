exports.app = { getPath: () => globalThis.terminalTestDir }
// 串口/插件测试按运行注入 Electron 会话/窗口实现。
Object.defineProperty(exports, 'session', { get: () => globalThis.deviceActionElectronSession })
Object.defineProperty(exports, 'BrowserWindow', { get: () => globalThis.deviceActionElectronBrowserWindow })
exports.dialog = {
  showSaveDialog: async () => ({ canceled: false, filePath: globalThis.terminalExportPath }),
  showOpenDialog: async () => ({ canceled: false, filePaths: [globalThis.terminalExportPath] })
}
exports.ipcMain = { handle() {} }

let nextPowerBlockerId = 0
const powerBlockers = new Set()
exports.powerSaveBlocker = {
  start: () => { const id = ++nextPowerBlockerId; powerBlockers.add(id); return id },
  stop: (id) => powerBlockers.delete(id),
  isStarted: (id) => powerBlockers.has(id),
  get activeCount() { return powerBlockers.size }
}
