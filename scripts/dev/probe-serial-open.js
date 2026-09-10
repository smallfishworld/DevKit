/* 串口打开链路诊断：list → open → set(dtr/rts) → get → close，每步限时防卡 */
const { SerialPort } = require('serialport')

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms))
  ])
}

function openPort(opts) {
  return new Promise((resolve, reject) => {
    let settled = false
    const port = new SerialPort({ ...opts, autoOpen: false }, (err) => {
      if (settled) return
      settled = true
      err ? reject(err) : resolve(port)
    })
    // open 失败会同时以 'error' 事件抛出，必须挂监听避免未捕获异常
    port.on('error', () => {})
    port.open()
  })
}

async function main() {
  const ports = await withTimeout(SerialPort.list(), 5000, 'list')
  console.log('枚举到端口:')
  for (const p of ports) {
    console.log(`  ${p.path}  ${p.friendlyName ?? p.manufacturer ?? ''}`)
  }

  for (const path of ['COM1', 'COM2', 'COM5', 'COM20']) {
    if (!ports.some((p) => p.path === path)) continue
    console.log(`\n== 测试 ${path} ==`)
    const t0 = Date.now()
    let port
    try {
      port = await withTimeout(
        openPort({ path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', rtscts: false }),
        5000,
        'open'
      )
      console.log(`  open 成功 (${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`  open 失败: ${e.message}`)
      continue
    }

    try {
      await withTimeout(new Promise((res, rej) => port.set({ dtr: true, rts: true }, (e) => (e ? rej(e) : res()))), 2000, 'set')
      console.log(`  set(dtr/rts) 成功 (${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`  set 失败: ${e.message}`)
    }

    try {
      const st = await withTimeout(new Promise((res, rej) => port.get((e, s) => (e ? rej(e) : res(s)))), 2000, 'get')
      console.log(`  get 信号成功 cts=${st.cts} dsr=${st.dsr} dcd=${st.dcd} (${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`  get 失败: ${e.message}`)
    }

    try {
      await withTimeout(new Promise((res) => port.close(() => res())), 2000, 'close')
      console.log(`  close 成功 (${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`  close 失败/超时: ${e.message}`)
    }
  }
  console.log('\n=== 诊断完成 ===')
}

main().catch((e) => {
  console.error('诊断异常:', e.message)
  process.exit(1)
})
