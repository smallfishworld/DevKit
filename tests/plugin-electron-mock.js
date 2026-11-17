export const app = { getPath: () => '/unused' }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const utilityProcess = { fork: () => { throw new Error('hostFactory must be injected in tests') } }
export const ipcMain = { handle: () => {} }
export const BrowserWindow = class {}
