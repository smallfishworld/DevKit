/** Real-renderer zoom/flicker probe (diagnostic; not part of npm test).
 * Opens the built renderer, connects a simulated serial port, then:
 *  - counts style/width/height mutations in the terminal subtree while streaming and while idle;
 *  - draws 3 rows of "M" and screenshots the terminal rect to measure the rasterized glyph
 *    size (in WebGL mode there are no DOM rows to measure, only pixels are trustworthy);
 *  - zooms with Ctrl+wheel and checks the box width stays fixed and the glyph grows in both axes.
 */
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SerialPort } from 'serialport'
import { serialService } from '../../src/main/services/serial'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'
import { registerService, registerToolIpc, setMainWindow, disposeAllPanels } from '../../src/main/ipc'
import { settingsService } from '../../src/main/services/settings'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { setSection } from '../../src/main/services/macro/configStore'

const ESC = '\x1b'

/** BGRA bitmap -> white-ink bounding box (measures what the user actually sees). */
function inkBox(img: Electron.NativeImage): { w: number; h: number; px: number } | null {
  const size = img.getSize()
  const bitmap = img.toBitmap()
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, px = 0
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const o = (y * size.width + x) * 4
      if (bitmap[o] + bitmap[o + 1] + bitmap[o + 2] > 200) {
        px++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return px ? { w: maxX - minX + 1, h: maxY - minY + 1, px } : null
}

const dir = mkdtempSync(join(tmpdir(), 'devkit-zoom-probe-'))
app.setPath('userData', dir)

const simulated = SerialPort as unknown as {
  ports: Array<{ emit(event: string, data: Buffer): void }>
  list: () => Promise<unknown[]>
  prototype: { write: (data: Buffer, done?: (error?: Error) => void) => void }
}
simulated.list = async () => [{ path: 'COM-SMOKE', friendlyName: 'probe' }]
simulated.prototype.write = (_data, done) => { done?.() }

let row = 0
let pumping = false
const pump = setInterval(() => {
  if (!pumping) return
  const text = Array.from({ length: 24 }, () => `ROW-${row++} 中文 ${ESC}[32mPASS${ESC}[0m MMMMMMMM\r\n`).join('')
  simulated.ports.at(-1)?.emit('data', Buffer.from(text))
}, 40)

void app.whenReady().then(async () => {
  await setSection('serial', { ...DEFAULT_SERIAL_CONFIG, last: { ...DEFAULT_SERIAL_PARAMS, path: 'COM-SMOKE' } })
  registerService('serial', serialService)
  registerService('settings', settingsService)
  registerService('quickcmds', quickCmdsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'zoom-probe' }))
  ipcMain.handle('win:clipboard-read', () => clipboard.readText())
  ipcMain.handle('win:clipboard-write', (_e, text) => { clipboard.writeText(text); return true })
  ipcMain.on('win:minimize', () => {})
  ipcMain.on('win:toggle-maximize', () => {})
  ipcMain.on('win:close', () => {})

  const win = new BrowserWindow({
    width: 1280, height: 860, show: true,
    webPreferences: { preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false }
  })
  setMainWindow(win)
  const js = <T>(source: string): Promise<T> => win.webContents.executeJavaScript(source)
  try {
    await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await delay(600)
    const clickText = (selector: string, name: string): Promise<boolean> => js(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e =>
        e.getClientRects().length && e.textContent.trim() === ${JSON.stringify(name)});
      if (!el) return false; el.click(); return true;
    })()`)
    for (let i = 0; i < 100; i++) {
      if (await js<boolean>(`!!document.querySelector('.toolbox')`)) break
      await delay(100)
    }
    console.log('open serial:', await js<boolean>(`(() => {
      const el = [...document.querySelectorAll('.toolbox .tool-row')].find(e => e.querySelector('strong')?.textContent === '串口助手');
      if (!el) return false; el.click(); return true;
    })()`))
    for (let i = 0; i < 100; i++) {
      if (await js<boolean>(`!!document.querySelector('.serial-panel')`)) break
      await delay(100)
    }
    await delay(500)
    console.log('connect:', await clickText('.conn-bar button', '连接'))
    for (let i = 0; i < 100; i++) {
      if (await js<boolean>(`!!document.querySelector('.port-status.online')`)) break
      await delay(100)
    }
    pumping = true
    await delay(1200)

    await js(`(() => {
      window.__churn = 0;
      const box = document.querySelector('.serial-panel .term');
      window.__churnObserver = new MutationObserver((records) => { window.__churn += records.length });
      window.__churnObserver.observe(box, { attributes: true, subtree: true, attributeFilter: ['style', 'width', 'height'] });
      return true;
    })()`)
    await delay(1500)
    console.log('streaming churn(1.5s):', await js<number>(`window.__churn`))

    pumping = false
    await delay(1500)
    await js(`(() => { window.__churn = 0; return true })()`)
    await delay(2000)
    console.log('true-idle churn(2s):', await js<number>(`window.__churn`))

    const wheel = (dirY: number) => js(`(() => {
      const box = document.querySelector('.serial-panel .term');
      box.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dirY}, ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`)

    // 清屏 → 只画 3 行 M → 截终端矩形量墨迹包围盒（真实绘制尺寸）
    const measure = async (label: string): Promise<Record<string, unknown>> => {
      simulated.ports.at(-1)?.emit('data', Buffer.from(`${ESC}[2J${ESC}[H` + 'MMMMM\r\nMMMMM\r\nMMMMM'))
      await delay(700)
      const info = await js<{ x: number; y: number; w: number; h: number } | null>(`(() => {
        const b = document.querySelector('.serial-panel .term');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })()`)
      if (!info) return { label, error: 'no .term' }
      const img = await win.capturePage({ x: info.x, y: info.y, width: info.w, height: info.h })
      const out = { label, boxW: info.w, boxH: info.h, ink: inkBox(img) }
      console.log(label, JSON.stringify(out))
      return out
    }

    const results: Array<Record<string, unknown>> = []
    results.push(await measure('ink@13'))
    for (let i = 0; i < 6; i++) { await wheel(-120); await delay(120) }
    results.push(await measure('ink@19'))
    for (let i = 0; i < 9; i++) { await wheel(-120); await delay(120) }
    results.push(await measure('ink@28'))
    for (let i = 0; i < 19; i++) { await wheel(120); await delay(120) }
    results.push(await measure('ink@9'))

    const ink = (r: Record<string, unknown>): { w: number; h: number } =>
      (r.ink as { w: number; h: number } | null) ?? { w: NaN, h: NaN }
    const ratio = (a: Record<string, unknown>, b: Record<string, unknown>): string =>
      `W ${(ink(b).w / ink(a).w).toFixed(2)}  H ${(ink(b).h / ink(a).h).toFixed(2)}`
    console.log('--- ink 13 -> 19:', ratio(results[0], results[1]))
    console.log('--- ink 13 -> 28:', ratio(results[0], results[2]))
    console.log('--- box widths:', results.map(r => r.boxW).join(' -> '))

    pumping = true
    await js(`(() => { window.__churn = 0; return true })()`)
    await delay(2000)
    console.log('busy churn(2s):', await js<number>(`window.__churn`))
  } finally {
    pumping = false
    clearInterval(pump)
    await disposeAllPanels()
    win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })