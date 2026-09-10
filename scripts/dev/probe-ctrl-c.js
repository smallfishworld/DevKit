/* 终端控制键映射 + 焦点判断最小验证 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  await win.loadURL('about:blank')
  const js = `
    const TERM_CTRL_KEYS = { c: '\\x03', z: '\\x1a', d: '\\x04', '\\\\': '\\x1c', u: '\\x15' };
    const isEditableTarget = (el) => {
      if (!(el && el.tagName)) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    };
    JSON.stringify({
      ctrlC: TERM_CTRL_KEYS['c'].charCodeAt(0),
      ctrlZ: TERM_CTRL_KEYS['z'].charCodeAt(0),
      ctrlBackslash: TERM_CTRL_KEYS['\\\\'].charCodeAt(0),
      inputEditable: isEditableTarget({ tagName: 'INPUT' }),
      bodyEditable: isEditableTarget({ tagName: 'BODY' })
    });
  `
  const result = await win.webContents.executeJavaScript(js, true)
  console.log('DIAG:', result)
  app.exit(0)
}).catch((e) => { console.error('ERR:', e); app.exit(1) })