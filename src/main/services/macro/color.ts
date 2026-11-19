/**
 * 等待颜色：desktopCapturer 截屏 + 像素比对
 * 坐标为物理像素（与 uiohook/GetCursorPos 一致）
 */
import { desktopCapturer, screen } from 'electron'
import type { WaitColorSpec } from '../../../shared/macro'

interface PixelResult {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): PixelResult {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

function pixelAt(img: Electron.NativeImage, px: number, py: number): PixelResult {
  const size = img.getSize()
  if (px < 0 || py < 0 || px >= size.width || py >= size.height) return { r: -1, g: -1, b: -1 }
  const bitmap = img.toBitmap() // BGRA
  const off = (py * size.width + px) * 4
  return { b: bitmap[off], g: bitmap[off + 1], r: bitmap[off + 2] }
}

function within(target: PixelResult, actual: PixelResult, tolerance: number): boolean {
  return (
    Math.abs(target.r - actual.r) <= tolerance &&
    Math.abs(target.g - actual.g) <= tolerance &&
    Math.abs(target.b - actual.b) <= tolerance
  )
}

interface DisplayHit {
  source: Electron.DesktopCapturerSource | undefined
  localX: number
  localY: number
  pixelW: number
  pixelH: number
}

function locateDisplay(x: number, y: number): DisplayHit {
  const displays = screen.getAllDisplays()
  const display =
    displays.find((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && y >= d.bounds.y && y < d.bounds.y + d.bounds.height) ??
    screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  return {
    source: undefined,
    localX: Math.round((x - display.bounds.x) * scale),
    localY: Math.round((y - display.bounds.y) * scale),
    pixelW: Math.round(display.size.width * scale),
    pixelH: Math.round(display.size.height * scale)
  }
}

async function grabPixel(x: number, y: number): Promise<PixelResult> {
  const hit = locateDisplay(x, y)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: hit.pixelW, height: hit.pixelH }
  })
  // 单屏直接取第一个；多屏按 display_id 匹配
  let source = sources[0]
  if (sources.length > 1 && hit.source) {
    source = sources.find((s) => s.display_id === hit.source?.display_id) ?? sources[0]
  }
  if (!source?.thumbnail) return { r: -1, g: -1, b: -1 }
  return pixelAt(source.thumbnail, hit.localX, hit.localY)
}

/** 等待颜色出现/消失；返回是否在超时前满足条件 */
export async function waitColor(
  spec: WaitColorSpec,
  shouldStop: () => boolean,
  onTick?: (elapsedMs: number) => void
): Promise<boolean> {
  const target = hexToRgb(spec.color)
  const start = Date.now()
  while (Date.now() - start < spec.timeoutMs) {
    if (shouldStop()) return false
    const actual = await grabPixel(spec.x, spec.y)
    // 截屏失败（r<0）视为"本次无数据"，继续轮询——否则「消失」模式会误判为条件满足
    const matched = actual.r < 0 ? false : within(target, actual, spec.tolerance)
    const satisfied = actual.r >= 0 && (spec.mode === 'appear' ? matched : !matched)
    if (satisfied) return true
    onTick?.(Date.now() - start)
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

/**
 * 按显示器截屏并返回 PNG 与取色函数（取点器用）。
 * 缩略图按该显示器的**物理像素**尺寸申请；坐标原点取显示器的物理位置
 * （DIP bounds × scaleFactor），与 uiohook/SendInput 的物理屏幕坐标一致。
 */
export async function grabDisplayPng(display: Electron.Display): Promise<{
  png: Buffer
  width: number
  height: number
  /** 该显示器左上角在全局物理屏幕坐标中的位置 */
  offset: { x: number; y: number }
  /** 图像局部像素取色，返回 '#RRGGBB' */
  sample: (localX: number, localY: number) => string
}> {
  const scale = display.scaleFactor || 1
  const w = Math.round(display.size.width * scale)
  const h = Math.round(display.size.height * scale)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h }
  })
  // 多屏按 display_id 匹配；匹配不到退回第一张（单屏时即唯一一张）
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  const img = source?.thumbnail
  if (!img || img.isEmpty()) throw new Error('截屏失败：未获取到屏幕画面（可能被系统权限拦截）')
  const to2 = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return {
    png: img.toPNG(),
    width: img.getSize().width,
    height: img.getSize().height,
    offset: {
      x: Math.round(display.bounds.x * scale),
      y: Math.round(display.bounds.y * scale)
    },
    sample: (localX: number, localY: number): string => {
      const p = pixelAt(img, localX, localY)
      if (p.r < 0) return '#000000'
      return `#${to2(p.r)}${to2(p.g)}${to2(p.b)}`.toUpperCase()
    }
  }
}
