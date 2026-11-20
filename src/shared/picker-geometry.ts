/** 取点器的坐标换算（纯函数，可单测）。
 *
 * 取点窗口是「某台显示器的全屏覆盖层」，窗口里贴的是该显示器截图的**物理像素**图像：
 *  - 页面 CSS 尺寸 = 显示器 DIP 尺寸（Electron 的窗口坐标单位）；
 *  - 图像尺寸 = 显示器物理像素尺寸（= DIP × scaleFactor）。
 * 因此 CSS → 图像像素只需按两者比例缩放，与 DPR 是多少无关；缩放屏（125%/150%）
 * 和混合 DPI 多屏都走同一条公式，不会出现「点这儿取到那儿」。
 *
 * 图像像素 → 全局物理屏幕坐标 = 该显示器物理原点 + 图像内偏移。
 * 宏/键鼠注入（uiohook 捕获、SendInput 注入）用的都是这一套物理坐标。
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** CSS 客户端坐标 → 截图像素坐标（四舍五入并夹到图像边界内） */
export function clientToPixel(client: Point, clientSize: Size, imageSize: Size): Point {
  const scaleX = clientSize.width > 0 ? imageSize.width / clientSize.width : 1
  const scaleY = clientSize.height > 0 ? imageSize.height / clientSize.height : 1
  return {
    x: clamp(Math.round(client.x * scaleX), imageSize.width),
    y: clamp(Math.round(client.y * scaleY), imageSize.height)
  }
}

/** 图像内像素 + 显示器物理原点 → 全局物理屏幕坐标 */
export function pixelToPhysical(origin: Point, pixel: Point): Point {
  return { x: origin.x + pixel.x, y: origin.y + pixel.y }
}

/** 取色小放大镜的裁切区域：以采样点为中心、边长 size（偶数），越界时整体平移进图内 */
export function magnifierRegion(
  center: Point,
  size: number,
  image: Size
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(size, image.width)
  const height = Math.min(size, image.height)
  const half = Math.floor(width / 2)
  const halfY = Math.floor(height / 2)
  return {
    x: Math.max(0, Math.min(image.width - width, center.x - half)),
    y: Math.max(0, Math.min(image.height - height, center.y - halfY)),
    width,
    height
  }
}

/** '#RRGGBB'（大写）；通道值按 0~255 夹取 */
export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase()
}

function clamp(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Math.max(0, size - 1), value))
}