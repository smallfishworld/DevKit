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
import { PluginStore } from '../../src/main/services/plugins/store'
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
  ports: Array<{ options: { baudRate: number }; isOpen: boolean; emit(event: string, bytes: Buffer): void }>
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
    webPreferences: { preload: join(process.cwd(), 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false }
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
    const key = (selector: string, value: string, modifiers: Record<string, boolean> = {}): Promise<void> =>
      js(`(document.querySelector(${JSON.stringify(selector)}) ?? document.body).dispatchEvent(new KeyboardEvent('keydown',
        ${JSON.stringify({ key: value, bubbles: true, cancelable: true, ...modifiers })}))`)
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

    await until(() => has('.toolbox h1', '工具箱'), '工作台已打开')
    await screenshot('toolbox.png')
    await until(() => click('.new-tool'), '加号打开快速工具面板')
    await until(() => js('!!document.querySelector(".tool-launcher[open]")'), '工具启动面板')
    await screenshot('tool-launcher.png')
    await until(() => fill('.launcher-search input', '转换'), '搜索转换工具')
    await key('.launcher-search input', 'ArrowDown')
    await until(() => js('document.querySelector("#launcher-option-1")?.getAttribute("aria-selected") === "true"'), '方向键切换工具')
    await key('.launcher-search input', 'Enter', { isComposing: true })
    assert(await js('!!document.querySelector(".tool-launcher[open]")'), '确认输入法候选时不打开工具')
    await until(() => click('.tool-launcher button', '关闭'), '关闭快速工具面板')
    await key('body', 'k', { ctrlKey: true })
    await until(() => fill('.launcher-search input', '大小端'), 'Ctrl+K 搜索大小端工具')
    await key('.launcher-search input', 'Enter')
    await until(() => fill('input[aria-label="待编码数值"]', '-100'), '输入负数补码')
    await until(() => has('.encoded-result', '9C FF FF FF'), '显示 32 位小端补码')
    await until(() => has('.encoded-result', 'FF 9C'), '显示 16 位大端补码')
    await key('body', 'k', { ctrlKey: true })
    await until(() => fill('.launcher-search input', '时间戳'), '搜索时间戳工具')
    await key('.launcher-search input', 'Enter')
    await until(() => click('.ts-panel .el-radio-button', 'UTC'), '切换日期的 UTC 解析')
    await until(() => fill('.calendar-fields input[type="datetime-local"]', '2025-04-19T10:00:12'), '输入 UTC 日期')
    await until(() => fill('.calendar-fields input[type="number"]', '345'), '输入毫秒字段')
    await until(() => has('.ts-panel .result-grid', String(Date.UTC(2025, 3, 19, 10, 0, 12, 345))), '日期反查保留毫秒')
    await until(() => click('.ts-panel button', '填入左侧解析器'), '同步日期到左侧')
    await until(() => has('.ts-panel .result-grid', '2025-04-19T10:00:12.345Z'), '左侧验证带毫秒的日期')
    await until(() => click('.app-header button', '外观'), '打开无模态外观浮层')
    await until(() => click('.skin-presets button', '浅色纸感'), '切换浅色')
    await until(() => js('document.documentElement.dataset.uiTheme === "term-solarized-light"'), '外观颜色即时生效')
    await until(() => click('.skin-presets button', '深色石墨'), '恢复深色')
    await screenshot('appearance-popover.png')
    await until(() => click('[aria-label="关闭外观浮层"]'), '关闭外观')
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

    const sourceName = liveOfficial ? OFFICIAL_PLUGIN_SOURCE.name : '测试扩展源'
    await until(() => has('.extension-facts', sourceName), '显示安装来源')
    const installedFromDisk = (await new PluginStore(root).listInstalled()).find((plugin) => plugin.name === installName)
    assert.equal(installedFromDisk?.installSource?.name, sourceName, '安装来源可在应用重启后恢复')
    await until(() => click('.extension-install-note summary'), '显示进程隔离说明')
    await until(() => has('.extension-install-note p', '独立进程'), '安装说明可见')
    await screenshot('extension-detail.png')
    await until(() => click('.extension-layout article button', '新建配置'), '新建插件配置')
    const editor = '.el-dialog:has(.el-checkbox)'
    await until(() => fill(editor + ' .el-form > .el-form-item input', configName), '填写实例名称')
    await until(() => click(editor + ' .el-checkbox input:not(:checked)'), '启用自动监听')
    await until(() => click(editor + ' .el-dialog__footer button', '保存配置'), '保存实例')
    try {
      await until(() => has('.instance-row', configName), '显示配置实例')
    } catch (cause) {
      const details = await js(`({
        alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent.trim()).filter(Boolean),
        instances: [...document.querySelectorAll('.instance-row strong')].map(el => el.textContent.trim()),
        name: document.querySelector(${JSON.stringify(editor + ' .el-form > .el-form-item input')})?.value,
        rendererErrors: ${JSON.stringify(failures)}
      })`)
      throw new Error('未显示已保存的配置：' + JSON.stringify(details), { cause })
    }
    await until(() => click('.tab-select', '首页'), '返回工具箱')
    await until(() => js<boolean>(`(() => {
      const tool = [...document.querySelectorAll('.toolbox .tool-row')].find(el => el.querySelector('strong')?.textContent === '串口助手');
      if (!tool) return false;
      tool.click(); return true;
    })()`), '打开串口')
    const editBaud = async (value: string): Promise<void> => {
      await until(() => click('.conn-bar [aria-label="连接参数"]'), '打开连接参数')
      await until(() => click('.conn-fields .conn-field:nth-child(2) .el-select__wrapper'), '打开波特率选项')
      await until(() => click('.connection-editor .el-select-dropdown__item', value), '选择波特率 ' + value)
      await until(async () => !await has('.connection-editor .el-select-dropdown__item', value), '选择后收起波特率菜单')
    }
    await editBaud('9600')
    await until(() => click('.connection-footer button', '取消'), '取消未保存的波特率')
    await until(() => has('.conn-bar [aria-label="连接参数"]', '115200'), '取消后参数仍为 115200')
    await until(() => click('.conn-bar button', '连接'), '连接模拟 COM3')
    await until(() => has('.port-status', '已连接'), '串口以原波特率连接')
    assert.equal(simulated.ports.at(-1)?.options.baudRate, 115200)
    const initialPort = simulated.ports.at(-1)!
    await editBaud('9600')
    await screenshot('serial-connection-settings.png')
    await until(() => click('.connection-footer button', '仅保存'), '连接时仅保存')
    await until(async () => !await has('.connection-editor', '连接参数'), '仅保存后关闭浮层')
    assert.equal(simulated.ports.at(-1), initialPort, '仅保存不关闭当前串口')
    assert(await has('.conn-bar [aria-label="连接参数"]', '115200'), '当前连接仍显示原参数')
    await editBaud('9600')
    await until(() => click('.connection-footer button', '保存并重连'), '应用波特率并重连')
    await until(() => simulated.ports.at(-1) !== initialPort && simulated.ports.at(-1)?.isOpen, '打开新的模拟串口')
    assert.equal(simulated.ports.at(-1)?.options.baudRate, 9600)
    assert.equal(initialPort.isOpen, false)
    await until(() => js('!!document.querySelector(".tab-select[aria-current=page] .tab-dot[data-state=connected]")'), '当前标签显示连接状态')
    await until(() => has('.port-status', '已连接'), '串口已连接')
    win.setContentSize(960, 720)
    await screenshot('serial-workbench-960.png')
    await until(() => click('[aria-label="设备插件"]'), '打开连接栏插件浮层')
    await until(() => click('.plugin-actions .el-select__wrapper'), '展开配置列表')
    await until(() => click('.el-select-dropdown__item', configName), '选择配置')
    await until(() => click('.plugin-actions button', '绑定到当前串口'), '绑定串口')
    await until(() => has('.conn-bar', '监听中'), '独立插件进程已就绪')
    if (!await has('.bound-instance', configName)) {
      await until(() => click('[aria-label="设备插件"]'), '重新打开绑定详情')
    }
    await until(() => has('.bound-instance', 'COM3 · 监听中'), '浮层显示绑定端口和状态')
    await screenshot('serial-plugin-binding.png')
    await until(() => click('.bound-instance button', '配置'), '从当前绑定打开插件配置')
    await until(() => has('.el-dialog__title', '编辑插件配置'), '打开已绑定实例编辑器')
    await closeDialog()
    await until(() => click('[aria-label="设备插件"]'), '打开设备插件')
    await until(() => click('.plugin-links button', '扩展中心'), '从串口查看已绑定实例详情')
    await until(() => has('.instance-row', '已绑定 COM3 · 监听中'), '显示绑定端口与监听状态')
    await until(() => click('.instance-row button', '前往会话'), '返回绑定的串口会话')
    const port = simulated.ports.at(-1)!
    port.emit('data', Buffer.from('PING\r\n'))
    await until(() => sent.includes(liveOfficial ? 'PONG\r\n' : 'PONG'), '真实插件进程接收并返回串口')
    await until(() => click('[aria-label="停止设备插件"]'), '停止并解绑插件')
    await until(() => js<boolean>("!document.querySelector('[aria-label=停止设备插件]')"), '绑定状态清除')
    const before = sent.length
    port.emit('data', Buffer.from('PING\n'))
    await delay(250)
    assert.equal(sent.length, before, '解绑后没有继续回应')

    await until(() => click('.term-opts button', '文件传输'), '打开文件传输配置')
    await until(() => click('.transfer-form button', '选择文件'), '选择待发送文件')
    await until(() => click('.el-dialog__footer button', '开始传输'), '启动 YMODEM 传输')
    await until(() => has('.transfer-strip', 'YMODEM'), '终端内显示传输进度')
    await until(() => click('.transfer-strip button', '取消传输'), '在终端内取消传输')
    await until(async () => !await has('.transfer-strip', 'YMODEM'), '传输取消后提示自动收起')

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
    await closeDialog()
    await until(() => click('[aria-label="关闭 COM3"]'), '关闭串口标签')
    await until(() => click('.tab-select', '首页'), '返回工具箱')
    await until(() => has('.recent-chip', 'COM3'), '显示已关闭串口的最近记录')
    await until(() => click('.recent-chip'), '从最近记录重新打开 COM3')
    await until(() => has('.conn-bar [aria-label="连接参数"]', '9600'), '重新打开时保留参数')
    assert.deepEqual(failures, [])
    if (liveOfficial) console.log('DevKit 官方 HTTPS 索引 → 安装包校验 → 官方插件默认 PING/PONG 用例通过')
    console.log('工作台 UI 通过：工具面板、补码、时区毫秒、换肤、连接草稿与重连、插件入口、传输取消、日志保留')
  } finally {
    await disposeAllPanels()
    win.destroy()
  }
}

main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
