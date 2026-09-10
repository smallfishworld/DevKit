/* 探针入口：直接引 serialService 源码模块（esbuild 打包成 cjs 后在 electron 跑） */
import { app } from 'electron'
import { serialService } from '../src/main/services/serial/index'

async function main(): Promise<void> {
  const panelId = 'probe#1'
  const t0 = Date.now()

  const ports = (await serialService.invoke(panelId, 'list', null)) as { path: string }[]
  console.log('端口列表:', ports.map((p) => p.path).join(', '))

  const target = ports.find((p) => p.path === 'COM20') ?? ports[0]
  if (!target) {
    console.log('无可用端口')
    app.exit(0)
    return
  }
  console.log(`尝试打开 ${target.path} ...`)

  const res = (await Promise.race([
    serialService.invoke(panelId, 'open', {
      path: target.path,
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false
    }),
    new Promise<{ ok: boolean; error?: string }>((r) =>
      setTimeout(() => r({ ok: false, error: 'open 超时 5000ms —— 仍卡' }), 5000)
    )
  ])) as { ok: boolean; error?: string }
  console.log(`open 结果 (${Date.now() - t0}ms):`, JSON.stringify(res))

  if (res.ok) {
    const wr = (await serialService.invoke(panelId, 'write', {
      mode: 'ascii',
      text: 'ping',
      newline: 'crlf'
    })) as { ok: boolean; bytes?: number }
    console.log('write:', JSON.stringify(wr))
    const sig = await serialService.invoke(panelId, 'signals', null)
    console.log('signals:', JSON.stringify(sig))
    const dtr = await serialService.invoke(panelId, 'dtr', { on: true })
    const rts = await serialService.invoke(panelId, 'rts', { on: true })
    console.log('dtr/rts:', JSON.stringify(dtr), JSON.stringify(rts))
    await new Promise((r) => setTimeout(r, 300))
    const cl = await serialService.invoke(panelId, 'close', null)
    console.log('close:', JSON.stringify(cl))
    // 自动日志落盘检查
    const fs = await import('node:fs')
    const dir = `${process.env.APPDATA ?? ''}/dev-kit/serial-logs`
    try {
      const files = fs.readdirSync(dir)
      console.log('自动日志目录:', files.join(', ') || '(空)')
    } catch {
      console.log('自动日志目录尚未创建')
    }
  }
  app.exit(res.ok ? 0 : 1)
}

app.whenReady().then(main).catch((e: unknown) => {
  console.error('probe 异常:', e)
  app.exit(2)
})
