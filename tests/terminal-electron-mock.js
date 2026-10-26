exports.app = { getPath: () => globalThis.terminalTestDir }
exports.dialog = {
  showSaveDialog: async () => ({ canceled: false, filePath: globalThis.terminalExportPath }),
  showOpenDialog: async () => ({ canceled: false, filePaths: [globalThis.terminalExportPath] })
}
exports.ipcMain = { handle() {} }
