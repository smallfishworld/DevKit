import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import { disposeAllPanels, registerService, registerToolIpc, setMainWindow } from '../../src/main/ipc'
import { setSection } from '../../src/main/services/macro/configStore'
import { PluginService } from '../../src/main/services/plugins'
import { quickCmdsService } from '../../src/main/services/quickcmds'
import { SerialService } from '../../src/main/services/serial'
import { settingsService } from '../../src/main/services/settings'
import { OFFICIAL_PLUGIN_SOURCE } from '../../src/shared/plugins'
import { DEFAULT_SERIAL_CONFIG, DEFAULT_SERIAL_PARAMS } from '../../src/shared/serial'

const root = process.argv[2]
app.setPath('userData', root)

const sourceUrl = 'https://devkit-ui.test/index.json'
const bundleUrl = 'https://devkit-ui.test/responder.json'
const configName = 'UI 测试设备配置'
const liveOfficial = process.env.DEVKIT_OFFICIAL_SOURCE_SMOKE === '1'
const installName = liveOfficial ? '文本 / HEX 自动应答' : '扩展源测试插件'
const sent: string[] = []
const simulated = SerialPort as unknown as {
  ports: Array<{ emit(event: string, bytes: Buffer): void }>
  list: () => Promise<unknown[]>
  prototype: { write: (data: Buffer, done?: (error?: Error) => void) => void }
}

function makeBundle(id: string, name: string): Buffer {
  return Buffer.from(JSON.stringify({
    manifest: {
      id, name, version: '1.0.0', apiVersion: 1, entry: 'index.cjs',
      configSchema: { type: 'object', properties: { response: { type: 'string', default: 'PONG' } } },
      actions: [], autoRespond: true, capabilities: ['serial.read', 'serial.write']
    },
    files: {
      'index.cjs': `exports.activate = ctx => ({
        async onData(event) {
          if (event.text.trim() === 'PING') await ctx.serial.write(ctx.config.response)
        }
      })`
    }
  }))
}

async function until(check: () => unknown | Promise<unknown>, label: string, timeoutMs = 6000): Promise<void> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (await check()) return
    await delay(50)
  }
  throw new Error('等待超时：' + label)
}

async function main(): Promise<void> {
  await app.whenReady()
  simulated.list = async () => [{ path: 'COM3', manufacturer: 'UI fixture' }]
  simulated.prototype.write = (bytes, done) => { sent.push(bytes.toString()); done?.() }
  const filename = join(root, 'local.json')
  await writeFile(filename, makeBundle('devkit.smoke-local', '本地测试插件'))
  Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [filename] }) })

  const remoteBundle = makeBundle('devkit.smoke-source', '扩展源测试插件')
  const sourceIndex = Buffer.from(JSON.stringify({
    version: 1, plugins: [{
      id: 'devkit.smoke-source', name: '扩展源测试插件', version: '1.0.0',
      url: bundleUrl, sha256: createHash('sha256').update(remoteBundle).digest('hex')
    }]
  }))
  const serial = new SerialService()
  const plugins = new PluginService(serial.pluginBridge, [], {
    userData: root,
    hostPath: join(process.cwd(), 'out/main/plugin-host.js'),
    download: liveOfficial ? undefined : async (url) => {
      if (url === sourceUrl) return sourceIndex
      if (url === bundleUrl) return remoteBundle
      throw new Error('测试禁止访问外部网络')
    }
  })
  const serialLogDir = join(root, 'serial-logs')
  await mkdir(serialLogDir)
  const expired = join(serialLogDir, 'COM3-20230101-000000-a1234567.log')
  await writeFile(expired, 'old')
  await utimes(expired, new Date(2023, 0, 1), new Date(2023, 0, 1))
  const exported = join(serialLogDir, 'serial-20230101-000000.log')
  await writeFile(exported, 'keep')
  await utimes(exported, new Date(2023, 0, 1), new Date(2023, 0, 1))
  await setSection('serial', { ...DEFAULT_SERIAL_CONFIG, last: { ...DEFAULT_SERIAL_PARAMS, path: 'COM3' } })
  registerService('serial', serial)
  registerService('plugins', plugins)
  registerService('quickcmds', quickCmdsService)
  registerService('settings', settingsService)
  registerToolIpc()
  ipcMain.handle('win:info', () => ({ version: 'extensions-smoke' }))
  serial.startLogRetention()

  const win = new BrowserWindow({
    width: 1100, height: 820, show: false,
    webPreferences: { preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true }
  })
  setMainWindow(win)
  const failures: string[] = []
  win.webContents.on('console-message', ({ message, level }) => {
    if (level === 'error' && !/WebGL|Autofill/.test(message)) failures.push(message)
  })
  try {
    await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
    const js = <T>(source: string): Promise<T> => win.webContents.executeJavaScript(source)
    const click = (selector: string, name?: string): Promise<boolean> => js(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el =>
        el.getClientRects().length && !el.disabled && (!${JSON.stringify(name ?? '')} ||
          el.textContent.trim() === ${JSON.stringify(name ?? '')}));
      if (!element) return false;
      element.click(); return true;
    })()`)
    const has = (selector: string, text: string): Promise<boolean> => js(`
      [...document.querySelectorAll(${JSON.stringify(selector)})].some(el =>
        el.getClientRects().length && el.textContent.includes(${JSON.stringify(text)}))
    `)
    const fill = (selector: string, value: string, index = 0): Promise<boolean> => js(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(el => el.getClientRects().length)[${index}];
      if (!element) return false;
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`)
    const screenshot = async (filename: string): Promise<void> => {
      const output = process.env.DEVKIT_UI_SMOKE_SCREENSHOTS
      if (!output) return
      await mkdir(output, { recursive: true })
      await delay(350)
      await writeFile(join(output, filename), (await win.capturePage()).toPNG())
    }
    const closeDialog = async (): Promise<void> => {
      await until(() => click('.el-dialog__headerbtn'), '关闭弹窗')
      await delay(360)
    }

    await until(() => click('.app-header button', '扩展'), '打开扩展中心')
    await until(() => click('.extension-center button', '从文件安装…'), '本地安装入口')
    await until(() => click('.el-message-box button', '选择文件'), '选择 JSON 插件包')
    await until(() => has('.extension-layout article', '本地测试插件'), '安装成功后刷新详情')
    await until(() => click('.extension-center button', '扩展源管理'), '打开扩展源管理')
    const officialCard = '.source-card[data-source-kind="official"]'
    const sourceCard = liveOfficial ? officialCard : '.source-card[data-source-kind="custom"]'
    await until(() => has(officialCard, OFFICIAL_PLUGIN_SOURCE.url), '显示预置官方安装索引 URL')
    if (!liveOfficial) {
      await until(() => click('.source-add summary'), '展开扩展源表单')
      await until(() => fill('.source-add input', '测试扩展源'), '填写扩展源名称')
      await until(() => fill('.source-add input', sourceUrl, 1), '填写 HTTPS 索引')
      await until(() => click('.source-add button', '添加扩展源'), '保存扩展源')
    }
    await until(() => click(sourceCard + ' .source-head button', '刷新'), '刷新扩展索引')
    await until(() => has(sourceCard + ' .source-entry', installName), '展示下载条目', 16_000)
    await screenshot('extension-sources.png')
    await until(() => js<boolean>(`(() => {
      const entry = [...document.querySelectorAll(${JSON.stringify(sourceCard + ' .source-entry')})]
        .find(el => el.textContent.includes(${JSON.stringify(installName)}));
      const button = entry?.querySelector('button');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`), '安装索引包')
    await until(() => click('.el-message-box button', '安装'), '确认远端来源')
    await until(() => has('.extension-list', installName), '远端包通过 SHA-256 后安装', 16_000)
    if (!liveOfficial) {
      await until(() => click(sourceCard + ' .source-head button', '移除'), '移除索引源')
      await until(async () => !await has(sourceCard, '测试扩展源'), '索引源移除')
    }
    await closeDialog()
    assert(await has('.extension-list', installName), '安装包仍可使用')
    await until(() => js<boolean>(`(() => {
      const item = [...document.querySelectorAll('.extension-list button')]
        .find(el => el.querySelector('strong')?.textContent === ${JSON.stringify(installName)});
      if (!item) return false;
      item.click(); return true;
    })()`), '选中从源安装的插件')

    await until(() => click('.extension-layout article button', '新建配置'), '新建插件配置')
    await until(() => fill('.el-dialog input[type="text"]', configName), '填写实例名称')
    await until(() => click('.el-dialog .el-checkbox', '绑定后自动监听'), '启用自动监听')
    await until(() => click('.el-dialog__footer button', '保存配置'), '保存实例')
    await until(() => has('.instance-row', configName), '显示配置实例')
    await until(() => click('.tab-select', '首页'), '返回工具箱')
    await until(() => js<boolean>(`(() => {
      const tool = [...document.querySelectorAll('.toolbox .tool-row')].find(el => el.querySelector('strong')?.textContent === '串口助手');
      if (!tool) return false;
      tool.click(); return true;
    })()`), '打开串口')
    await until(() => click('.conn-bar button', '连接'), '连接模拟 COM3')
    await until(() => has('.port-status', '已连接'), '串口已连接')
    await until(() => click('[aria-label="设备插件"]'), '打开连接栏插件浮层')
    await until(() => click('.plugin-actions .el-select__wrapper'), '展开配置列表')
    await until(() => click('.el-select-dropdown__item', configName), '选择配置')
    await until(() => click('.plugin-actions button', '绑定到当前串口'), '绑定串口')
    await until(() => has('.conn-bar', '监听中'), '独立插件进程已就绪')
    await screenshot('serial-plugin-binding.png')
    const port = simulated.ports.at(-1)!
    port.emit('data', Buffer.from('PING\r\n'))
    await until(() => sent.includes(liveOfficial ? 'PONG\r\n' : 'PONG'), '真实插件进程接收并返回串口')
    await until(() => click('[aria-label="停止设备插件"]'), '停止并解绑插件')
    await until(() => js<boolean>("!document.querySelector('[aria-label=停止设备插件]')"), '绑定状态清除')
    const before = sent.length
    port.emit('data', Buffer.from('PING\n'))
    await delay(250)
    assert.equal(sent.length, before, '解绑后没有继续回应')

    await until(() => click('.term-opts button', '日志设置'), '打开日志设置')
    await until(() => has('.log-cleanup', '保留最近 12 个月'), '展示默认 12 个月')
    await until(() => has('.log-cleanup', '移除 1 个'), '启动清理执行完成')
    await screenshot('serial-log-retention.png')
    await assert.rejects(access(expired), { code: 'ENOENT' })
    assert.equal(await readFile(exported, 'utf8'), 'keep')
    await until(() => click('.log-cleanup .el-checkbox'), '关闭自动清理')
    await until(() => click('.log-cleanup button', '保存清理规则'), '保存规则')
    await until(() => has('.log-cleanup', '关闭自动清理'), '展示新规则')
    assert.deepEqual(JSON.parse(await readFile(join(root, 'serial-log-retention.json'), 'utf8')), { enabled: false, months: 12 })
    assert.deepEqual(failures, [])
    if (liveOfficial) console.log('DevKit 官方 HTTPS 索引 → 安装包校验 → 官方插件默认 PING/PONG 用例通过')
    console.log('扩展工作台 UI通过：文件安装、索引下载及校验、绑定/应答/停止、12 个月自动清理与配置持久化')
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
}

main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
