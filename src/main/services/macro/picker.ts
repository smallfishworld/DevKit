/**
 * 截屏取点器（ME-05）：全屏截图 -> 点击取坐标和颜色
 * 坐标返回物理像素；颜色取自截图像素
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { grabScreenPng } from './color'

export interface PickResult {
  x: number
  y: number
  color: string
}

const PICKER_PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pickerApi', {
  click: (x, y) => ipcRenderer.send('devkit-picker-click', { x, y }),
  cancel: () => ipcRenderer.send('devkit-picker-cancel')
})
window.addEventListener('DOMContentLoaded', () => {
  const img = document.getElementById('shot')
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect()
    const sx = img.naturalWidth / r.width
    const sy = img.naturalHeight / r.height
    window.pickerApi.click(Math.round((e.clientX - r.left) * sx), Math.round((e.clientY - r.top) * sy))
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.pickerApi.cancel()
  })
})
`

let picking = false

export async function pickPoint(): Promise<PickResult | null> {
  if (picking) return null
  picking = true
  const shot = await grabScreenPng()
  const dir = join(tmpdir(), `devkit-picker-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  const pngPath = join(dir, 'shot.png')
  const htmlPath = join(dir, 'picker.html')
  const preloadPath = join(dir, 'preload.cjs')
  await fs.writeFile(pngPath, shot.png)
  await fs.writeFile(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;background:#000;overflow:auto;cursor:crosshair}
      img{display:block;image-rendering:pixelated}
    </style></head><body><img id="shot" src="./shot.png"></body></html>`,
    'utf-8'
  )
  await fs.writeFile(preloadPath, PICKER_PRELOAD, 'utf-8')

  const { workArea } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: Math.min(shot.width, workArea.width - 40),
    height: Math.min(shot.height + 40, workArea.height - 40),
    title: '截屏取点（点击取坐标，Esc 取消）',
    frame: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  return new Promise<PickResult | null>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      ipcMain.removeAllListeners('devkit-picker-click')
      ipcMain.removeAllListeners('devkit-picker-cancel')
      if (!win.isDestroyed()) win.destroy()
      void fs.rm(dir, { recursive: true, force: true })
      picking = false
    }
    const finish = (result: PickResult | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    ipcMain.on('devkit-picker-click', (_e, pos: { x: number; y: number }) => {
      // 图像坐标 -> 物理屏幕坐标；颜色直接从截图像素取
      const x = shot.offsetX + pos.x
      const y = shot.offsetY + pos.y
      finish({ x, y, color: shot.sample(pos.x, pos.y) })
    })
    ipcMain.on('devkit-picker-cancel', () => finish(null))
    win.on('closed', () => finish(null))
    void win.loadFile(htmlPath)
  })
}
