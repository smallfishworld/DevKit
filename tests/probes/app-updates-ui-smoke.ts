import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerService, registerToolIpc, setMainWindow } from '../../src/main/ipc'
import { APP_UPDATES } from '../../src/shared/app-updates'
import { AppUpdateService } from '../../src/main/services/updates'
import { GitHubReleases, packageName } from '../../src/main/services/updates/github'

const root = process.env.DEVKIT_SMOKE_USER_DATA!
const version = '99.1.2'
const data = Buffer.alloc(1024 * 1024, 3)
const name = packageName(version, 'zip')
const target = {
  format: 'zip' as const,
  cache: join(root, 'updates'),
  executable: join(root, 'DevKit.exe'),
  helper: join(root, 'DeliberatelyAbsentHelper.exe')
}

const releases = new GitHubReleases(async (url) => {
  if (url.includes('api.github.com')) {
    return Response.json({
      tag_name: 'v' + version, draft: false, prerelease: false,
      body: '- 改善 Windows 连接稳定性\n- <img src=x onerror=alert(1)>',
      assets: [{
        name, size: data.length, state: 'uploaded',
        digest: 'sha256:' + createHash('sha256').update(data).digest('hex')
      }]
    })
  }
  assert.ok(url.endsWith('/' + name))
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(data.subarray(0, 4096))
      await delay(500)
      controller.enqueue(data.subarray(4096))
      controller.close()
    }
  }))
})

async function main(): Promise<void> {
  app.setPath('userData', root)
  await app.whenReady()
  assert.equal(app.getVersion(), '0.2.0')
  const service = new AppUpdateService(target, releases)
  registerService(APP_UPDATES, service)
  registerService('settings', { invoke: () => undefined })
  registerService('plugins', { invoke: () => [] })
  registerToolIpc()
  ipcMain.handle('win:info', () => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, platform: process.platform
  }))
  const window = new BrowserWindow({
    width: 1050, height: 760,
    webPreferences: {
      preload: join(process.cwd(), 'out/preload/index.js'),
      contextIsolation: true, backgroundThrottling: false
    }
  })
  setMainWindow(window)
  const js = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source)
  const evaluate = async (expression: string): Promise<void> => {
    for (let count = 0; count < 260; count++) {
      if (await js(expression)) return
      await delay(50)
    }
    throw new Error('UI condition timed out: ' + expression)
  }
  const press = async (name: string): Promise<void> => {
    assert.ok(await js('(() => { const node = [...document.querySelectorAll(".update-dialog button")].find(' +
      'button => button.textContent.trim().startsWith(' + JSON.stringify(name) +
      ') && !button.disabled); if (!node) return false; node.click(); return true })()'))
  }
  const open = () => js('document.querySelector(".update-entry").click()')
  const ready = 'document.querySelector(".update-entry")?.textContent.includes("已下载")'

  try {
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await evaluate('document.querySelector(".update-entry")')
    service.start()
    await evaluate('document.querySelector(".update-entry")?.textContent.includes("发现新版本")')
    assert.equal(await js('document.querySelector(".update-dialog").open'), false)
    await open()
    await evaluate('document.querySelector(".update-dialog")?.matches(":modal")')
    assert.match(await js<string>('document.activeElement.textContent.trim()'), /稍后/)
    assert.match(await js<string>('document.querySelector(".update-notes").textContent'), /改善 Windows/)
    assert.equal(await js('document.querySelector(".update-notes img")'), null)
    await press('下载更新')
    await evaluate('document.querySelector("progress")?.value === 4096')
    await press('稍后')
    await evaluate('!document.querySelector(".update-dialog").open')
    await evaluate(ready)
    assert.deepEqual(await readFile(join(target.cache, name)), data)
    console.log('PASS non-blocking notice, release notes, progress and postponed restart')

    service.dispose()
    registerService(APP_UPDATES, new AppUpdateService(target, releases))
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    await evaluate(ready)
    await open()
    await writeFile(join(target.cache, name), Buffer.alloc(data.length, 5))
    await press('重启并更新')
    await evaluate('document.querySelector(".update-message")?.textContent.includes("校验失败")')
    assert.equal(app.getVersion(), '0.2.0')
    console.log('PASS pending package restoration and pre-restart integrity check')
  } finally {
    service.dispose()
    window.destroy()
  }
}

main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
