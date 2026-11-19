/**
 * 截屏取点器（全屏覆盖层 + 放大镜）：点击取坐标和颜色。
 *
 * 关键约束（旧实现「取不到颜色 / 点这儿取到那儿」的根因）：
 *  - 旧窗口带边框、尺寸 = min(截图, 工作区-40)，还开了 overflow:auto，而点击换算用的是
 *    未缩放的图像坐标 → 窗口比屏幕小或被滚动时，点和色都偏。
 *  - 旧实现只截主屏，副屏/负坐标屏上取不到。
 *
 * 现在的做法：按光标所在显示器铺满一个无边框全屏覆盖层，窗口用该显示器的 DIP 边界，
 * 截图用同一显示器的物理像素缩略图；CSS→像素的换算集中在 shared/picker-geometry.ts（可单测）。
 * 坐标为全局物理像素（与 uiohook 捕获 / SendInput 注入一致），颜色取自截图同一像素。
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pixelToPhysical } from '../../../shared/picker-geometry'
import { grabDisplayPng } from './color'

export interface PickResult {
  x: number
  y: number
  color: string
}

/** 取点窗口的渲染逻辑（内联到临时 HTML）：悬停放大镜 + 十字准星 + 当前像素读数 */
const PICKER_SCRIPT = String.raw`
const img = document.getElementById('shot')
const tip = document.getElementById('tip')
const loupe = document.getElementById('loupe')
const loupeCtx = loupe.getContext('2d', { willReadFrequently: true })
const swatch = document.getElementById('swatch')
const hexText = document.getElementById('hex')
const coordText = document.getElementById('coord')
const crossX = document.getElementById('crossX')
const crossY = document.getElementById('crossY')
// 由主进程注入：{ offsetX, offsetY, imageWidth, imageHeight }
const meta = JSON.parse(document.getElementById('meta').textContent)
const LOUPE_SIDE = 15 // 放大镜覆盖 15x15 个物理像素
const ZOOM = 8

function pixelOf(ev) {
  const r = img.getBoundingClientRect()
  return window.pickerGeom.clientToPixel(
    { x: ev.clientX - r.left, y: ev.clientY - r.top },
    { width: r.width, height: r.height },
    { width: meta.imageWidth, height: meta.imageHeight }
  )
}

function physicalOf(px) {
  return window.pickerGeom.pixelToPhysical({ x: meta.offsetX, y: meta.offsetY }, px)
}

/** 只采样不改色：先取原图像素，再在副本上画准星，避免准星颜色污染读数 */
function drawLoupe(px, clientX, clientY) {
  const region = window.pickerGeom.magnifierRegion(px, LOUPE_SIDE, {
    width: meta.imageWidth, height: meta.imageHeight
  })
  const cx = px.x - region.x
  const cy = px.y - region.y

  loupe.width = region.width
  loupe.height = region.height
  loupe.style.width = region.width * ZOOM + 'px'
  loupe.style.height = region.height * ZOOM + 'px'
  loupeCtx.imageSmoothingEnabled = false
  loupeCtx.clearRect(0, 0, region.width, region.height)
  loupeCtx.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)

  const col = loupeCtx.getImageData(cx, cy, 1, 1).data
  const hex = window.pickerGeom.rgbToHex(col[0], col[1], col[2])

  // 采样之后再画准星
  loupeCtx.strokeStyle = '#ff3b30'
  loupeCtx.lineWidth = 1
  loupeCtx.strokeRect(cx - 0.5, cy - 0.5, 1, 1)

  swatch.style.background = hex
  hexText.textContent = hex
  const p = physicalOf(px)
  coordText.textContent = p.x + ', ' + p.y
  tip.setAttribute('aria-label', hex + ' @ ' + p.x + ',' + p.y)

  // 全屏十字准星：细线贯穿，便于对准
  crossX.style.top = clientY + 'px'
  crossY.style.left = clientX + 'px'

  // 提示框跟随光标，靠右/靠下时翻到另一侧
  const w = 190, h = 172
  tip.style.left = (clientX + 20 + w > window.innerWidth ? clientX - 20 - w : clientX + 20) + 'px'
  tip.style.top = (clientY + 20 + h > window.innerHeight ? clientY - 20 - h : clientY + 20) + 'px'
}

img.addEventListener('mousemove', (ev) => {
  drawLoupe(pixelOf(ev), ev.clientX, ev.clientY)
})

document.addEventListener('click', (ev) => {
  const px = pixelOf(ev)
  const p = physicalOf(px)
  window.pickerApi.click(p.x, p.y, px.x, px.y)
})

document.addEventListener('contextmenu', (ev) => {
  ev.preventDefault()
  window.pickerApi.cancel()
})
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') window.pickerApi.cancel()
})
window.addEventListener('blur', () => window.pickerApi.cancel())
function ready() {
  document.title = '截屏取点 — 单击取色，右键或 Esc 取消'
  window.pickerApi.ready()
}
if (img.complete && img.naturalWidth) ready()
else img.addEventListener('load', ready)
`

const PICKER_PRELOAD = String.raw`
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pickerApi', {
  click: (x, y, px, py) => ipcRenderer.send('devkit-picker-click', { x, y, px, py }),
  cancel: () => ipcRenderer.send('devkit-picker-cancel'),
  ready: () => ipcRenderer.send('devkit-picker-ready')
})
contextBridge.exposeInMainWorld('pickerGeom', {
  clientToPixel: (client, clientSize, imageSize) => {
    const sx = clientSize.width > 0 ? imageSize.width / clientSize.width : 1
    const sy = clientSize.height > 0 ? imageSize.height / clientSize.height : 1
    const clamp = (v, n) => Math.max(0, Math.min(Math.max(0, n - 1), Math.round(v)))
    return { x: clamp(client.x * sx, imageSize.width), y: clamp(client.y * sy, imageSize.height) }
  },
  pixelToPhysical: (origin, pixel) => ({ x: origin.x + pixel.x, y: origin.y + pixel.y }),
  magnifierRegion: (center, size, image) => {
    const width = Math.min(size, image.width)
    const height = Math.min(size, image.height)
    return {
      x: Math.max(0, Math.min(image.width - width, center.x - Math.floor(width / 2))),
      y: Math.max(0, Math.min(image.height - height, center.y - Math.floor(height / 2))),
      width,
      height
    }
  },
  rgbToHex: (r, g, b) => {
    const to2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    return ('#' + to2(r) + to2(g) + to2(b)).toUpperCase()
  }
})
`

/** 正在取点：面板重复点击时直接复用提示而不是静默失败 */
let picking = false

/** 取点被取消或失败时返回 null；调用方（ColorPanel / MacroPanel）按 null 处理 */
export async function pickPoint(): Promise<PickResult | null> {
  if (picking) return null
  picking = true
  let dir = ''
  let win: BrowserWindow | null = null
  try {
    // 跟随光标所在屏：多屏/副屏也能取，坐标仍是全局物理坐标
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const shot = await grabDisplayPng(display)
    dir = join(tmpdir(), `devkit-picker-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const pngPath = join(dir, 'shot.png')
    const htmlPath = join(dir, 'picker.html')
    const preloadPath = join(dir, 'preload.cjs')
    await fs.writeFile(pngPath, shot.png)
    await fs.writeFile(preloadPath, PICKER_PRELOAD, 'utf-8')
    const meta = JSON.stringify({
      offsetX: shot.offset.x,
      offsetY: shot.offset.y,
      imageWidth: shot.width,
      imageHeight: shot.height
    })
    await fs.writeFile(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><title>截屏取点</title><style>
        html,body{margin:0;height:100%;overflow:hidden;background:#000;cursor:none;user-select:none}
        #shot{position:fixed;inset:0;width:100%;height:100%;object-fit:fill;image-rendering:pixelated}
        #crossX{position:fixed;left:0;right:0;height:1px;background:rgba(255,59,48,.55);pointer-events:none;z-index:1}
        #crossY{position:fixed;top:0;bottom:0;width:1px;background:rgba(255,59,48,.55);pointer-events:none;z-index:1}
        #tip{position:fixed;left:0;top:0;display:flex;gap:8px;align-items:flex-start;padding:8px;
             font:12px/1.45 Consolas,monospace;color:#fff;background:rgba(20,24,28,.94);
             border:1px solid rgba(255,255,255,.22);border-radius:8px;pointer-events:none;
             box-shadow:0 6px 20px rgba(0,0,0,.55);z-index:3}
        #loupe{width:120px;height:120px;image-rendering:pixelated;border-radius:4px;
               border:1px solid rgba(255,255,255,.25);background:#000}
        #fields{display:flex;flex-direction:column;gap:6px}
        #row1{display:flex;align-items:center;gap:6px}
        #swatch{width:22px;height:22px;border-radius:4px;border:1px solid rgba(255,255,255,.4)}
        #hex{font-weight:600;letter-spacing:.5px}
        #coordLabel{color:rgba(255,255,255,.55)}
        #hint{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);padding:7px 16px;
              font:12px/1.4 "Microsoft YaHei",sans-serif;color:#fff;background:rgba(20,24,28,.88);
              border:1px solid rgba(255,255,255,.15);border-radius:999px;pointer-events:none;z-index:3}
      </style></head><body>
        <img id="shot" src="./shot.png" draggable="false">
        <div id="crossX"></div><div id="crossY"></div>
        <div id="tip"><canvas id="loupe" width="120" height="120"></canvas>
          <div id="fields">
            <div id="row1"><div id="swatch"></div><div id="hex">—</div></div>
            <div><span id="coordLabel">坐标 </span><span id="coord">—</span></div>
          </div>
        </div>
        <div id="hint">单击取色 · 右键 / Esc 取消</div>
        <script type="application/json" id="meta">${meta}</script>
        <script>${PICKER_SCRIPT}</script>
      </body></html>`,
      'utf-8'
    )

    win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      title: '截屏取点',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    // Windows 会把普通窗口夹到工作区（任务栏以上），不足以覆盖整屏；用全屏锁定到目标显示器
    win.setBounds(display.bounds)
    win.setFullScreen(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)

    return await new Promise<PickResult | null>((resolve) => {
      const pickerWin = win
      if (!pickerWin) return resolve(null)
      let settled = false
      const finish = (result: PickResult | null): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener('devkit-picker-click', onClick)
        ipcMain.removeListener('devkit-picker-cancel', onCancel)
        if (!pickerWin.isDestroyed()) pickerWin.destroy()
        resolve(result)
      }
      const onClick = (
        _e: Electron.IpcMainEvent,
        pos: { x: number; y: number; px: number; py: number }
      ): void => {
        // 页面报来的是图像内像素；坐标与颜色都从这同一像素派生，保证「点的哪儿就取哪儿」
        const physical = pixelToPhysical(shot.offset, { x: pos.px, y: pos.py })
        finish({ x: physical.x, y: physical.y, color: shot.sample(pos.px, pos.py) })
      }
      const onCancel = (): void => finish(null)
      ipcMain.on('devkit-picker-click', onClick)
      ipcMain.on('devkit-picker-cancel', onCancel)
      ipcMain.once('devkit-picker-ready', () => {
        if (!pickerWin.isDestroyed()) {
          pickerWin.show()
          pickerWin.focus()
        }
      })
      pickerWin.on('closed', () => finish(null))
      void pickerWin.loadFile(htmlPath).catch(() => finish(null))
      // 兜底：页面加载失败（图片损坏等）时不让面板永远转圈
      setTimeout(() => {
        if (!settled && !pickerWin.isDestroyed() && !pickerWin.isVisible()) {
          pickerWin.show()
        }
      }, 1500)
    })
  } catch {
    return null
  } finally {
    picking = false
    if (win && !win.isDestroyed()) win.destroy()
    if (dir) void fs.rm(dir, { recursive: true, force: true })
  }
}

/** 取点进行中（面板可据此提示「已在取点中」） */
export function isPicking(): boolean {
  return picking
}
