/** 悬浮状态条：录制/回放时置顶显示状态（不影响被操作窗口获焦策略） */
import { BrowserWindow, screen } from 'electron'

let hudWin: BrowserWindow | null = null

const HUD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:'Microsoft YaHei',sans-serif;background:rgba(20,20,20,.92);color:#4ade80;
font-size:13px;display:flex;align-items:center;justify-content:center;height:100vh;user-select:none;
border:1px solid #333;border-radius:8px;box-sizing:border-box;white-space:pre-line;text-align:center}
.rec{color:#f87171}
</style></head><body><div id="t"></div></body></html>`

function ensureHud(): BrowserWindow {
  if (hudWin && !hudWin.isDestroyed()) return hudWin
  const { workArea } = screen.getPrimaryDisplay()
  const w = 280
  const h = 64
  hudWin = new BrowserWindow({
    width: w,
    height: h,
    x: workArea.x + workArea.width - w - 16,
    y: workArea.y + workArea.height - h - 16,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  hudWin.setAlwaysOnTop(true, 'screen-saver')
  hudWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HUD_HTML)}`)
  hudWin.once('ready-to-show', () => hudWin?.showInactive())
  return hudWin
}

export function showHud(text: string, recording = false): void {
  try {
    const win = ensureHud()
    win.webContents.executeJavaScript(
      `document.getElementById('t').className=${JSON.stringify(recording ? 'rec' : '')};
       document.getElementById('t').textContent=${JSON.stringify(text)};`
    ).catch(() => {})
  } catch {
    /* hud 失败不影响主流程 */
  }
}

export function hideHud(): void {
  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.close()
  }
  hudWin = null
}
