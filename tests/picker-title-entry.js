import assert from 'node:assert/strict'
import {
  clientToPixel,
  magnifierRegion,
  pixelToPhysical,
  rgbToHex
} from '../src/shared/picker-geometry'
import { normalizePortPath } from '../src/shared/serial-title'

// ---------- 取点器坐标换算 ----------
// CSS 坐标 → 截图像素：窗口铺满显示器，CSS 尺寸=DIP，图像=物理像素
{
  // 100% 缩放：1:1
  assert.deepEqual(
    clientToPixel({ x: 100, y: 50 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
    { x: 100, y: 50 }
  )
  // 150% 缩放：CSS 1280x720 对应图像 1920x1080
  assert.deepEqual(
    clientToPixel({ x: 640, y: 360 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }),
    { x: 960, y: 540 }
  )
  // 点在右下角极限位置：夹到图像内（否则取色越界变黑）
  assert.deepEqual(
    clientToPixel({ x: 1279.6, y: 719.6 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }),
    { x: 1919, y: 1079 }
  )
  // 负坐标（多屏左侧副屏上的边角）夹到 0
  assert.deepEqual(
    clientToPixel({ x: -3, y: -1 }, { width: 800, height: 600 }, { width: 800, height: 600 }),
    { x: 0, y: 0 }
  )
  // 客户端尺寸为 0（窗口尚未布局）时不除零
  assert.deepEqual(
    clientToPixel({ x: 10, y: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 }),
    { x: 10, y: 10 }
  )
}

// 图像像素 + 显示器物理原点 → 全局物理坐标（宏注入用的是这套坐标）
{
  assert.deepEqual(pixelToPhysical({ x: 0, y: 0 }, { x: 5, y: 7 }), { x: 5, y: 7 })
  // 左副屏在 x=-1920（物理）：其内部 (0,0) 对应全局 (-1920, 0)
  assert.deepEqual(pixelToPhysical({ x: -1920, y: 0 }, { x: 0, y: 0 }), { x: -1920, y: 0 })
  assert.deepEqual(pixelToPhysical({ x: 1920, y: 0 }, { x: 100, y: 20 }), { x: 2020, y: 20 })
}

// 放大镜裁切：以采样点为中心、越界平移
{
  assert.deepEqual(
    magnifierRegion({ x: 50, y: 50 }, 16, { width: 100, height: 100 }),
    { x: 42, y: 42, width: 16, height: 16 }
  )
  assert.deepEqual(
    magnifierRegion({ x: 1, y: 1 }, 16, { width: 100, height: 100 }),
    { x: 0, y: 0, width: 16, height: 16 }
  )
  assert.deepEqual(
    magnifierRegion({ x: 99, y: 99 }, 16, { width: 100, height: 100 }),
    { x: 84, y: 84, width: 16, height: 16 }
  )
  // 图像比取景框还小：按图像尺寸裁
  assert.deepEqual(
    magnifierRegion({ x: 2, y: 2 }, 16, { width: 8, height: 6 }),
    { x: 0, y: 0, width: 8, height: 6 }
  )
}

// 颜色格式化
{
  assert.equal(rgbToHex(255, 0, 0), '#FF0000')
  assert.equal(rgbToHex(0, 0, 0), '#000000')
  assert.equal(rgbToHex(18, 52, 86), '#123456')
  assert.equal(rgbToHex(300, -5, 12.6), '#FF000D')
}

// ---------- 串口端口名归一化 ----------
{
  assert.equal(normalizePortPath('COM1'), 'COM1')
  assert.equal(normalizePortPath('com1'), 'COM1')
  assert.equal(normalizePortPath('  Com12  '), 'COM12')
  assert.equal(normalizePortPath('\\\\.\\COM3'), 'COM3')
  assert.equal(normalizePortPath('/dev/ttyUSB0'), '/dev/ttyUSB0')
  assert.equal(normalizePortPath(''), '')
}

console.log('picker-geometry / serial-title: ok')