/* 模拟 TerminalView 真实使用顺序：先订阅 onDidChangeResults，再搜索 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  await win.loadURL('about:blank')
  const js = `
    (async () => {
      const T = require(${JSON.stringify(path.resolve('node_modules/@xterm/xterm'))});
      const S = require(${JSON.stringify(path.resolve('node_modules/@xterm/addon-search'))});
      const term = new T.Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      const div = document.createElement('div');
      div.style.width = '800px'; div.style.height = '600px';
      document.body.appendChild(div);
      term.open(div);
      term.write('hello world hello\\r\\nfoo bar\\r\\nhello again');
      await new Promise(r => setTimeout(r, 200));
      const addon = new S.SearchAddon();
      term.loadAddon(addon);
      const decos = { matchBackground: '#3a3d1f', matchOverviewRuler: '#8a8a3d', activeMatchBackground: '#e0a53a', activeMatchColorOverviewRuler: '#e0a53a' };
      const evts = [];
      addon.onDidChangeResults(e => evts.push({ i: e.resultIndex, c: e.resultCount }));
      // 第一次搜索（输入触发）
      addon.findNext('hello', { decorations: decos });
      // 再按 Enter 两次跳下一个
      addon.findNext('hello', { decorations: decos });
      addon.findNext('hello', { decorations: decos });
      await new Promise(r => setTimeout(r, 300));
      const allDecos = document.querySelectorAll('.xterm-find-result-decoration').length;
      const activeDecos = document.querySelectorAll('.xterm-find-active-result-decoration').length;
      const noHit = [];
      addon.findNext('zzz', { decorations: decos });
      addon.onDidChangeResults(e => noHit.push({ i: e.resultIndex, c: e.resultCount }));
      addon.findNext('zzz', { decorations: decos });
      await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({
        events: evts, allDecos, activeDecos, noHitEvents: noHit,
        selText: term.getSelection()
      });
    })()
  `
  const result = await win.webContents.executeJavaScript(js, true)
  console.log('DIAG:', result)
  app.exit(0)
}).catch((e) => {
  console.error('ERR:', e)
  app.exit(1)
})
