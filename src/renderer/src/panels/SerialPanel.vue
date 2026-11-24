<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowRight,
  Clock,
  Operation,
  Delete,
  Download,
  FolderOpened,
  Plus,
  Refresh,
  Search,
  Setting,
  UploadFilled
} from '@element-plus/icons-vue'
import SerialDevicePlugins from '@renderer/components/SerialDevicePlugins.vue'
import { DEFAULT_LOG_RETENTION, validLogRetention } from '../../../shared/log-retention'
import type { LogRetentionSettings } from '../../../shared/log-retention'
import { stepSendHistory } from '@renderer/components/termInput'
import TerminalView from '@renderer/components/TerminalView.vue'
import TerminalHistory from '@renderer/components/TerminalHistory.vue'
import PluginManager from '@renderer/components/PluginManager.vue'
import { availablePluginActions } from '@renderer/components/plugin-config-form'
import type { PluginDescriptor, PluginInstance, PluginRuntimeStatus } from '../../../shared/plugins'
import { useTerminalStream } from '../composables/useTerminalStream'
import { ByteCounterThrottle } from '../../../shared/terminal-stream'
import QuickCmdManager from '@renderer/components/QuickCmdManager.vue'
import type { SerialConfig, SerialEncoding, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { BAUD_RATES, DEFAULT_SERIAL_PARAMS, normalizeSerialParams } from '../../../shared/serial'
import { normalizePortPath } from '../../../shared/serial-title'
import type { VtGuardStats } from '../../../shared/vtguard'
import type { QuickCmdStep, PluginActionReference, PluginMacroAction } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import { useTabStore } from '@renderer/stores/tabs'

const props = defineProps<{ panelId: string }>()
const emit = defineEmits<{ openExtensions: [] }>()
const tabStore = useTabStore()
const initialSerialParams = tabStore.sessionById(props.panelId)?.serialParams

interface PortInfo {
  path: string
  friendlyName: string
}

interface DataEvt {
  text: string
  bytes: number
  time: number
  rxBytes: number
  txBytes: number
}

// ---------- 状态 ----------
const ports = ref<PortInfo[]>([])
const config = ref<SerialConfig | null>(null)
const params = reactive<SerialParams>({ ...DEFAULT_SERIAL_PARAMS })
const connectionDraft = reactive({ ...DEFAULT_SERIAL_PARAMS, baudRate: DEFAULT_SERIAL_PARAMS.baudRate as number | string })
const activeParams = ref<SerialParams>()
const displayedParams = computed(() => activeParams.value ?? params)
const open = ref(false)
let connectionGeneration = 0
const opening = ref(false)
const rxBytes = ref(0)
const txBytes = ref(0)
/** 字节计数节流：刷屏时每批 data 都写 ref 会频繁触发状态栏重渲，500ms 更新足够 */
const byteCounter = new ByteCounterThrottle((rx, tx) => {
  rxBytes.value = rx
  txBytes.value = tx
})
function updateBytesThrottled(rx: number, tx: number): void { byteCounter.update(rx, tx) }
const dtrOn = ref(false)
const rtsOn = ref(false)
const signals = ref<{ cts: boolean; dsr: boolean; dcd: boolean } | null>(null)
const pluginManagerOpen = ref(false)
const pluginConfigVersion = ref(0)
const pluginStatuses = ref<PluginRuntimeStatus[]>([])
const pluginExecuting = ref('')
const sessionPluginStatuses = computed(() => pluginStatuses.value.filter(status => status.panelId === props.panelId))
const pluginBusy = computed(() => !!pluginExecuting.value || sessionPluginStatuses.value.some(status => status.bound && status.state === 'running'))
async function pluginApi<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.api.invoke('plugins', action, props.panelId, payload) as T & { ok: boolean; error?: string }
  if (!result.ok) throw new Error(result.error || '插件操作失败')
  return result
}
async function refreshPluginStatus(): Promise<void> {
  try {
    const result = await pluginApi<{ statuses: PluginRuntimeStatus[] }>('status')
    pluginStatuses.value = result.statuses
  } catch { /* Plugin manager displays detailed loading failures when opened. */ }
}
async function getPluginActions(): Promise<{ actions: PluginMacroAction[]; error?: string }> {
  try {
    const [catalog, configured, runtime] = await Promise.all([
      pluginApi<{ plugins: PluginDescriptor[] }>('list'),
      pluginApi<{ instances: PluginInstance[] }>('instance:list'),
      pluginApi<{ statuses: PluginRuntimeStatus[] }>('status')
    ])
    pluginStatuses.value = runtime.statuses
    return { actions: availablePluginActions(catalog.plugins, configured.instances, runtime.statuses, props.panelId) }
  } catch (failure) {
    return { actions: [], error: failure instanceof Error ? failure.message : String(failure) }
  }
}
function onPluginsChanged(): void {
  pluginConfigVersion.value++
  void refreshPluginStatus()
}
async function runPluginAction(action: PluginActionReference): Promise<void> {
  if (!open.value) throw new Error('串口未打开')
  if (pluginBusy.value) throw new Error('本串口正在执行动作')
  const generation = connectionGeneration
  pluginExecuting.value = action.instanceId
  stopLoop()
  try {
    const runtime = await pluginApi<{ statuses: PluginRuntimeStatus[] }>('status')
    const status = runtime.statuses.find(item => item.instanceId === action.instanceId)
    if (status?.bound && status.panelId !== props.panelId) throw new Error('此插件配置已绑定到其他串口，请先解除绑定')
    if (!open.value || generation !== connectionGeneration) throw new Error('串口连接已变化，请重新运行')
    await pluginApi('bind', { instanceId: action.instanceId })
    if (!open.value || generation !== connectionGeneration) throw new Error('串口连接已变化，已取消动作')
    await pluginApi('run', action)
  } finally {
    pluginExecuting.value = ''
    await refreshPluginStatus()
  }
}
// ---------- 终端（TerminalView 共享组件：xterm.js 封装） ----------
const termView = ref<InstanceType<typeof TerminalView> | null>(null)
useTerminalStream('serial', props.panelId, termView)
/** 本地回显：设备不回显的裸模块打开后能看到自己敲的字符 */
const localEcho = ref(false)
/** 终端字体族与字号（Ctrl+滚轮 / Ctrl+=/- 缩放） */
const termFont = ref('Consolas')
const termFontSize = ref(13)
/** Serial scrollback preservation is always active, with quiet diagnostics. */
let guardNotified = false
function onGuard(stats: VtGuardStats): void {
  if (guardNotified) return
  guardNotified = true
  const note = stats.eraseScrollback > 0 ? '静默保护终端历史：拦截设备清回滚序列' : '静默保护终端历史：拦截设备硬复位序列'
  void window.api.invoke('serial', 'log:note', props.panelId, { text: note }).catch(() => {})
}
let altScreenNoted = false
function onAltScreen(): void {
  if (altScreenNoted) return
  altScreenNoted = true
  void window.api.invoke('serial', 'log:note', props.panelId, {
    text: '设备进入备用屏模式，重开串口时自动恢复正常终端状态'
  }).catch(() => {})
}
function syncViewVisibility(): void {
  void window.api.invoke('serial', 'view:visible', props.panelId, {
    visible: !document.hidden && tabStore.activeId === props.panelId
  }).catch(() => {})
}
watch(() => tabStore.activeId, syncViewVisibility)
watch([open, opening, displayedParams], ([connected, connecting, current]) => {
  tabStore.setConnection(props.panelId, connected ? 'connected' : connecting ? 'connecting' : 'disconnected', current.path ? { serialParams: { ...current } } : undefined)
}, { deep: true, immediate: true })

const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]


/** 键盘直入：原样发串口（Enter 发 \r，与真实终端一致）；录制时同步记录 */
function onTermData(data: string): void {
  if (!open.value || pluginBusy.value) return
  if (recording.value) recordTermKey(data)
  window.api
    .invoke('serial', 'write', props.panelId, { mode: 'ascii', text: data, newline: 'none' })
    .catch(() => {})
}

const sendMode = ref<'ascii' | 'hex'>('ascii')
const sendText = ref('')
const sendNewline = ref<'none' | 'crlf' | 'lf' | 'cr'>('crlf')
const history = ref<string[]>([])
let historyIndex = -1
let historyDraft = ''

function recallSendHistory(event: KeyboardEvent, direction: 1 | -1): void {
  if (event.isComposing || !history.value.length) return
  event.preventDefault()
  const next = stepSendHistory(history.value, direction, {
    index: historyIndex, draft: historyDraft, text: sendText.value
  })
  historyIndex = next.index
  historyDraft = next.draft
  sendText.value = next.text
}
/** 定时发送面板：非常用功能，默认收起，点「定时」展开 */
const loopPanel = ref(false)
const loopOn = ref(false)
const loopPeriod = ref(1000)
let loopTimer: ReturnType<typeof setInterval> | null = null

const connectionSettings = ref(false)
const connectionSaving = ref(false)
const connectionError = ref('')
/** 连接参数浮层里「已存预设」的当前选中项（只用于选择/删除，不参与命名） */
const presetName = ref('')
/** 「保存为预设」输入的名字；留空则用「端口 @ 波特率」生成 */
const newPresetName = ref('')
/** 删除预设需要点两次（确认框会把连接参数浮层顶掉，故用按钮二次确认） */
const presetDeleteArmed = ref(false)
const logSettings = ref(false)
const logDirectory = ref('')
const retention = reactive({ ...DEFAULT_LOG_RETENTION })
const retentionSaved = ref<LogRetentionSettings>({ ...DEFAULT_LOG_RETENTION })
const retentionLast = ref<{ at: number; removed: number; failed: number }>()
const retentionError = ref('')
const retentionBusy = ref(false)
const parityCode = computed(() => ({ none: 'N', even: 'E', odd: 'O' })[displayedParams.value.parity])

/** 左侧侧栏宽度（快捷命令栏，拖动分隔条调整，重启记忆） */
const sidebarWidth = ref(210)
const { onMouseDown: onSidebarResize } = useSidebarDrag(sidebarWidth, () => void persistConfig())
/** 左侧侧栏（快捷命令栏）显示/隐藏 */
const sidebarHidden = ref(false)
/** 折叠/展开整条侧栏（快捷命令栏一起收起；重启记忆） */
function toggleSidebar(): void {
  sidebarHidden.value = !sidebarHidden.value
  void persistConfig()
}

/** 自动日志开关（会话期间收发自动落盘，默认开启；重启记忆） */
const autoLog = ref(true)
/** 终端时间戳显示（每批数据前插 [HH:MM:SS.mmm]，与日志格式一致；重启记忆） */
const showTime = ref(false)
/** 收发编码：串口线上无编码约定，多数嵌入式设备输出 GBK；切换对打开中的会话即时生效 */
const encoding = ref<SerialEncoding>('utf8')
function onEncodingChange(): void {
  if (config.value) {
    config.value.encoding = encoding.value
    void persistConfig()
  }
  window.api.invoke('serial', 'encoding:set', props.panelId, { encoding: encoding.value }).catch(() => {})
}

let unsubs: Array<() => void> = []
let signalTimer: ReturnType<typeof setInterval> | null = null

const sessions = computed(() => config.value?.sessions ?? [])
/** 顶栏标题：端口号（COM3）；未选端口时显示「串口」 */
const portHeading = computed(() => normalizePortPath(displayedParams.value.path) || '串口')
/** 标签页标题：显示端口号；未选端口时回退工具名 */
function syncTabTitle(path: string): void {
  tabStore.rename(props.panelId, path ? normalizePortPath(path) : '串口助手')
}

// ---------- 快捷命令宏（全局共享，见 composables/useTermMacros） ----------
const { recording, recordTermKey, recordSend, playCmd } = useTermMacros()
const commandManager = ref<InstanceType<typeof QuickCmdManager>>()

/** 宏步骤执行器：串口写法（key 按键按 ASCII 下发） */
function macroWriter(st: QuickCmdStep): void {
  if (st.type === 'key') writeCmd(st.key ?? '', 'ascii', 'none')
  else if (st.mode === 'hex') writeCmd(st.text ?? '', 'hex', 'none')
  else writeCmd(st.text ?? '', 'ascii', st.crlf ? 'crlf' : 'none')
}

// ---------- 文件传输（YMODEM / ZMODEM） ----------
/** 确认小窗（协议已从下拉选好，文件/目录也选好后确认开始） */
const xferDlg = ref(false)
const xferKind = ref<'send' | 'recv'>('send')
const xferProtocol = ref<TransferProtocol>('ymodem')
const xferPath = ref('')
/** 传输进度窗（transfer 事件驱动） */
const transfer = ref<SerialTransferEvt | null>(null)
let transferNoticeTimer: ReturnType<typeof setTimeout> | undefined

const transferring = computed(
  () => !!transfer.value && (transfer.value.state === 'start' || transfer.value.state === 'progress')
)
const transferPct = computed(() => {
  const t = transfer.value
  if (!t || !t.total) return 0
  return Math.min(100, Math.round((t.bytes / t.total) * 100))
})

function openTransfer(): void {
  if (!open.value || transferring.value) return
  xferPath.value = ''
  xferDlg.value = true
}

async function chooseTransferPath(): Promise<void> {
  const kind = xferKind.value
  const action = kind === 'send' ? 'file:pick' : 'file:pick-dir'
  const pick = (await window.api.invoke('serial', action, props.panelId)) as { ok: boolean; path?: string }
  if (pick.ok && pick.path && xferDlg.value && kind === xferKind.value) xferPath.value = pick.path
}

async function startXfer(): Promise<void> {
  if (!open.value || transferring.value || !xferPath.value) return
  xferDlg.value = false
  // 记住本次协议选择（下次默认选中）
  if (config.value) {
    config.value.xferProtocol = xferProtocol.value
    await persistConfig()
  }
  const protoName = xferProtocol.value.toUpperCase()
  if (xferKind.value === 'send') {
    termView.value?.info(`开始 ${protoName} 发送：${xferPath.value}（设备端需先运行接收程序）`)
    window.api
      .invoke('serial', 'file:send', props.panelId, { protocol: xferProtocol.value, path: xferPath.value })
      .catch(() => {})
  } else {
    termView.value?.info(`开始 ${protoName} 接收（设备端需先运行发送程序）`)
    window.api
      .invoke('serial', 'file:recv', props.panelId, { protocol: xferProtocol.value, dir: xferPath.value })
      .catch(() => {})
  }
}

function cancelTransfer(): void {
  void window.api.invoke('serial', 'file:cancel', props.panelId).catch(() => {})
}

function onTransferEvt(p: unknown): void {
  const t = p as SerialTransferEvt
  transfer.value = t
  clearTimeout(transferNoticeTimer)
  if (t.state === 'start' || t.state === 'progress') return
  if (t.state === 'done') {
    const msg = t.dir === 'send' ? `文件发送完成：${t.name}` : `接收完成：${t.name || '(无文件)'}`
    ElMessage.success(msg)
    termView.value?.info(msg)
  } else if (t.state === 'error') {
    ElMessage.error(`传输失败：${t.error}`)
    termView.value?.info(`传输失败：${t.error}`)
  } else if (t.state === 'cancel') {
    termView.value?.info('传输已取消')
  }
  transferNoticeTimer = setTimeout(() => { transfer.value = null }, 1600)
}

// ---------- 初始化 ----------
onMounted(async () => {
  document.addEventListener('visibilitychange', syncViewVisibility)
  syncViewVisibility()
  unsubs.push(
    window.api.on('serial', props.panelId, 'data', (p) => {
      const d = p as DataEvt
      if (typeof d.rxBytes === 'number') updateBytesThrottled(d.rxBytes, d.txBytes)
    }),
    window.api.on('serial', props.panelId, 'tx', (p) => {
      const d = p as DataEvt
      if (typeof d.rxBytes === 'number') updateBytesThrottled(d.rxBytes, d.txBytes)
    }),
    window.api.on('serial', props.panelId, 'status', (p) => {
      const s = p as { open: boolean; error?: string }
      if (open.value !== s.open) connectionGeneration++
      open.value = s.open
      if (!s.open) {
        activeParams.value = undefined
        dtrOn.value = false
        rtsOn.value = false
        signals.value = null
        stopSignalPoll()
        if (s.error) ElMessage.error(`串口已断开：${s.error}`)
      }
    }),
    window.api.on('serial', props.panelId, 'error', (p) => {
      ElMessage.warning(`串口错误：${(p as { message: string }).message}`)
    }),
    window.api.on('plugins', props.panelId, 'changed', onPluginsChanged),
    window.api.on('plugins', props.panelId, 'status', (payload) => {
      const status = payload as PluginRuntimeStatus
      pluginStatuses.value = [...pluginStatuses.value.filter(item => item.instanceId !== status.instanceId), status]
    }),
    window.api.on('serial', props.panelId, 'transfer', onTransferEvt)
  )
  const res = (await window.api.invoke('serial', 'attach', props.panelId)) as {
    config: SerialConfig
  }
  config.value = res.config
  delete (config.value as SerialConfig & { crAsNewline?: boolean }).crAsNewline
  delete (config.value as SerialConfig & { guardScrollback?: boolean }).guardScrollback
  Object.assign(params, res.config.last, initialSerialParams)
  termFont.value = config.value.termFont || 'Consolas'
  termFontSize.value = config.value.termFontSize || 13
  xferProtocol.value = config.value.xferProtocol || 'ymodem'
  autoLog.value = config.value.autoLog !== false
  showTime.value = config.value.showTime === true
  encoding.value = config.value.encoding ?? 'utf8'
  if (config.value.sidebarWidth) sidebarWidth.value = config.value.sidebarWidth
  sidebarHidden.value = config.value.sidebarHidden === true
  termView.value?.info('就绪。选择串口后点击「连接」，终端内可直接输入命令。')
  await refreshPorts()
  // 恢复上次端口时标签标题同步为端口号
  syncTabTitle(params.path)
  await refreshPluginStatus()
})

onUnmounted(() => {
  connectionGeneration++
  document.removeEventListener('visibilitychange', syncViewVisibility)
  unsubs.forEach((u) => u())
  unsubs = []
  byteCounter.dispose()
  clearTimeout(transferNoticeTimer)
  stopLoop()
  stopSignalPoll()
  window.api.invoke('serial', 'dispose', props.panelId).catch(() => {})
})

async function refreshPorts(): Promise<void> {
  ports.value = (await window.api.invoke('serial', 'list', props.panelId)) as PortInfo[]
  // 串口列表带回填 COM 口后，标签随所选端口即时更新（便于开多个窗口区分）
  if (params.path) syncTabTitle(params.path)
}

/** 连接参数草稿复位（不含备注，备注功能已移除） */
function resetConnectionDraft(): void {
  Object.assign(connectionDraft, params)
  presetName.value = ''
  newPresetName.value = ''
  presetDeleteArmed.value = false
  connectionError.value = ''
}

/** 选中已存预设：把该预设的完整参数套进草稿（不直接连接） */
function applyPreset(name: string | undefined): void {
  presetDeleteArmed.value = false
  const preset = sessions.value.find((item) => item.name === name)
  if (!preset) return
  Object.assign(connectionDraft, preset.params)
  connectionError.value = ''
}

async function saveConnection(reconnect: boolean): Promise<void> {
  if (connectionSaving.value || opening.value) return
  const next = normalizeSerialParams(connectionDraft)
  if (!next) {
    connectionError.value = '请选择串口，波特率须为 1–12000000 的整数。'
    return
  }
  connectionSaving.value = true
  connectionError.value = ''
  try {
    await persistConfig(next)
    Object.assign(params, next)
    if (reconnect && open.value) await closePort()
    connectionSettings.value = false
    if (reconnect) await openPort()
    // 端口可能刚换过：按新端口刷新标签标题
    syncTabTitle(next.path)
  } catch (error) {
    connectionError.value = String(error)
  } finally {
    connectionSaving.value = false
  }
}

// ---------- 开关串口 ----------
async function openPort(): Promise<void> {
  if (!params.path) {
    ElMessage.warning('请选择串口')
    return
  }
  if (opening.value || open.value) return
  const requested = { ...params }
  opening.value = true
  // 必须在下发 open 之前复位：open 一返回主进程就可能推出新会话的数据，
  // 那时终端若还停在上个会话遗留的备用屏里，这批数据会画进备用屏、随复位一起消失。
  // 上个会话可能停在备用屏里（vi/top 被打断）或残留模式未复位：拉回主屏+软复位，
  // 但不碰回滚内容（设备随后自己发的清屏仍会按正常 VT 语义执行）
  termView.value?.resetVtState()
  const res = (await window.api.invoke('serial', 'open', props.panelId, requested).catch((error: unknown) => ({
    ok: false, error: String(error)
  }))) as { ok: boolean; error?: string }
  opening.value = false
  if (res.ok) {
    activeParams.value = requested
    open.value = true
    dtrOn.value = true
    rtsOn.value = true
    // 重开串口 = 新会话：防护提示/洪泛提示按新会话重置
    guardNotified = false
    altScreenNoted = false
    // 真正拉高 DTR/RTS（仅改 UI 状态不下发时，部分需要复位才能工作的设备会卡住）
    await window.api.invoke('serial', 'dtr', props.panelId, { on: true }).catch(() => {})
    await window.api.invoke('serial', 'rts', props.panelId, { on: true }).catch(() => {})
    termView.value?.info(`已打开 ${params.path} @ ${params.baudRate}，终端内可直接输入`)
    syncTabTitle(params.path)
    void persistConfig().catch((error: unknown) => ElMessage.warning(String(error)))
    startSignalPoll()
    termView.value?.focus()
  } else {
    ElMessage.error(`打开失败：${res.error}`)
  }
}

async function closePort(): Promise<void> {
  connectionGeneration++
  stopSignalPoll()
  await window.api.invoke('serial', 'close', props.panelId)
  open.value = false
  activeParams.value = undefined
  syncTabTitle(params.path)
  termView.value?.info('已断开')
}

function startSignalPoll(): void {
  stopSignalPoll()
  signalTimer = setInterval(async () => {
    const res = (await window.api.invoke('serial', 'signals', props.panelId)) as {
      ok: boolean
      cts?: boolean
      dsr?: boolean
      dcd?: boolean
    }
    if (res.ok) {
      signals.value = { cts: !!res.cts, dsr: !!res.dsr, dcd: !!res.dcd }
    }
  }, 2000)
}

function stopSignalPoll(): void {
  if (signalTimer) {
    clearInterval(signalTimer)
    signalTimer = null
  }
}

async function toggleDtr(): Promise<void> {
  dtrOn.value = !dtrOn.value
  await window.api.invoke('serial', 'dtr', props.panelId, { on: dtrOn.value })
}

async function toggleRts(): Promise<void> {
  rtsOn.value = !rtsOn.value
  await window.api.invoke('serial', 'rts', props.panelId, { on: rtsOn.value })
}

// ---------- 发送 ----------
function doSend(text: string, mode: 'ascii' | 'hex', newline: 'none' | 'crlf' | 'lf' | 'cr'): void {
  if (pluginBusy.value) {
    ElMessage.warning('插件动作正在使用此串口')
    return
  }
  if (!open.value) {
    ElMessage.warning('串口未打开')
    return
  }
  // 录制：发送栏整条发送记为一个命令步骤
  recordSend(text, mode, newline !== 'none')
  writeCmd(text, mode, newline)
  if (text.trim() && !history.value.includes(text)) {
    history.value.unshift(text)
    if (history.value.length > 20) history.value.pop()
  }
}

/** 实际下发（不含录制/历史逻辑，快捷命令回放也走这里） */
function writeCmd(text: string, mode: 'ascii' | 'hex', newline: 'none' | 'crlf' | 'lf' | 'cr'): void {
  window.api
    .invoke('serial', 'write', props.panelId, { mode, text, newline })
    .then((res) => {
      const r = res as { ok: boolean; error?: string }
      if (!r.ok) ElMessage.error(r.error)
    })
    .catch(() => {})
}

function sendFromKeyboard(event: KeyboardEvent): void {
  if (event.isComposing) return
  event.preventDefault()
  send()
}

function send(): void {
  doSend(sendText.value, sendMode.value, sendNewline.value)
  historyIndex = -1
}

function startLoop(): void {
  if (loopOn.value || pluginBusy.value) return
  if (!sendText.value.trim()) {
    ElMessage.warning('请先填写发送内容')
    return
  }
  loopOn.value = true
  const text = sendText.value
  const mode = sendMode.value
  const nl = sendNewline.value
  doSend(text, mode, nl)
  loopTimer = setInterval(() => doSend(text, mode, nl), Math.max(20, loopPeriod.value))
}

function stopLoop(): void {
  loopOn.value = false
  if (loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}

// ---------- 终端 ----------
/** 工具栏「查找」按钮：展开终端查找栏（等效 Ctrl+F） */
function openTermSearch(): void {
  termView.value?.openSearch()
}

function clearTerm(): void {
  void window.api.invoke('serial', 'output:clear', props.panelId).catch((error) => ElMessage.error(String(error)))
}

function saveLog(): void {
  // 从磁盘按块导出，日志正文不经渲染端。
  void window.api
    .invoke('serial', 'log:mem-save', props.panelId)
    .then((res) => {
      const r = res as { ok: boolean; error?: string }
      if (r.ok) ElMessage.success('日志已保存')
      else if (r.error && r.error !== '已取消') ElMessage.warning(`存日志失败：${r.error}`)
    })
    .catch(() => {})
}

async function openLogSettings(): Promise<void> {
  logSettings.value = true
  retentionBusy.value = true
  retentionError.value = ''
  try {
    const [directory, cleanup] = await Promise.all([
      window.api.invoke('serial', 'log:get-dir', props.panelId) as Promise<{ dir?: string }>,
      window.api.invoke('serial', 'log:retention:get', props.panelId) as Promise<{
        settings: LogRetentionSettings
        last?: { at: number; removed: number; failed: number }
      }>
    ])
    logDirectory.value = directory.dir ?? ''
    if (validLogRetention(cleanup.settings)) {
      Object.assign(retention, cleanup.settings)
      retentionSaved.value = cleanup.settings
    }
    retentionLast.value = cleanup.last
  } catch (e) { retentionError.value = (e as Error).message }
  finally { retentionBusy.value = false }
}

async function saveLogRetention(): Promise<void> {
  if (!validLogRetention(retention) || retentionBusy.value) return
  retentionBusy.value = true
  retentionError.value = ''
  try {
    const result = await window.api.invoke('serial', 'log:retention:set', props.panelId, { ...retention }) as {
      ok: boolean; error?: string; settings: LogRetentionSettings
    }
    if (!result.ok) throw new Error(result.error || '保存失败')
    retentionSaved.value = result.settings
    ElMessage.success('清理规则已保存')
  } catch (e) { retentionError.value = (e as Error).message }
  finally { retentionBusy.value = false }
}

function openLogDir(): void {
  void window.api.invoke('serial', 'log:open-dir', props.panelId).catch(() => {})
}

/** 设置手动「存日志」的保存目录（重启记忆） */
async function setLogDir(): Promise<void> {
  const res = (await window.api.invoke('serial', 'log:set-dir', props.panelId)) as {
    ok: boolean
    dir?: string
    error?: string
  }
  if (res.ok && res.dir) {
    logDirectory.value = res.dir
    if (config.value) config.value.logDir = res.dir
    ElMessage.success(`日志保存目录已设为：${res.dir}（新会话生效）`)
  }
}

// ---------- 会话与配置 ----------
async function persistConfig(nextParams: SerialParams = params): Promise<void> {
  if (!config.value) return
  const updated: SerialConfig = {
    ...config.value,
    last: { ...nextParams },
    termFont: termFont.value,
    termFontSize: termFontSize.value,
    autoLog: autoLog.value,
    showTime: showTime.value,
    encoding: encoding.value,
    sidebarWidth: sidebarWidth.value,
    sidebarHidden: sidebarHidden.value
  }
  await window.api.invoke('serial', 'config:set', props.panelId, JSON.parse(JSON.stringify(updated)))
}

/** 把连接参数浮层里的当前草稿存成预设：选中预设时直接覆盖，未选中时询问名字。 */
async function savePreset(): Promise<void> {
  if (!config.value) return
  const next = normalizeSerialParams(connectionDraft)
  if (!next) {
    connectionError.value = '请选择串口，波特率须为 1–12000000 的整数。'
    return
  }
  const name = newPresetName.value.trim() || `${next.path} @ ${next.baudRate}`
  const list = config.value.sessions.filter((s) => s.name !== name)
  list.unshift({ name, params: { ...next } })
  config.value.sessions = list
  presetName.value = name
  newPresetName.value = ''
  await persistConfig()
  ElMessage.success(`预设「${name}」已保存`)
}

/** 第一次点击进入待确认状态，再点一次才真正删除 */
function requestDeletePreset(): void {
  if (!presetDeleteArmed.value) {
    presetDeleteArmed.value = true
    return
  }
  void deletePreset()
}

async function deletePreset(): Promise<void> {
  presetDeleteArmed.value = false
  const name = presetName.value.trim()
  const preset = sessions.value.find((item) => item.name === name)
  if (!preset || !config.value) return
  config.value.sessions = config.value.sessions.filter((item) => item.name !== name)
  presetName.value = ''
  await persistConfig()
  ElMessage.success(`预设「${name}」已删除`)
}

</script>

<template>
  <div class="panel serial-panel">
    <header class="conn-bar">
      <div class="conn-group">
        <h1 :title="displayedParams.path">{{ portHeading }}</h1>
        <el-popover v-model:visible="connectionSettings" placement="bottom-start" :width="440" trigger="click" @before-enter="resetConnectionDraft">
          <template #reference>
            <el-button size="small" :aria-expanded="connectionSettings" aria-label="连接参数" :disabled="opening || connectionSaving">
              {{ displayedParams.baudRate }} · {{ displayedParams.dataBits }}{{ parityCode }}{{ displayedParams.stopBits }} ▾
            </el-button>
          </template>
          <section class="connection-editor" aria-label="连接参数" @keydown.esc="!connectionSaving && (connectionSettings = false)">
            <h2>连接参数</h2>
            <p class="hint">{{ open ? '保存并重连会结束当前连接。仅保存会在下次连接时使用新参数。' : '选择串口并确认连接参数。' }}</p>
            <fieldset class="conn-fields" :disabled="connectionSaving || opening">
              <div class="conn-field conn-preset-field"><span>已存预设</span>
                <div class="conn-preset-row">
                  <el-select v-model="presetName" :teleported="false" size="small" filterable
                    clearable placeholder="选择已存预设套用参数" aria-label="已存预设"
                    @change="(name: string) => name && applyPreset(name)">
                    <el-option v-for="preset in sessions" :key="preset.name" :value="preset.name"
                      :label="`${preset.name}（${preset.params.path} @ ${preset.params.baudRate}）`" />
                  </el-select>
                  <el-button size="small" :type="presetDeleteArmed ? 'danger' : undefined"
                    :icon="presetDeleteArmed ? undefined : Delete"
                    :aria-label="presetDeleteArmed ? '确认删除所选预设' : '删除所选预设'"
                    :title="presetDeleteArmed ? '再点一次确认删除' : '删除所选预设'"
                    :disabled="!presetName" @click="requestDeletePreset">
                    <span v-if="presetDeleteArmed">确认</span>
                  </el-button>
                </div>
              </div>
              <div class="conn-field conn-save-as-field"><span>保存为预设</span>
                <div class="conn-port-field">
                  <el-input v-model="newPresetName" size="small" maxlength="24" clearable
                    :placeholder="`留空则用 ${connectionDraft.path || '端口'} @ ${connectionDraft.baudRate}`"
                    aria-label="新预设名" @keydown.enter.prevent="savePreset" />
                  <el-button size="small" :icon="Plus" aria-label="保存预设" title="把上面的参数保存为预设（同名覆盖）"
                    :disabled="!connectionDraft.path" @click="savePreset" />
                </div>
              </div>
              <div class="conn-field"><span>串口</span>
                <div class="conn-port-field">
                  <el-select v-model="connectionDraft.path" :teleported="false" placeholder="选择串口" aria-label="串口" size="small">
                    <el-option v-for="port in ports" :key="port.path" :value="port.path"
                      :label="[port.path, port.friendlyName].filter(Boolean).join(' · ')" />
                  </el-select>
                  <el-button size="small" :icon="Refresh" aria-label="刷新串口列表" @click="refreshPorts" />
                </div>
              </div>
              <div class="conn-field"><span>波特率</span>
                <el-select v-model="connectionDraft.baudRate" :teleported="false" aria-label="波特率" size="small"
                  filterable allow-create default-first-option>
                  <el-option v-for="baud in BAUD_RATES" :key="baud" :value="baud" :label="String(baud)" />
                </el-select>
              </div>
              <div class="conn-field"><span>数据位</span>
                <el-select v-model="connectionDraft.dataBits" :teleported="false" aria-label="数据位" size="small">
                  <el-option :value="7" label="7 位" />
                  <el-option :value="8" label="8 位" />
                </el-select>
              </div>
              <div class="conn-field"><span>校验</span>
                <el-select v-model="connectionDraft.parity" :teleported="false" aria-label="校验位" size="small">
                  <el-option value="none" label="无校验" />
                  <el-option value="even" label="偶校验" />
                  <el-option value="odd" label="奇校验" />
                </el-select>
              </div>
              <div class="conn-field"><span>停止位</span>
                <el-select v-model="connectionDraft.stopBits" :teleported="false" aria-label="停止位" size="small">
                  <el-option :value="1" label="1 停止" />
                  <el-option :value="2" label="2 停止" />
                </el-select>
              </div>
              <el-checkbox v-model="connectionDraft.rtscts" size="small">RTS/CTS</el-checkbox>
            </fieldset>
            <p v-if="connectionError" class="hint" role="alert">{{ connectionError }}</p>
            <div class="connection-footer">
              <el-button :disabled="connectionSaving" @click="connectionSettings = false">取消</el-button>
              <el-button :disabled="opening || connectionSaving" @click="saveConnection(false)">仅保存</el-button>
              <el-button type="primary" :loading="connectionSaving" :disabled="opening" @click="saveConnection(true)">{{ open ? '保存并重连' : '保存并连接' }}</el-button>
            </div>
          </section>
        </el-popover>
        <span class="port-status" :class="{ online: open }">{{ open ? '已连接' : opening ? '连接中' : '未连接' }}</span>
        <el-button v-if="open" size="small" :disabled="opening || connectionSaving" @click="closePort">断开</el-button>
        <el-button v-else size="small" type="primary" :loading="opening" :disabled="connectionSaving" @click="params.path ? openPort() : (connectionSettings = true)">连接</el-button>
      </div>
      <div class="conn-group">
      <el-popover placement="bottom-end" :width="280" trigger="click">
        <template #reference><el-button text size="small" :icon="Operation">DTR · RTS</el-button></template>
        <div class="conn-group">
        <el-button size="small" :disabled="!open" :type="dtrOn ? 'warning' : 'default'" @click="toggleDtr">
          DTR {{ dtrOn ? '高' : '低' }}
        </el-button>
        <el-button size="small" :disabled="!open" :type="rtsOn ? 'warning' : 'default'" @click="toggleRts">
          RTS {{ rtsOn ? '高' : '低' }}
        </el-button>
        <span v-if="signals" class="sig">
          <el-tag size="small" :type="signals.cts ? 'success' : 'info'">CTS</el-tag>
          <el-tag size="small" :type="signals.dsr ? 'success' : 'info'">DSR</el-tag>
          <el-tag size="small" :type="signals.dcd ? 'success' : 'info'">DCD</el-tag>
        </span>
        </div>
      </el-popover>
        <SerialDevicePlugins :panel-id="props.panelId" :connected="open" @manage="pluginManagerOpen = true" @extensions="emit('openExtensions')" />
      </div>
    </header>

    <div class="body">
      <!-- 快捷命令宏（全局共享）；宽度可拖动调整，可整体折叠/展开。
           连接参数的「已存预设」收进了连接栏的浮层里，这里不再单列一块。 -->
        <div v-if="!sidebarHidden" class="sessions" :style="{ width: sidebarWidth + 'px' }">
          <QuickCmdManager
            ref="commandManager"
            :enabled="open"
            :writer="macroWriter"
            :get-connection-generation="() => connectionGeneration"
            :run-plugin-action="runPluginAction"
            :get-plugin-actions="getPluginActions"
            :plugin-config-version="pluginConfigVersion"
            @request-plugin-config="pluginManagerOpen = true"
          />
        </div>

        <!-- 拖动调整侧栏宽度（VS Code 式分隔条）；中央折叠把手，与 SSH 页一致 -->
        <div v-if="!sidebarHidden" class="sidebar-split" title="拖动调整宽度" @mousedown="onSidebarResize">
          <button class="split-toggle" title="折叠快捷命令栏" @mousedown.stop @click="toggleSidebar">
            <svg viewBox="0 0 8 12" width="7" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 1L1.5 6l5 5" />
            </svg>
          </button>
        </div>

      <!-- 折叠后的细条：点击展开侧栏 -->
      <div v-else class="sidebar-collapsed" title="展开快捷命令栏" @click="toggleSidebar">
        <el-icon :size="16"><ArrowRight /></el-icon>
      </div>

      <!-- 终端 + 发送 -->
      <div class="term-col">
        <div class="term-opts" role="group" aria-label="终端操作">
          <div class="term-group" role="group" aria-label="终端输出">
            <el-button size="small" text :icon="Search" title="查找（Ctrl+F）" @click="openTermSearch">查找</el-button>
            <el-button size="small" text @click="clearTerm">清屏</el-button>
          </div>
          <div class="term-group" role="group" aria-label="日志">
            <el-button size="small" text :icon="Download" @click="saveLog">保存日志</el-button>
            <TerminalHistory tool="serial" :panel-id="props.panelId" />
            <el-button size="small" text :icon="FolderOpened" @click="openLogSettings">日志设置</el-button>
          </div>
          <el-button size="small" text :icon="UploadFilled" :disabled="!open || transferring" @click="openTransfer">文件传输</el-button>
          <el-button v-if="recording" class="stop-recording" size="small" text type="danger" @click="commandManager?.finishRecording()">停止录制</el-button>
          <el-popover placement="bottom-end" :width="310" trigger="click">
            <template #reference>
              <el-button class="display-action" size="small" text :icon="Setting">显示设置</el-button>
            </template>
            <div class="display-settings">
          <span>字体</span>
          <el-tooltip content="终端字体（可手输系统内已安装的字体名）" placement="top">
            <el-select
              v-model="termFont"
              size="small"
              filterable
              allow-create
              style="width: 132px"
            >
              <el-option value="Consolas" label="Consolas" />
              <el-option value="Cascadia Mono" label="Cascadia Mono" />
              <el-option value="Courier New" label="Courier New" />
              <el-option value="SimSun" label="宋体" />
            </el-select>
          </el-tooltip>
          <span>字号</span>
          <el-tooltip content="字号（Ctrl+滚轮 或 Ctrl+= / Ctrl+- / Ctrl+0 缩放）" placement="top">
            <el-select v-model="termFontSize" size="small" filterable style="width: 74px">
              <el-option v-for="s in TERM_SIZES" :key="s" :value="s" :label="String(s)" />
            </el-select>
          </el-tooltip>
          <el-tooltip content="设备不回显的裸模块勾选后，终端可看到自己敲入的字符" placement="top">
            <el-checkbox v-model="localEcho" size="small">本地回显</el-checkbox>
          </el-tooltip>
          <el-tooltip content="每行前显示本地时间 [HH:MM:SS.mmm]，与日志落盘格式一致" placement="top">
            <el-checkbox v-model="showTime" size="small" @change="persistConfig()">时间戳</el-checkbox>
          </el-tooltip>
          <span>接收编码</span>
          <el-tooltip content="串口线上字节的编码：多数嵌入式设备输出 GBK，选错时中文显示乱码 / ？；对打开中的会话即时生效" placement="top">
            <el-select v-model="encoding" size="small" style="width: 88px" @change="onEncodingChange">
              <el-option value="utf8" label="UTF-8" />
              <el-option value="gbk" label="GBK" />
            </el-select>
          </el-tooltip>
            </div>
          </el-popover>
        </div>
        <div v-if="transfer" class="transfer-strip">
          <strong>{{ transfer.protocol.toUpperCase() }} · {{ transfer.dir === 'send' ? '发送' : '接收' }}</strong>
          <span class="xfer-name" :title="transfer.name">{{ transfer.name || '等待设备端…' }}</span>
          <el-progress :percentage="transferPct" :indeterminate="transferring && !transfer.total"
            :status="transfer.state === 'error' ? 'exception' : transfer.state === 'done' ? 'success' : undefined" />
          <span v-if="!transfer.total && transferring" class="hint">协商中…</span>
          <el-button v-if="transferring" size="small" text type="danger" @click="cancelTransfer">取消传输</el-button>
        </div>
        <el-dialog v-model="logSettings" title="会话日志设置" width="min(420px, 95vw)" append-to-body>
          <el-checkbox v-model="autoLog" @change="persistConfig()">自动保存会话日志</el-checkbox>
          <p class="hint">自动保存设置在新会话中生效。</p>
          <el-input :model-value="logDirectory" readonly aria-label="自动日志目录" placeholder="读取日志目录…" />
          <div class="panel-row log-dir-actions">
            <el-button size="small" @click="setLogDir">设置保存路径</el-button>
            <el-button size="small" @click="openLogDir">打开保存路径</el-button>
          </div>
          <section class="log-cleanup">
            <h3>历史日志自动清理</h3>
            <el-checkbox v-model="retention.enabled" :disabled="retentionBusy">自动清理过期归档日志</el-checkbox>
            <el-form label-position="top" @submit.prevent="saveLogRetention">
              <el-form-item label="保留最近月数（1–120）">
                <el-input-number v-model="retention.months" :min="1" :max="120" :step="1" step-strictly :disabled="retentionBusy || !retention.enabled" />
              </el-form-item>
              <p class="hint">启动后及每 24 小时检查。按最后写入时间判断，正在使用的归档和手动导出文件会跳过。</p>
              <p class="hint" role="status">{{ retentionSaved.enabled ? `已保存：保留最近 ${retentionSaved.months} 个月` : '已保存：关闭自动清理' }}</p>
              <p v-if="retentionLast" class="hint">上次清理 {{ new Date(retentionLast.at).toLocaleString() }} · 移除 {{ retentionLast.removed }} 个 · 失败 {{ retentionLast.failed }} 个</p>
              <el-alert v-if="retentionError" :title="retentionError" type="error" :closable="false" role="alert" />
              <el-button native-type="submit" size="small" :loading="retentionBusy" :disabled="!validLogRetention(retention)">保存清理规则</el-button>
            </el-form>
          </section>
          <template #footer><el-button type="primary" @click="logSettings = false">完成</el-button></template>
        </el-dialog>
        <TerminalView
          ref="termView"
          v-model:font-size="termFontSize"
          :font="termFont"
          :local-echo="localEcho && !pluginBusy"
          :show-time="showTime"
          :guard-scrollback="true"
          :history-panel-id="props.panelId"
          @data="onTermData"
          @guard="onGuard"
          @altscreen="onAltScreen"
        />

        <div class="send-bar">
          <el-select
            v-model="sendMode"
            size="small"
            style="width: 82px"
            :disabled="loopOn"
          >
            <el-option value="ascii" label="ASCII" />
            <el-option value="hex" label="HEX" />
          </el-select>
          <el-select
            v-model="sendNewline"
            size="small"
            style="width: 92px"
            :disabled="loopOn"
          >
            <el-option value="none" label="无换行" />
            <el-option value="crlf" label="CRLF" />
            <el-option value="lf" label="LF" />
            <el-option value="cr" label="CR" />
          </el-select>
          <el-input
            v-model="sendText"
            size="small"
            class="send-input mono"
            aria-label="发送内容"
            :placeholder="sendMode === 'hex' ? 'HEX：AA BB 01' : '输入命令，Enter 发送 · ↑↓ 调取历史'"
            :disabled="loopOn"
            @input="historyIndex = -1"
            @keydown.up.exact="recallSendHistory($event, 1)"
            @keydown.down.exact="recallSendHistory($event, -1)"
            @keydown.enter.exact="sendFromKeyboard"
            @keydown.ctrl.enter="sendFromKeyboard"
          >
            <template #suffix>
              <el-dropdown trigger="click" :disabled="!history.length || loopOn" @command="(cmd: string) => (sendText = cmd)">
                <el-button text size="small" :icon="Clock" :disabled="!history.length || loopOn" aria-label="选择发送历史" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="h in history" :key="h" :command="h">{{ h.slice(0, 60) }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-input>
          <el-button type="primary" size="small" :disabled="!open || loopOn" @click="send">发送</el-button>
          <!-- 定时发送：默认收起，点「定时」展开 -->
          <el-tooltip content="定时循环发送（非常用功能，展开后可用）" placement="top">
            <el-button
              size="small"
              :type="loopOn ? 'danger' : loopPanel ? 'warning' : 'default'"
              @click="loopOn ? stopLoop() : (loopPanel = !loopPanel)"
            >
              {{ loopOn ? '停止循环' : '定时' }}
            </el-button>
          </el-tooltip>
          <template v-if="loopPanel && !loopOn">
            <el-input-number
              v-model="loopPeriod"
              :min="20"
              :step="100"
              size="small"
              style="width: 100px"
            />
            <el-button size="small" @click="startLoop">循环</el-button>
          </template>
        </div>
      </div>
    </div>

    <footer class="serial-status">
      <span class="serial-status-summary">{{ displayedParams.path || '串口' }} · {{ open ? '已连接' : '未连接' }}</span>
      <span>RX <b>{{ rxBytes }}</b> B</span>
      <span>TX <b>{{ txBytes }}</b> B</span>
      <span>{{ autoLog ? '保留日志' : '临时日志' }}</span>
    </footer>

    <el-dialog v-model="xferDlg" title="串口文件传输" width="min(460px, 95vw)" append-to-body>
      <el-form label-position="top" size="small" class="transfer-form" @submit.prevent="startXfer">
        <el-form-item label="传输协议">
          <el-select v-model="xferProtocol" aria-label="传输协议">
            <el-option label="YMODEM" value="ymodem" />
            <el-option label="ZMODEM" value="zmodem" />
          </el-select>
        </el-form-item>
        <el-form-item label="方向">
          <el-select v-model="xferKind" aria-label="方向" @change="xferPath = ''">
            <el-option label="发送到设备" value="send" />
            <el-option label="从设备接收" value="recv" />
          </el-select>
        </el-form-item>
        <el-form-item class="transfer-path" :label="xferKind === 'send' ? '本地文件' : '接收保存目录'">
          <el-input :model-value="xferPath" readonly>
            <template #append><el-button @click="chooseTransferPath">{{ xferKind === 'send' ? '选择文件' : '选择目录' }}</el-button></template>
          </el-input>
        </el-form-item>
      </el-form>
      <div class="hint">
        {{
          xferKind === 'send'
            ? '电脑 → 设备：设备端需先运行接收程序（YMODEM 用 ry，ZMODEM 用 rz）'
            : '设备 → 电脑：设备端需先运行发送程序（YMODEM 用 sy，ZMODEM 用 sz）'
        }}
      </div>
      <template #footer>
        <el-button @click="xferDlg = false">取消</el-button>
        <el-button type="primary" :disabled="!xferPath || !open || transferring" @click="startXfer">开始传输</el-button>
      </template>
    </el-dialog>

    <PluginManager
      v-model:visible="pluginManagerOpen"
      :panel-id="props.panelId"
      :connected="open"
      @changed="onPluginsChanged"
    />
  </div>
</template>

<style scoped>
.serial-panel { height:100%; overflow:hidden; padding:0; gap:0; container-type:inline-size; }
.mono { font-family:var(--font-mono); }
.hint { font-size:12px; color:var(--el-text-color-secondary); }
.conn-bar, .conn-group { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
/* 顶部连接栏：高度由内边距撑开（约 40px），标题与按钮不再贴着上下边框 */
.conn-bar { justify-content:space-between; flex:none; padding:9px 14px; background:var(--el-bg-color-overlay); border-bottom:1px solid var(--el-border-color-lighter); }
.conn-bar h1 { margin:0 2px 0 0; font:600 14px var(--font-mono); }
.conn-fields { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; border:0; padding:0; margin:0; min-width:0; }
.conn-field { display:grid; gap:3px; color:var(--el-text-color-secondary); font-size:12px; }
.conn-fields > .el-checkbox { align-self:end; }
.conn-port-field { display:flex; gap:4px; }
.conn-port-field .el-select { min-width:0; }
.port-status { padding:2px 8px; border-radius:20px; font-size:12px; background:var(--el-fill-color); }
.port-status.online { color:var(--el-color-success); background:var(--el-color-success-light-9); }
.sig { display:inline-flex; gap:4px; }
.body { display:flex; flex:1; min-height:0; position:relative; }
.connection-editor h2 { font-size:14px; margin:0; }
.connection-editor .hint { margin:6px 0 10px; }
.connection-footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; margin-top:10px; }
.connection-footer .el-button { margin:0; }
/* 顶部内边距与 .term-opts 的 7px 对齐：两侧第一行（快捷命令标题 / 查找工具栏）落在同一水平线上 */
.sessions { display:flex; flex-direction:column; flex:none; min-width:150px; max-width:27%; padding:7px 12px 14px; overflow:hidden; background:var(--el-bg-color-overlay); }
.sidebar-split { flex:0 0 4px; margin:0 -2px; cursor:col-resize; border-radius:2px; position:relative; z-index:5; }
.sidebar-split:hover { background:var(--el-color-primary); opacity:.5; }
/* 分隔条中央的折叠把手：默认近乎隐没，悬停才浮出（同 SshPanel） */
.split-toggle { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:12px; height:32px; display:flex; align-items:center; justify-content:center; padding:0; background:transparent; border:1px solid transparent; border-radius:6px; color:var(--el-text-color-placeholder); opacity:.45; cursor:pointer; transition:opacity .15s ease, background .15s ease, border-color .15s ease, color .15s ease; z-index:6; }
.sidebar-split:hover .split-toggle { opacity:1; }
.split-toggle:hover { background:var(--el-color-primary-light-9); border-color:var(--el-color-primary-light-7); color:var(--el-color-primary); }
/* 折叠后的细条：占 16px，点击展开 */
.sidebar-collapsed { flex:0 0 auto; width:16px; align-self:stretch; display:flex; align-items:center; justify-content:center; border-right:1px solid var(--el-border-color-lighter); color:var(--el-text-color-secondary); cursor:pointer; transition:background .15s ease; }
.sidebar-collapsed:hover { background:var(--el-fill-color); color:var(--el-color-primary); }
/* 已存预设占满一行 + 下方一条分隔线：它是「先套参数再改细节」的入口，不与单个字段并排 */
.conn-preset-field { grid-column:1/-1; padding-bottom:9px; border-bottom:1px dashed var(--el-border-color-lighter); }
.conn-preset-row { display:flex; gap:4px; }
.conn-preset-row .el-select { flex:1; min-width:0; }
.conn-save-as-field { grid-column:1/-1; }
.term-col { flex:1; display:flex; flex-direction:column; min-width:0; }
.term-col :deep(.term) { border:0; border-radius:0; box-shadow:none; padding:12px 14px; }
.term-col :deep(.search-bar) { margin:0; border-radius:0; border-width:0 0 1px; }
.term-opts, .term-group { display:flex; align-items:center; flex-wrap:wrap; gap:4px; }
.term-opts { padding:7px 14px; background:var(--el-bg-color-overlay); border-bottom:1px solid var(--el-border-color-lighter); }
.term-group { gap:6px; }
.term-group + .term-group { margin-inline-start:4px; border-inline-start:1px solid var(--el-border-color-lighter); padding-inline-start:10px; }
.term-opts :deep(.el-button) { margin:0; }
.term-opts :is(.display-action, .stop-recording) { margin-inline-start:auto !important; }
.term-opts .stop-recording + .display-action { margin-inline-start:0 !important; }
.display-settings { display:grid; grid-template-columns:auto 1fr; align-items:center; gap:8px; }
.display-settings :deep(.el-select) { width:100% !important; }
.send-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 14px; background:var(--el-bg-color-overlay); border-top:1px solid var(--el-border-color-lighter); }
.send-bar :deep(.el-button) { margin:0; }
.send-input { flex:1; min-width:135px; }
.serial-status { display:flex; justify-content:flex-end; gap:16px; padding:7px 16px; font-size:12px; color:var(--el-text-color-secondary); border-top:1px solid var(--el-border-color-lighter); }
.serial-status-summary { margin-inline-end:auto; }
.serial-status b { font-family:var(--font-mono); }
@container (max-width:690px) {
  .sessions { position:absolute; z-index:2; inset:0 auto 0 0; max-width:75%; box-shadow:var(--el-box-shadow-light); }
  .sidebar-split { display:none; }
}
.transfer-form { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0 12px; }
.transfer-path { grid-column:1/-1; }
.log-dir-actions { margin-top:10px; }
.log-cleanup { margin-top:14px; padding-top:12px; border-top:1px solid var(--el-border-color-lighter); }
.log-cleanup h3 { font-size:14px; margin:0 0 4px; }
.transfer-strip { display:flex; align-items:center; gap:8px; padding:4px 12px; border-bottom:1px solid var(--el-border-color-lighter); background:var(--el-bg-color-overlay); font-size:12px; }
.transfer-strip .xfer-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.transfer-strip .el-progress { flex:1; min-width:64px; }
</style>
