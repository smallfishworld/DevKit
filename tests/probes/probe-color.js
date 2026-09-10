/* 探针：验证 desktopCapturer 截屏 + toBitmap 像素读取（wait-color 的地基） */
const { app, desktopCapturer, screen } = require('electron')

app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay()
    const scale = d.scaleFactor || 1
    const w = Math.round(d.size.width * scale)
    const h = Math.round(d.size.height * scale)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h }
    })
    const img = sources[0]?.thumbnail
    if (!img) {
      console.log('[probe] NO THUMBNAIL')
      app.exit(1)
      return
    }
    const size = img.getSize()
    const bmp = img.toBitmap() // BGRA
    const cx = size.width >> 1
    const cy = size.height >> 1
    const off = (cy * size.width + cx) * 4
    console.log(
      '[probe] display',
      JSON.stringify(d.size),
      'scale',
      scale,
      'thumb',
      JSON.stringify(size),
      'bitmapLen',
      bmp.length,
      'expected',
      size.width * size.height * 4,
      'centerBGRA',
      bmp[off],
      bmp[off + 1],
      bmp[off + 2],
      bmp[off + 3]
    )
    // PNG 尺寸一致性（取点器用）
    const png = img.toPNG()
    console.log('[probe] png bytes', png.length)
    console.log('[probe] OK')
    app.exit(0)
  } catch (err) {
    console.log('[probe] ERROR', err && err.message)
    app.exit(1)
  }
})
