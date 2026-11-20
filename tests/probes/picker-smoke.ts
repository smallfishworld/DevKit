/** Colour picker probe (diagnostic; not part of npm test).
 * Verifies the rewritten picker: opens the overlay, checks it covers the cursor display,
 * simulates a click at a known pixel, and asserts the reported colour matches that pixel.
 */
import { app, BrowserWindow, screen } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { desktopCapturer } from 'electron'
import { pickPoint } from '../../src/main/services/macro/picker'

void app.whenReady().then(async () => {
  // 先截一张参考图，用于核对取点器报告的颜色
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  })
  const ref = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!ref?.thumbnail || ref.thumbnail.isEmpty()) {
    console.log('RESULT: screenshot unavailable in this environment')
    app.exit(0)
    return
  }
  const size = ref.thumbnail.getSize()
  const offset = { x: Math.round(display.bounds.x * scale), y: Math.round(display.bounds.y * scale) }

  // 在取点窗口打开后模拟一次点击（走真实 IPC 通道）
  const pending = pickPoint()
  await delay(2500)
  const wins = BrowserWindow.getAllWindows()
  const win = wins.at(-1)
  console.log('picker window:', JSON.stringify(win ? {
    visible: win.isVisible(),
    bounds: win.getBounds(),
    displayBounds: display.bounds,
    frame: false
  } : null))
  // 取点窗口里的放大镜/读数是否在工作
  console.log('overlay:', JSON.stringify(await win?.webContents.executeJavaScript(`(() => {
    const r = document.getElementById('shot').getBoundingClientRect()
    const img = document.getElementById('shot')
    return {
      imgCss: [Math.round(r.width), Math.round(r.height)],
      imgNatural: [img.naturalWidth, img.naturalHeight],
      tipLabel: document.getElementById('tip')?.getAttribute('aria-label'),
      hasLoupe: !!document.getElementById('loupe')
    }
  })()`)))

  console.log('dom:', JSON.stringify(await win?.webContents.executeJavaScript(`(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id)
    return { ids, bodyLen: document.body.innerHTML.length,
      hasLoupe: !!document.getElementById('loupe'),
      hasCrossX: !!document.getElementById('crossX') }
  })()`)))
  console.log('mousemove:', JSON.stringify(await win?.webContents.executeJavaScript(`(() => {
    const img = document.getElementById('shot')
    const r = img.getBoundingClientRect()
    img.dispatchEvent(new MouseEvent('mousemove', { clientX: r.width * 0.4, clientY: r.height * 0.3, bubbles: true }))
    return { hex: document.getElementById('hex')?.textContent, swatch: document.getElementById('swatch')?.style.background,
      coord: document.getElementById('coord')?.textContent,
      loupeCss: document.getElementById('loupe')?.style.width,
      tipKeep: !!document.getElementById('loupe')?.isConnected,
      cross: document.getElementById('crossX')?.style.top }
  })()`)))

  // 参考颜色：直接从同一张缩略图取点
  const bitmap = ref.thumbnail.toBitmap()
  const at = (px: number, py: number): string => {
    const o = (py * size.width + px) * 4
    const to2 = (n: number): string => n.toString(16).padStart(2, '0')
    return `#${to2(bitmap[o + 2])}${to2(bitmap[o + 1])}${to2(bitmap[o])}`.toUpperCase()
  }
  const { ipcMain } = await import('electron')
  // 非中心点：贴近右下角四分之三处，验证换算不是「差不多居中」
  const clickPixel = { x: Math.round(size.width * 0.73), y: Math.round(size.height * 0.61) }
  ipcMain.emit('devkit-picker-click', {}, { x: 0, y: 0, px: clickPixel.x, py: clickPixel.y })
  const result = await pending
  console.log('RESULT:', JSON.stringify(result))
  console.log('EXPECTED:', JSON.stringify({ x: offset.x + clickPixel.x, y: offset.y + clickPixel.y, color: at(clickPixel.x, clickPixel.y) }))
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(0)
}).catch((e) => { console.error('ERR', e); app.exit(1) })