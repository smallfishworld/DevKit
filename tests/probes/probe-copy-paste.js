/* 复制粘贴修复验证：事件 dispatch 到 xterm 内部 .xterm 元素（与真实鼠标等效的事件流），
   验证捕获阶段监听能否在 xterm 清选区前拿到选区 */
const { app, BrowserWindow, clipboard } = require('electron')
const path = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  await win.loadURL('about:blank')
  const js = `
    (async () => {
      const T = require(${JSON.stringify(path.resolve('node_modules/@xterm/xterm'))});
      const term = new T.Terminal({ cols: 80, rows: 24, scrollback: 1000 });
      const termBox = document.createElement('div');
      document.body.style.margin = '0';
      document.body.appendChild(termBox);
      term.open(termBox);
      term.write('alpha beta gamma\\r\\ndelta epsilon');
      await new Promise(r => setTimeout(r, 200));

      // ===== 复刻 TerminalView 修复后的监听（捕获阶段） =====
      let copied = null;
      let pasted = null;
      function onMousedown(e) {
        if (e.button === 0) {
          const sel = term.getSelection();
          if (sel) copied = sel; // 模拟 writeClipboard
        } else if (e.button === 2) {
          pasted = 'CLIP'; // 模拟 readClipboard→emit
        }
      }
      function onContextmenu(e) { e.preventDefault(); }
      termBox.addEventListener('mousedown', onMousedown, true);
      termBox.addEventListener('contextmenu', onContextmenu, true);

      const xel = termBox.querySelector('.xterm');
      const rect = xel.getBoundingClientRect();
      const mk = (type, button, x, y) => new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        button, buttons: 1, clientX: x, clientY: y
      });

      // 1) 建立"拖选"选区（等效结果）：选中 alpha beta
      term.select(0, 0, 10);
      // 2) 左键点击（dispatch 到 xterm 元素——冒泡经 termBox，捕获监听先跑）
      xel.dispatchEvent(mk('mousedown', 0, rect.left + 50, rect.top + 20));
      xel.dispatchEvent(mk('mouseup', 0, rect.left + 50, rect.top + 20));
      const copiedText = copied;
      const selAfterClick = term.hasSelection();

      // 3) 无选区时左键点击：不应复制
      copied = null;
      xel.dispatchEvent(mk('mousedown', 0, rect.left + 50, rect.top + 20));
      xel.dispatchEvent(mk('mouseup', 0, rect.left + 50, rect.top + 20));
      const copiedEmpty = copied;

      // 4) 右键：应触发粘贴路径（不弹菜单）
      pasted = null;
      xel.dispatchEvent(mk('mousedown', 2, rect.left + 50, rect.top + 20));
      xel.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, composed: true,
        button: 2, clientX: rect.left + 50, clientY: rect.top + 20
      }));
      const menuDefaultPrevented = (() => {
        // contextmenu preventDefault 已在处理器中执行；无 window 弹出即通过
        return pasted === 'CLIP';
      })();

      return JSON.stringify({
        copiedText, selAfterClick, copiedEmpty,
        rightClickPaste: menuDefaultPrevented
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
