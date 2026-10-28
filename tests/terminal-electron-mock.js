exports.app = { getPath: () => globalThis.terminalTestDir }
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
