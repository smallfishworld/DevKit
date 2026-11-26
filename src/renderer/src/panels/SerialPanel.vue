<script lang="ts">
/** 进程运行期内记住上次选择的文件传输路径（发送文件 / 接收目录），不落盘 */
const lastTransferPaths: Record<'send' | 'recv', string> = { send: '', recv: '' }
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { usePanelDocument } from '@renderer/composables/usePanelWindow'
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
import { activateTermMacroTarget, finishSharedRecording, registerTermMacroTarget } from '../composables/useTermMacroTargets'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import { useTabStore } from '@renderer/stores/tabs'

const ElMessage = usePanelMessage()
const { t, locale } = useI18n()
const panelDocument = usePanelDocument()

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
  if (!result.ok) throw new Error(result.error || t('serialUi.pluginOpFailed'))
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
  if (!open.value) throw new Error(t('serialUi.portNotOpen'))
  if (pluginBusy.value) throw new Error(t('serialUi.pluginBusy'))
  const generation = connectionGeneration
  pluginExecuting.value = action.instanceId
  stopLoop()
  try {
    const runtime = await pluginApi<{ statuses: PluginRuntimeStatus[] }>('status')
    const status = runtime.statuses.find(item => item.instanceId === action.instanceId)
    if (status?.bound && status.panelId !== props.panelId) throw new Error(t('serialUi.pluginBoundOther'))
    if (!open.value || generation !== connectionGeneration) throw new Error(t('serialUi.connChangedRetry'))
    await pluginApi('bind', { instanceId: action.instanceId })
    if (!open.value || generation !== connectionGeneration) throw new Error(t('serialUi.connChangedCancelled'))
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
  const note = stats.eraseScrollback > 0 ? t('serialUi.guardEraseScrollback') : t('serialUi.guardHardReset')
  void window.api.invoke('serial', 'log:note', props.panelId, { text: note }).catch(() => {})
}
let altScreenNoted = false
function onAltScreen(): void {
  if (altScreenNoted) return
  altScreenNoted = true
  void window.api.invoke('serial', 'log:note', props.panelId, {
    text: t('serialUi.altScreenNote')
  }).catch(() => {})
}
function syncViewVisibility(): void {
  // sessionVisible 认分屏：面板是激活分屏的成员时同样算在显示
  void window.api.invoke('serial', 'view:visible', props.panelId, {
    visible: !panelDocument.value.hidden && tabStore.sessionVisible(props.panelId)
  }).catch(() => {})
}
watch(() => tabStore.sessionVisible(props.panelId), syncViewVisibility)
watch(locale, () => syncTabTitle(displayedParams.value.path))
watch(panelDocument, (current, previous) => {
  previous.removeEventListener('visibilitychange', syncViewVisibility)
  current.addEventListener('visibilitychange', syncViewVisibility)
  syncViewVisibility()
})
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
const portHeading = computed(() => normalizePortPath(displayedParams.value.path) || t('serialUi.portFallback'))
/** 标签页标题：显示端口号；未选端口时回退工具名 */
function syncTabTitle(path: string): void {
  tabStore.rename(props.panelId, path ? normalizePortPath(path) : t('serialUi.toolFallback'))
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

/**
 * 两个终端分屏时共用一条快捷命令栏（见 composables/useTermMacroTargets）：
 * 本面板自带的命令栏不再显示，执行方式登记给共享栏；终端获得焦点即成为发送目标。
 */
const sharedCmds = computed(() => tabStore.sharesQuickCmds(props.panelId))
const unregisterMacroTarget = registerTermMacroTarget({
  panelId: props.panelId,
  title: () => tabStore.sessionById(props.panelId)?.title,
  enabled: () => open.value,
  writer: macroWriter,
  getConnectionGeneration: () => connectionGeneration,
  runPluginAction,
  getPluginActions,
  pluginConfigVersion: () => pluginConfigVersion.value,
  requestPluginConfig: () => {
    pluginManagerOpen.value = true
  }
})
onUnmounted(unregisterMacroTarget)

/** 停止录制并整理保存：有共享栏时转给共享栏的列表实例，否则用自带的 */
function finishRecording(): void {
  if (!finishSharedRecording(props.panelId)) commandManager.value?.finishRecording()
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
  xferPath.value = lastTransferPaths[xferKind.value]
  xferDlg.value = true
}

function onTransferKindChange(): void {
  xferPath.value = lastTransferPaths[xferKind.value]
}

async function chooseTransferPath(): Promise<void> {
  const kind = xferKind.value
  const action = kind === 'send' ? 'file:pick' : 'file:pick-dir'
  const defaultPath = xferPath.value || lastTransferPaths[kind]
  const pick = (await window.api.invoke(
    'serial',
    action,
    props.panelId,
    defaultPath ? { defaultPath } : undefined
  )) as { ok: boolean; path?: string }
  if (pick.ok && pick.path) {
    lastTransferPaths[kind] = pick.path
    if (xferDlg.value && kind === xferKind.value) xferPath.value = pick.path
  }
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
    termView.value?.info(t('serialUi.xferSendStart', { proto: protoName, path: xferPath.value }))
    window.api
      .invoke('serial', 'file:send', props.panelId, { protocol: xferProtocol.value, path: xferPath.value })
      .catch(() => {})
  } else {
    termView.value?.info(t('serialUi.xferRecvStart', { proto: protoName }))
    window.api
      .invoke('serial', 'file:recv', props.panelId, { protocol: xferProtocol.value, dir: xferPath.value })
      .catch(() => {})
  }
}

function cancelTransfer(): void {
  void window.api.invoke('serial', 'file:cancel', props.panelId).catch(() => {})
}

function onTransferEvt(p: unknown): void {
  const evt = p as SerialTransferEvt
  transfer.value = evt
  clearTimeout(transferNoticeTimer)
  if (evt.state === 'start' || evt.state === 'progress') return
  if (evt.state === 'done') {
    const msg = evt.dir === 'send' ? t('serialUi.xferSendDone', { name: evt.name }) : t('serialUi.xferRecvDone', { name: evt.name || t('serialUi.noFile') })
    ElMessage.success(msg)
    termView.value?.info(msg)
  } else if (evt.state === 'error') {
    ElMessage.error(t('serialUi.xferFailed', { error: evt.error ?? '' }))
    termView.value?.info(t('serialUi.xferFailed', { error: evt.error ?? '' }))
  } else if (evt.state === 'cancel') {
    termView.value?.info(t('serialUi.xferCancelled'))
  }
  transferNoticeTimer = setTimeout(() => { transfer.value = null }, 1600)
}

// ---------- 初始化 ----------
onMounted(async () => {
  panelDocument.value.addEventListener('visibilitychange', syncViewVisibility)
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
        if (s.error) ElMessage.error(t('serialUi.disconnectedError', { error: s.error }))
      }
    }),
    window.api.on('serial', props.panelId, 'error', (p) => {
      ElMessage.warning(t('serialUi.serialError', { message: (p as { message: string }).message }))
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
  termView.value?.info(t('serialUi.readyInfo'))
  await refreshPorts()
  // 恢复上次端口时标签标题同步为端口号
  syncTabTitle(params.path)
  await refreshPluginStatus()
})

onUnmounted(() => {
  connectionGeneration++
  panelDocument.value.removeEventListener('visibilitychange', syncViewVisibility)
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
    connectionError.value = t('serialUi.invalidParams')
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
    ElMessage.warning(t('serialUi.selectPortFirst'))
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
    termView.value?.info(t('serialUi.openedInfo', { path: params.path, baudRate: params.baudRate }))
    syncTabTitle(params.path)
    void persistConfig().catch((error: unknown) => ElMessage.warning(String(error)))
    startSignalPoll()
    termView.value?.focus()
  } else {
    ElMessage.error(t('serialUi.openFailed', { error: res.error ?? '' }))
  }
}

async function closePort(): Promise<void> {
  connectionGeneration++
  stopSignalPoll()
  await window.api.invoke('serial', 'close', props.panelId)
  open.value = false
  activeParams.value = undefined
  syncTabTitle(params.path)
  termView.value?.info(t('serialUi.disconnected'))
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
    ElMessage.warning(t('serialUi.pluginUsingPort'))
    return
  }
  if (!open.value) {
    ElMessage.warning(t('serialUi.portNotOpen'))
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
    ElMessage.warning(t('serialUi.enterSendContent'))
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
      const r = res as { ok: boolean; code?: string; error?: string }
      if (r.ok) ElMessage.success(t('serialUi.logSaved'))
      else if (r.code !== 'CANCELLED' && r.error) ElMessage.warning(t('serialUi.logSaveFailed', { error: r.error }))
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
    if (!result.ok) throw new Error(result.error || t('serialUi.saveFailed'))
    retentionSaved.value = result.settings
    ElMessage.success(t('serialUi.retentionSaved'))
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
    ElMessage.success(t('serialUi.logDirSet', { dir: res.dir }))
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
    connectionError.value = t('serialUi.invalidParams')
    return
  }
  const name = newPresetName.value.trim() || `${next.path} @ ${next.baudRate}`
  const list = config.value.sessions.filter((s) => s.name !== name)
  list.unshift({ name, params: { ...next } })
  config.value.sessions = list
  presetName.value = name
  newPresetName.value = ''
  await persistConfig()
  ElMessage.success(t('serialUi.presetSaved', { name }))
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
  ElMessage.success(t('serialUi.presetDeleted', { name }))
}

</script>

<template>
  <div class="panel serial-panel">
    <header class="conn-bar">
      <div class="conn-group">
        <h1 :title="displayedParams.path">{{ portHeading }}</h1>
        <el-popover v-model:visible="connectionSettings" placement="bottom-start" :width="440" trigger="click" @before-enter="resetConnectionDraft">
          <template #reference>
            <el-button size="small" :aria-expanded="connectionSettings" :aria-label="t('serialUi.connParams')" :disabled="opening || connectionSaving">
              {{ displayedParams.baudRate }} · {{ displayedParams.dataBits }}{{ parityCode }}{{ displayedParams.stopBits }} ▾
            </el-button>
          </template>
          <section class="connection-editor" :aria-label="t('serialUi.connParams')" @keydown.esc="!connectionSaving && (connectionSettings = false)">
            <h2>{{ t('serialUi.connParams') }}</h2>
            <p class="hint">{{ open ? t('serialUi.connHintOpen') : t('serialUi.connHintClosed') }}</p>
            <fieldset class="conn-fields" :disabled="connectionSaving || opening">
              <div class="conn-field conn-preset-field"><span>{{ t('serialUi.savedPresets') }}</span>
                <div class="conn-preset-row">
                  <el-select v-model="presetName" :teleported="false" size="small" filterable
                    clearable :placeholder="t('serialUi.pickPresetPlaceholder')" :aria-label="t('serialUi.savedPresets')"
                    @change="(name: string) => name && applyPreset(name)">
                    <el-option v-for="preset in sessions" :key="preset.name" :value="preset.name"
                      :label="`${preset.name}（${preset.params.path} @ ${preset.params.baudRate}）`" />
                  </el-select>
                  <el-button size="small" :type="presetDeleteArmed ? 'danger' : undefined"
                    :icon="presetDeleteArmed ? undefined : Delete"
                    :aria-label="presetDeleteArmed ? t('sshExtra.confirmDeletePreset') : t('sshExtra.deletePreset')"
                    :title="presetDeleteArmed ? t('sshExtra.clickAgainDelete') : t('sshExtra.deletePreset')"
                    :disabled="!presetName" @click="requestDeletePreset">
                    <span v-if="presetDeleteArmed">{{ t('serialUi.confirm') }}</span>
                  </el-button>
                </div>
              </div>
              <div class="conn-field conn-save-as-field"><span>{{ t('serialUi.saveAsPreset') }}</span>
                <div class="conn-port-field">
                  <el-input v-model="newPresetName" size="small" maxlength="24" clearable
                    :placeholder="t('serialUi.presetNamePlaceholder', { port: connectionDraft.path || t('serialUi.portWord'), baudRate: connectionDraft.baudRate })"
                    :aria-label="t('serialUi.newPresetNameAria')" @keydown.enter.prevent="savePreset" />
                  <el-button size="small" :icon="Plus" :aria-label="t('serialUi.savePresetAria')" :title="t('serialUi.savePresetTitle')"
                    :disabled="!connectionDraft.path" @click="savePreset" />
                </div>
              </div>
              <div class="conn-field"><span>{{ t('serialUi.portFallback') }}</span>
                <div class="conn-port-field">
                  <el-select v-model="connectionDraft.path" :teleported="false" :placeholder="t('serialUi.selectPort')" :aria-label="t('serialUi.portFallback')" size="small">
                    <el-option v-for="port in ports" :key="port.path" :value="port.path"
                      :label="[port.path, port.friendlyName].filter(Boolean).join(' · ')" />
                  </el-select>
                  <el-button size="small" :icon="Refresh" :aria-label="t('serialUi.refreshPortsAria')" @click="refreshPorts" />
                </div>
              </div>
              <div class="conn-field"><span>{{ t('serialUi.baudRate') }}</span>
                <el-select v-model="connectionDraft.baudRate" :teleported="false" :aria-label="t('serialUi.baudRate')" size="small"
                  filterable allow-create default-first-option>
                  <el-option v-for="baud in BAUD_RATES" :key="baud" :value="baud" :label="String(baud)" />
                </el-select>
              </div>
              <div class="conn-field"><span>{{ t('serialUi.dataBits') }}</span>
                <el-select v-model="connectionDraft.dataBits" :teleported="false" :aria-label="t('serialUi.dataBits')" size="small">
                  <el-option :value="7" :label="t('serialUi.bitsOption', { n: 7 })" />
                  <el-option :value="8" :label="t('serialUi.bitsOption', { n: 8 })" />
                </el-select>
              </div>
              <div class="conn-field"><span>{{ t('serialUi.parity') }}</span>
                <el-select v-model="connectionDraft.parity" :teleported="false" :aria-label="t('serialUi.parityAria')" size="small">
                  <el-option value="none" :label="t('serialUi.parityNone')" />
                  <el-option value="even" :label="t('serialUi.parityEven')" />
                  <el-option value="odd" :label="t('serialUi.parityOdd')" />
                </el-select>
              </div>
              <div class="conn-field"><span>{{ t('serialUi.stopBits') }}</span>
                <el-select v-model="connectionDraft.stopBits" :teleported="false" :aria-label="t('serialUi.stopBits')" size="small">
                  <el-option :value="1" :label="t('serialUi.stopOption', { n: 1 })" />
                  <el-option :value="2" :label="t('serialUi.stopOption', { n: 2 })" />
                </el-select>
              </div>
              <el-checkbox v-model="connectionDraft.rtscts" size="small">RTS/CTS</el-checkbox>
            </fieldset>
            <p v-if="connectionError" class="hint" role="alert">{{ connectionError }}</p>
            <div class="connection-footer">
              <el-button :disabled="connectionSaving" @click="connectionSettings = false">{{ t('serialUi.cancel') }}</el-button>
              <el-button :disabled="opening || connectionSaving" @click="saveConnection(false)">{{ t('serialUi.saveOnly') }}</el-button>
              <el-button type="primary" :loading="connectionSaving" :disabled="opening" @click="saveConnection(true)">{{ open ? t('serialUi.saveReconnect') : t('serialUi.saveConnect') }}</el-button>
            </div>
          </section>
        </el-popover>
        <span class="port-status" :class="{ online: open }">{{ open ? t('serialUi.connected') : opening ? t('serialUi.connecting') : t('serialUi.notConnected') }}</span>
        <el-button v-if="open" size="small" :disabled="opening || connectionSaving" @click="closePort">{{ t('serialUi.disconnect') }}</el-button>
        <el-button v-else size="small" type="primary" :loading="opening" :disabled="connectionSaving" @click="params.path ? openPort() : (connectionSettings = true)">{{ t('serialUi.connect') }}</el-button>
      </div>
      <div class="conn-group">
      <el-popover placement="bottom-end" :width="280" trigger="click">
        <template #reference><el-button text size="small" :icon="Operation">DTR · RTS</el-button></template>
        <div class="conn-group">
        <el-button size="small" :disabled="!open" :type="dtrOn ? 'warning' : 'default'" @click="toggleDtr">
          DTR {{ dtrOn ? t('serialUi.high') : t('serialUi.low') }}
        </el-button>
        <el-button size="small" :disabled="!open" :type="rtsOn ? 'warning' : 'default'" @click="toggleRts">
          RTS {{ rtsOn ? t('serialUi.high') : t('serialUi.low') }}
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
           连接参数的「已存预设」收进了连接栏的浮层里，这里不再单列一块。
           与另一个终端分屏时整块不显示，由分屏左侧的共享栏代替 -->
        <div v-if="!sidebarHidden && !sharedCmds" class="sessions" :style="{ width: sidebarWidth + 'px' }">
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
        <div v-if="!sidebarHidden && !sharedCmds" class="sidebar-split" :title="t('sshExtra.resizeSidebar')" @mousedown="onSidebarResize">
          <button class="split-toggle" :title="t('sshExtra.collapseCmds')" @mousedown.stop @click="toggleSidebar">
            <svg viewBox="0 0 8 12" width="7" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 1L1.5 6l5 5" />
            </svg>
          </button>
        </div>

      <!-- 折叠后的细条：点击展开侧栏 -->
      <div v-else-if="!sharedCmds" class="sidebar-collapsed" :title="t('sshExtra.expandCmds')" @click="toggleSidebar">
        <el-icon :size="16"><ArrowRight /></el-icon>
      </div>

      <!-- 终端 + 发送（点进去或键盘聚焦进来，即成为共享快捷命令栏的发送目标） -->
      <div
        class="term-col"
        @pointerdown="activateTermMacroTarget(props.panelId)"
        @focusin="activateTermMacroTarget(props.panelId)"
      >
        <div class="term-opts" role="group" :aria-label="t('serialUi.termActionsAria')">
          <div class="term-group" role="group" :aria-label="t('serialUi.termOutputAria')">
            <el-button size="small" text :icon="Search" :title="t('serialUi.findTitle')" @click="openTermSearch">{{ t('serialUi.find') }}</el-button>
            <el-button size="small" text @click="clearTerm">{{ t('serialUi.clear') }}</el-button>
          </div>
          <div class="term-group" role="group" :aria-label="t('serialUi.logGroupAria')">
            <el-button size="small" text :icon="Download" @click="saveLog">{{ t('serialUi.saveLog') }}</el-button>
            <TerminalHistory tool="serial" :panel-id="props.panelId" />
            <el-button size="small" text :icon="FolderOpened" @click="openLogSettings">{{ t('serialUi.logSettings') }}</el-button>
          </div>
          <el-button size="small" text :icon="UploadFilled" :disabled="!open || transferring" @click="openTransfer">{{ t('serialUi.fileTransfer') }}</el-button>
          <el-button v-if="recording" class="stop-recording" size="small" text type="danger" @click="finishRecording">{{ t('serialUi.stopRecording') }}</el-button>
          <el-popover placement="bottom-end" :width="310" trigger="click">
            <template #reference>
              <el-button class="display-action" size="small" text :icon="Setting">{{ t('serialUi.displaySettings') }}</el-button>
            </template>
            <div class="display-settings">
          <span>{{ t('serialUi.font') }}</span>
          <el-tooltip :content="t('sshExtra.fontTooltip')" placement="top">
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
              <el-option value="SimSun" :label="t('sshExtra.fontSimSun')" />
            </el-select>
          </el-tooltip>
          <span>{{ t('serialUi.fontSize') }}</span>
          <el-tooltip :content="t('sshExtra.fontSizeTooltip')" placement="top">
            <el-select v-model="termFontSize" size="small" filterable style="width: 74px">
              <el-option v-for="s in TERM_SIZES" :key="s" :value="s" :label="String(s)" />
            </el-select>
          </el-tooltip>
          <el-tooltip :content="t('serialUi.localEchoTooltip')" placement="top">
            <el-checkbox v-model="localEcho" size="small">{{ t('serialUi.localEcho') }}</el-checkbox>
          </el-tooltip>
          <el-tooltip :content="t('sshExtra.timestampTooltip')" placement="top">
            <el-checkbox v-model="showTime" size="small" @change="persistConfig()">{{ t('serialUi.timestamp') }}</el-checkbox>
          </el-tooltip>
          <span>{{ t('serialUi.rxEncoding') }}</span>
          <el-tooltip :content="t('serialUi.rxEncodingTooltip')" placement="top">
            <el-select v-model="encoding" size="small" style="width: 88px" @change="onEncodingChange">
              <el-option value="utf8" label="UTF-8" />
              <el-option value="gbk" label="GBK" />
            </el-select>
          </el-tooltip>
            </div>
          </el-popover>
        </div>
        <el-dialog v-model="logSettings" :title="t('serialUi.logSettingsTitle')" width="min(420px, 95vw)" append-to-body>
          <el-checkbox v-model="autoLog" @change="persistConfig()">{{ t('serialUi.autoSaveLog') }}</el-checkbox>
          <p class="hint">{{ t('serialUi.autoSaveHint') }}</p>
          <el-input :model-value="logDirectory" readonly :aria-label="t('serialUi.autoLogDirAria')" :placeholder="t('serialUi.readingLogDir')" />
          <div class="panel-row log-dir-actions">
            <el-button size="small" @click="setLogDir">{{ t('serialUi.setLogDir') }}</el-button>
            <el-button size="small" @click="openLogDir">{{ t('serialUi.openLogDir') }}</el-button>
          </div>
          <section class="log-cleanup">
            <h3>{{ t('serialUi.logCleanupTitle') }}</h3>
            <el-checkbox v-model="retention.enabled" :disabled="retentionBusy">{{ t('serialUi.enableAutoCleanup') }}</el-checkbox>
            <el-form label-position="top" @submit.prevent="saveLogRetention">
              <el-form-item :label="t('serialUi.retentionMonthsLabel')">
                <el-input-number v-model="retention.months" :min="1" :max="120" :step="1" step-strictly :disabled="retentionBusy || !retention.enabled" />
              </el-form-item>
              <p class="hint">{{ t('serialUi.retentionHint') }}</p>
              <p class="hint" role="status">{{ retentionSaved.enabled ? t('serialUi.retentionSavedEnabled', { months: retentionSaved.months }) : t('serialUi.retentionSavedDisabled') }}</p>
              <p v-if="retentionLast" class="hint">{{ t('serialUi.retentionLastRun', { time: new Date(retentionLast.at).toLocaleString(), removed: retentionLast.removed, failed: retentionLast.failed }) }}</p>
              <el-alert v-if="retentionError" :title="retentionError" type="error" :closable="false" role="alert" />
              <el-button native-type="submit" size="small" :loading="retentionBusy" :disabled="!validLogRetention(retention)">{{ t('serialUi.saveRetention') }}</el-button>
            </el-form>
          </section>
          <template #footer><el-button type="primary" @click="logSettings = false">{{ t('serialUi.done') }}</el-button></template>
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
        <div v-if="transfer" class="transfer-strip">
          <strong>{{ transfer.protocol.toUpperCase() }} · {{ transfer.dir === 'send' ? t('serialUi.xferDirSend') : t('serialUi.xferDirRecv') }}</strong>
          <span class="xfer-name" :title="transfer.name">{{ transfer.name || t('serialUi.waitingDevice') }}</span>
          <el-progress :percentage="transferPct" :indeterminate="transferring && !transfer.total"
            :status="transfer.state === 'error' ? 'exception' : transfer.state === 'done' ? 'success' : undefined" />
          <span v-if="!transfer.total && transferring" class="hint">{{ t('serialUi.negotiating') }}</span>
          <el-button v-if="transferring" size="small" text type="danger" @click="cancelTransfer">{{ t('serialUi.cancelTransfer') }}</el-button>
        </div>

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
            <el-option value="none" :label="t('serialUi.noNewline')" />
            <el-option value="crlf" label="CRLF" />
            <el-option value="lf" label="LF" />
            <el-option value="cr" label="CR" />
          </el-select>
          <el-input
            v-model="sendText"
            size="small"
            class="send-input mono"
            :aria-label="t('serialUi.sendContentAria')"
            :placeholder="sendMode === 'hex' ? t('serialUi.sendPlaceholderHex') : t('serialUi.sendPlaceholderAscii')"
            :disabled="loopOn"
            @input="historyIndex = -1"
            @keydown.up.exact="recallSendHistory($event, 1)"
            @keydown.down.exact="recallSendHistory($event, -1)"
            @keydown.enter.exact="sendFromKeyboard"
            @keydown.ctrl.enter="sendFromKeyboard"
          >
            <template #suffix>
              <el-dropdown trigger="click" :disabled="!history.length || loopOn" @command="(cmd: string) => (sendText = cmd)">
                <el-button text size="small" :icon="Clock" :disabled="!history.length || loopOn" :aria-label="t('serialUi.sendHistoryAria')" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="h in history" :key="h" :command="h">{{ h.slice(0, 60) }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-input>
          <el-button type="primary" size="small" :disabled="!open || loopOn" @click="send">{{ t('serialUi.send') }}</el-button>
          <!-- 定时发送：默认收起，点「定时」展开 -->
          <el-tooltip :content="t('serialUi.timedSendTooltip')" placement="top">
            <el-button
              size="small"
              :type="loopOn ? 'danger' : loopPanel ? 'warning' : 'default'"
              @click="loopOn ? stopLoop() : (loopPanel = !loopPanel)"
            >
              {{ loopOn ? t('serialUi.stopLoop') : t('serialUi.timed') }}
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
            <el-button size="small" @click="startLoop">{{ t('serialUi.loop') }}</el-button>
          </template>
        </div>
      </div>
    </div>

    <footer class="serial-status">
      <span class="serial-status-summary">{{ displayedParams.path || t('serialUi.portFallback') }} · {{ open ? t('serialUi.connected') : t('serialUi.notConnected') }}</span>
      <span>RX <b>{{ rxBytes }}</b> B</span>
      <span>TX <b>{{ txBytes }}</b> B</span>
      <span>{{ autoLog ? t('serialUi.keepLogBadge') : t('serialUi.tempLogBadge') }}</span>
    </footer>

    <el-dialog v-model="xferDlg" :title="t('serialUi.xferDialogTitle')" width="min(460px, 95vw)" append-to-body>
      <el-form label-position="top" size="small" class="transfer-form" @submit.prevent="startXfer">
        <el-form-item :label="t('serialUi.xferProtocol')">
          <el-select v-model="xferProtocol" :aria-label="t('serialUi.xferProtocol')">
            <el-option label="YMODEM" value="ymodem" />
            <el-option label="ZMODEM" value="zmodem" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('serialUi.xferDirection')">
          <el-select v-model="xferKind" :aria-label="t('serialUi.xferDirection')" @change="onTransferKindChange">
            <el-option :label="t('serialUi.sendToDevice')" value="send" />
            <el-option :label="t('serialUi.recvFromDevice')" value="recv" />
          </el-select>
        </el-form-item>
        <el-form-item class="transfer-path" :label="xferKind === 'send' ? t('serialUi.localFile') : t('serialUi.recvSaveDir')">
          <el-input :model-value="xferPath" readonly>
            <template #append><el-button @click="chooseTransferPath">{{ xferKind === 'send' ? t('serialUi.chooseFile') : t('serialUi.chooseDir') }}</el-button></template>
          </el-input>
        </el-form-item>
      </el-form>
      <div class="hint">
        {{
          xferKind === 'send'
            ? t('serialUi.xferSendHint')
            : t('serialUi.xferRecvHint')
        }}
      </div>
      <template #footer>
        <el-button @click="xferDlg = false">{{ t('serialUi.cancel') }}</el-button>
        <el-button type="primary" :disabled="!xferPath || !open || transferring" @click="startXfer">{{ t('serialUi.startTransfer') }}</el-button>
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
.transfer-strip { display:flex; align-items:center; gap:8px; padding:4px 12px; border-top:1px solid var(--el-border-color-lighter); background:var(--el-bg-color-overlay); font-size:12px; }
.transfer-strip .xfer-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.transfer-strip .el-progress { flex:1; min-width:64px; }
</style>
