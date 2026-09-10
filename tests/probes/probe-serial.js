/* 探针：验证 serialport 原生绑定与 Electron ABI 兼容 + 列举串口 */
const { app } = require('electron')

app.whenReady().then(async () => {
  try {
    const { SerialPort } = require('serialport')
    const ports = await SerialPort.list()
    console.log('[probe] serialport loaded, binding OK')
    console.log('[probe] ports:', ports.length)
    for (const p of ports) {
      console.log('  -', p.path, '|', p.friendlyName ?? p.manufacturer ?? '')
    }
    // 验证构造参数被接受（不实际打开不存在的口）
    try {
      const port = new SerialPort({ path: 'COM_INVALID_99', baudRate: 115200, autoOpen: false })
      console.log('[probe] SerialPort construct OK, isOpen =', port.isOpen)
    } catch (e) {
      console.log('[probe] construct failed:', e.message)
    }
    console.log('[probe] OK')
    app.exit(0)
  } catch (err) {
    console.log('[probe] ERROR:', err.message)
    console.log('[probe] NODE_MODULE_VERSION mismatch or binding missing')
    app.exit(1)
  }
})
