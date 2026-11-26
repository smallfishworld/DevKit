import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import { registerService, registerToolIpc, setMainWindow } from '../../src/main/ipc'
import { APP_UPDATES } from '../../src/shared/app-updates'
import { AppUpdateService } from '../../src/main/services/updates'
import { GitHubReleases, packageName } from '../../src/main/services/updates/github'
import { reportLeftoverFiles } from '../../src/main/services/updates/install'

const root = process.env.DEVKIT_SMOKE_USER_DATA!
const version = '99.1.2'
const data = Buffer.alloc(1024 * 1024, 3)
const name = packageName('zip')
const target = {
  format: 'zip' as const,
  cache: join(root, 'updates'),
  executable: join(root, 'DevKit.exe'),
  helper: join(root, 'DeliberatelyAbsentHelper.exe')
}

let officialAssetRequests = 0
let finishDownload!: () => void
const downloadMayFinish = new Promise<void>((resolve) => { finishDownload = resolve })

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
  if (new URL(url).hostname !== 'github.com') return new Response(null, { status: 503 })
  // The first request probes the source; only the actual download waits for the UI.
  if (officialAssetRequests++ === 0) return new Response(Uint8Array.from(data))
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(data.subarray(0, 4096))
    },
    async pull(controller) {
      await downloadMayFinish
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

    // 上次更新没能放回程序目录的用户文件：助手留下标记，工作台出现后提示一次（对话框由替身接住）
    const marker = join(target.cache, 'apply-leftover')
    const backup = join(root, '.devkit-backup-' + '0f'.repeat(16))
    await mkdir(backup)
    await mkdir(target.cache, { recursive: true })
    await writeFile(marker, backup + '\r\n项目资料/\r\n')
    const shown: MessageBoxOptions[] = []
    const showMessageBox = dialog.showMessageBox
    dialog.showMessageBox = (async (...args: unknown[]) => {
      shown.push(args.at(-1) as MessageBoxOptions)
      return { response: 1, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox

    service.start()
    await evaluate('document.querySelector(".update-entry")?.textContent.includes("发现新版本")')
    // 遗留文件的提示排在同一轮定时任务里、检查更新之前
    for (let count = 0; shown.length === 0 && count < 200; count++) await delay(50)
    assert.equal(shown.length, 1)
    assert.equal(shown[0].message, '更新已完成，但程序目录里有些文件没能放回原处')
    assert.deepEqual(shown[0].buttons, ['打开备份目录', '确定'])
    assert.match(shown[0].detail ?? '', /项目资料\//)
    assert.equal(existsSync(marker), false, 'the notice is given once')
    // 不是助手会建的那种目录（不在程序目录旁）：不提示，标记作废
    await writeFile(marker, join(root, 'System32') + '\r\nexplorer.exe\r\n')
    await reportLeftoverFiles(target)
    assert.equal(shown.length, 1)
    assert.equal(existsSync(marker), false)
    dialog.showMessageBox = showMessageBox
    console.log('PASS user files kept behind by an update are reported once, and only from a helper backup')
    assert.equal(await js('document.querySelector(".update-dialog").open'), false)
    await open()
    await evaluate('document.querySelector(".update-dialog")?.matches(":modal")')
    assert.match(await js<string>('document.activeElement.textContent.trim()'), /稍后/)
    assert.match(await js<string>('document.querySelector(".update-notes").textContent'), /改善 Windows/)
    assert.equal(await js('document.querySelector(".update-notes img")'), null)
    await press('下载更新')
    await evaluate('document.querySelector("progress")?.value === 4096')
    await press('后台下载')
    await evaluate('!document.querySelector(".update-dialog").open')
    finishDownload()
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
    finishDownload()
    service.dispose()
    window.destroy()
  }
}

main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
