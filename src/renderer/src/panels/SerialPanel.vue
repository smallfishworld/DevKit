<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Clock,
  Grid,
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
import DeviceActionsManager from '@renderer/components/DeviceActionsManager.vue'
import PluginManager from '@renderer/components/PluginManager.vue'
import { availablePluginActions } from '@renderer/components/plugin-config-form'
import type { PluginDescriptor, PluginInstance, PluginRuntimeStatus } from '../../../shared/plugins'
import { useTerminalStream } from '../composables/useTerminalStream'
import { ByteCounterThrottle } from '../../../shared/terminal-stream'
import QuickCmdManager from '@renderer/components/QuickCmdManager.vue'
import type { SerialConfig, SerialEncoding, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { BAUD_RATES } from '../../../shared/serial'
import type { VtGuardStats } from '../../../shared/vtguard'
import type { QuickCmdStep, PluginActionReference, PluginMacroAction } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import { useTabStore } from '@renderer/stores/tabs'

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()

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
const params = reactive<SerialParams>({
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false
})
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
const actionStage = ref('')
const stageLabels: Record<string, string> = {
  checking: '检查内网登录', login: '等待 OA 登录', challenge: '等待设备挑战码',
  issue: '获取授权口令', verify: '等待设备确认结果'
}
/** 自动应答（device-actions.json 中 trigger=auto）：用户意图与实际挂载状态分开 */
const autoStage = ref('')
const autoArmed = ref(false)
const autoIntent = ref(false)
const autoProfiles = ref<{ id: string; label: string; actionLabel?: string }[]>([])
/** 设备动作可视化配置弹窗 */
const deviceConfigOpen = ref(false)
/** 打开时落在哪个页签：从快捷命令的「去添加」进入时直接看动作列表 */
const deviceConfigInitialTab = ref<'global' | 'profiles'>('global')
/** 配置保存后自增，通知快捷命令编辑器重新读取可选设备动作 */
const deviceConfigVersion = ref(0)
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
  if (pluginBusy.value || actionStage.value) throw new Error('本串口正在执行动作')
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
function openDeviceConfig(tab: 'global' | 'profiles' = 'global'): void {
  deviceConfigInitialTab.value = tab
  deviceConfigOpen.value = true
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

const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]


/** 键盘直入：原样发串口（Enter 发 \r，与真实终端一致）；录制时同步记录 */
function onTermData(data: string): void {
  if (!open.value || actionStage.value || pluginBusy.value) return
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

const sessionName = ref('')
const connectionSettings = ref(false)
const sessionSave = ref(false)
const logSettings = ref(false)
const logDirectory = ref('')
const retention = reactive({ ...DEFAULT_LOG_RETENTION })
const retentionSaved = ref<LogRetentionSettings>({ ...DEFAULT_LOG_RETENTION })
const retentionLast = ref<{ at: number; removed: number; failed: number }>()
const retentionError = ref('')
const retentionBusy = ref(false)
const parityCode = computed(() => ({ none: 'N', even: 'E', odd: 'O' })[params.parity])

/** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
const sidebarWidth = ref(210)
const { onMouseDown: onSidebarResize } = useSidebarDrag(sidebarWidth, () => void persistConfig())
/** 左侧会话/快捷命令栏显示/隐藏 */
const sidebarHidden = ref(false)
/** 折叠/展开整条会话栏（与快捷命令栏一起收起；重启记忆） */
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

// ---------- 快捷命令宏（全局共享，见 composables/useTermMacros） ----------
const { recording, recordTermKey, recordSend, playCmd } = useTermMacros()

/** 宏步骤执行器：串口写法（key 按键按 ASCII 下发） */
function macroWriter(st: QuickCmdStep): void {
  if (st.type === 'key') writeCmd(st.key ?? '', 'ascii', 'none')
  else if (st.mode === 'hex') writeCmd(st.text ?? '', 'hex', 'none')
  else writeCmd(st.text ?? '', 'ascii', st.crlf ? 'crlf' : 'none')
}

async function getDeviceProfiles(): Promise<{
  profiles: { id: string; label: string; actionLabel?: string; trigger?: 'manual' | 'auto' }[]
  armed?: boolean
  error?: string
}> {
  return await window.api.invoke('serial', 'action:profiles', props.panelId) as Awaited<ReturnType<typeof getDeviceProfiles>>
}

async function runDeviceAction(profile: string): Promise<void> {
  if (actionStage.value) throw new Error('本串口正在执行设备动作')
  stopLoop()
  actionStage.value = stageLabels.checking
  try {
    const result = await window.api.invoke('serial', 'action:run', props.panelId, { profile }) as { ok: boolean; error?: string }
    if (!result.ok) throw new Error(result.error ?? '设备动作失败')
    ElMessage.success('设备动作成功')
  } finally {
    actionStage.value = ''
  }
}

function cancelDeviceAction(): void {
  void window.api.invoke('serial', 'action:cancel', props.panelId).catch(() => ElMessage.warning('无法取消设备动作'))
}

/** 读取自动应答配置与实际挂载状态（挂载状态用于面板重新渲染后恢复开关） */
async function refreshAutoProfiles(): Promise<void> {
  try {
    const result = await getDeviceProfiles()
    autoProfiles.value = (result.profiles ?? [])
      .filter((profile) => profile.trigger === 'auto')
      .map(({ id, label, actionLabel }) => ({ id, label, actionLabel }))
    autoArmed.value = result.armed === true
    if (autoArmed.value) autoIntent.value = true
  } catch {
    autoProfiles.value = []
    autoArmed.value = false
  }
}

/** 配置保存后：刷新动作列表；原本开着自动应答且主进程已解除布防时重新挂载。 */
function onDeviceConfigSaved(): void {
  deviceConfigVersion.value++
  void refreshAutoProfiles().then(() => {
    if (autoIntent.value && !autoArmed.value) void setAutoWatch(true)
  })
}

async function setAutoWatch(enabled: boolean): Promise<void> {
  autoIntent.value = enabled
  try {
    const result = await window.api.invoke('serial', 'action:watch', props.panelId, { enabled }) as {
      ok: boolean
      error?: string
    }
    if (!result.ok) throw new Error(result.error ?? '无法开启自动应答')
    autoArmed.value = enabled
    if (enabled) ElMessage.success('自动应答已开启')
  } catch (error) {
    autoIntent.value = !enabled
    autoArmed.value = false
    ElMessage.warning(error instanceof Error ? error.message : '无法切换自动应答')
  }
}

// ---------- 文件传输（YMODEM / ZMODEM） ----------
/** 确认小窗（协议已从下拉选好，文件/目录也选好后确认开始） */
const xferDlg = ref(false)
const xferKind = ref<'send' | 'recv'>('send')
const xferProtocol = ref<TransferProtocol>('ymodem')
const xferPath = ref('')
/** 传输进度窗（transfer 事件驱动） */
const transferDlg = ref(false)
const transfer = ref<SerialTransferEvt | null>(null)
let dlgCloseTimer: ReturnType<typeof setTimeout> | null = null

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
  if (t.state === 'start') {
    if (dlgCloseTimer) {
      clearTimeout(dlgCloseTimer)
      dlgCloseTimer = null
    }
    transferDlg.value = true
    return
  }
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
  if (dlgCloseTimer) clearTimeout(dlgCloseTimer)
  dlgCloseTimer = setTimeout(() => {
    transferDlg.value = false
    dlgCloseTimer = null
  }, 1200)
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
        dtrOn.value = false
        rtsOn.value = false
        signals.value = null
        autoStage.value = ''
        autoArmed.value = false
        stopSignalPoll()
        if (s.error) ElMessage.error(`串口已断开：${s.error}`)
      } else {
        // 重连后恢复用户此前开启的自动应答（主进程会话是新建的）
        void refreshAutoProfiles().then(() => {
          if (autoIntent.value && !autoArmed.value) void setAutoWatch(true)
        })
      }
    }),
    window.api.on('serial', props.panelId, 'error', (p) => {
      ElMessage.warning(`串口错误：${(p as { message: string }).message}`)
    }),
    window.api.on('serial', props.panelId, 'action:stage', (p) => {
      const label = stageLabels[(p as { stage: string }).stage]
      if (actionStage.value && label) actionStage.value = label
    }),
    window.api.on('serial', props.panelId, 'action:state', (p) => {
      const state = p as {
        armed?: boolean; running?: boolean; stage?: string; ok?: boolean; error?: string
      }
      if (typeof state.armed === 'boolean') {
        autoArmed.value = state.armed
        if (!state.running) autoStage.value = ''
        return
      }
      if (state.running) {
        const label = state.stage ? stageLabels[state.stage] : ''
        if (label) autoStage.value = label
        return
      }
      autoStage.value = ''
      if (state.ok) ElMessage.success('设备动作成功')
      else if (state.error) ElMessage.warning(state.error)
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
  Object.assign(params, res.config.last)
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
  await refreshAutoProfiles()
  await refreshPluginStatus()
})

onUnmounted(() => {
  connectionGeneration++
  document.removeEventListener('visibilitychange', syncViewVisibility)
  unsubs.forEach((u) => u())
  unsubs = []
  byteCounter.dispose()
  stopLoop()
  stopSignalPoll()
  window.api.invoke('serial', 'dispose', props.panelId).catch(() => {})
})

async function refreshPorts(): Promise<void> {
  ports.value = (await window.api.invoke('serial', 'list', props.panelId)) as PortInfo[]
  // 串口列表带回填 COM 口后，标签随所选端口即时更新（便于开多个窗口区分）
  if (params.path) tabStore.rename(props.panelId, params.path)
}

// ---------- 开关串口 ----------
async function openPort(): Promise<void> {
  if (!params.path) {
    ElMessage.warning('请选择串口')
    return
  }
  opening.value = true
  // 必须在下发 open 之前复位：open 一返回主进程就可能推出新会话的数据，
  // 那时终端若还停在上个会话遗留的备用屏里，这批数据会画进备用屏、随复位一起消失。
  // 上个会话可能停在备用屏里（vi/top 被打断）或残留模式未复位：拉回主屏+软复位，
  // 但不碰回滚内容（设备随后自己发的清屏仍会按正常 VT 语义执行）
  termView.value?.resetVtState()
  const res = (await window.api.invoke('serial', 'open', props.panelId, { ...params })) as {
    ok: boolean
    error?: string
  }
  opening.value = false
  if (res.ok) {
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
    tabStore.rename(props.panelId, params.path)
    persistConfig()
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
  tabStore.rename(props.panelId, params.path)
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
  if (actionStage.value || pluginBusy.value) {
    ElMessage.warning('设备动作正在使用此串口')
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
  if (loopOn.value || actionStage.value || pluginBusy.value) return
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
async function persistConfig(): Promise<void> {
  if (!config.value) return
  config.value.last = { ...params }
  config.value.termFont = termFont.value
  config.value.termFontSize = termFontSize.value
  config.value.autoLog = autoLog.value
  config.value.showTime = showTime.value
  config.value.encoding = encoding.value
  config.value.sidebarWidth = sidebarWidth.value
  config.value.sidebarHidden = sidebarHidden.value
  await window.api.invoke('serial', 'config:set', props.panelId, JSON.parse(JSON.stringify(config.value)))
}

async function saveSession(): Promise<void> {
  if (!config.value) return
  const name = sessionName.value.trim() || `${params.path}@${params.baudRate}`
  const list = config.value.sessions.filter((s) => s.name !== name)
  list.unshift({ name, params: JSON.parse(JSON.stringify(params)) as SerialParams })
  config.value.sessions = list
  sessionName.value = ''
  await persistConfig()
  ElMessage.success(`会话「${name}」已保存`)
}

function loadSession(idx: number): void {
  const s = sessions.value[idx]
  if (s && !open.value && !opening.value) Object.assign(params, s.params)
}

async function deleteSession(idx: number): Promise<void> {
  const s = sessions.value[idx]
  if (!s || !config.value) return
  try {
    await ElMessageBox.confirm(`删除会话「${s.name}」？`, '删除', { type: 'warning' })
  } catch {
    return
  }
  config.value.sessions = config.value.sessions.filter((x) => x.name !== s.name)
  await persistConfig()
}
</script>

<template>
  <div class="panel serial-panel">
    <header class="conn-bar">
      <div class="conn-group">
        <el-button text :icon="Grid" :aria-expanded="!sidebarHidden" aria-label="会话与快捷命令" @click="toggleSidebar" />
        <h1>{{ params.path || '串口' }}</h1>
        <el-button size="small" :aria-expanded="connectionSettings" @click="connectionSettings = true">
          {{ params.baudRate }} · {{ params.dataBits }}{{ parityCode }}{{ params.stopBits }} ▾
        </el-button>
        <span class="port-status" :class="{ online: open }">{{ open ? '已连接' : opening ? '连接中' : '未连接' }}</span>
        <el-button v-if="open" size="small" @click="closePort">断开</el-button>
        <el-button v-else size="small" type="primary" :loading="opening" @click="params.path ? openPort() : (connectionSettings = true)">连接</el-button>
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
        <SerialDevicePlugins :panel-id="props.panelId" :connected="open" @manage="pluginManagerOpen = true" />
      </div>
    </header>

    <el-dialog v-model="connectionSettings" title="连接参数" width="min(460px, 95vw)" append-to-body>
      <p v-if="open" class="hint">断开当前连接后可修改参数。</p>
      <fieldset v-else class="conn-group conn-fields">

          <el-select
            v-model="params.path"
            placeholder="选择串口"
            size="small"
            style="width: 210px"
          >
            <el-option
              v-for="p in ports"
              :key="p.path"
              :value="p.path"
              :label="`${p.path}  ${p.friendlyName}`"
            />
          </el-select>
          <el-button size="small" :icon="Refresh" @click="refreshPorts" />
          <el-select
            v-model="params.baudRate"
            size="small"
            filterable
            allow-create
            default-first-option
            style="width: 110px"
          >
            <el-option v-for="b in BAUD_RATES" :key="b" :value="b" :label="String(b)" />
          </el-select>
          <el-select v-model="params.dataBits" size="small" style="width: 78px">
            <el-option :value="7" label="7 位" />
            <el-option :value="8" label="8 位" />
          </el-select>
          <el-select v-model="params.parity" size="small" style="width: 88px">
            <el-option value="none" label="无校验" />
            <el-option value="even" label="偶校验" />
            <el-option value="odd" label="奇校验" />
          </el-select>
          <el-select v-model="params.stopBits" size="small" style="width: 78px">
            <el-option :value="1" label="1 停止" />
            <el-option :value="2" label="2 停止" />
          </el-select>
          <el-checkbox v-model="params.rtscts" size="small">RTS/CTS</el-checkbox>
                </fieldset>
      <template #footer>
        <el-button @click="connectionSettings = false">关闭</el-button>
        <el-button type="primary" :disabled="open" @click="persistConfig(); connectionSettings = false">保存参数</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sessionSave" title="保存当前会话" width="min(400px, 95vw)" append-to-body>
      <el-input v-model="sessionName" aria-label="会话名" placeholder="会话名（可选）" @keydown.enter="saveSession(); sessionSave = false" />
      <template #footer>
        <el-button @click="sessionSave = false">取消</el-button>
        <el-button type="primary" @click="saveSession(); sessionSave = false">保存</el-button>
      </template>
    </el-dialog>

    <div class="body">
      <!-- 会话库 + 快捷命令宏（全局共享）；宽度可拖动调整，可整体折叠/展开 -->
      <template v-if="!sidebarHidden">
        <div class="sessions" :style="{ width: sidebarWidth + 'px' }">
          <div class="sessions-head">
            <span>已存会话</span>
            <el-button text size="small" :icon="Plus" aria-label="保存当前会话" @click="sessionSave = true" />
          </div>
          <div
            v-for="(s, i) in sessions"
            :key="s.name"
            class="session-item"
            :class="{ active: s.params.path === params.path && s.params.baudRate === params.baudRate }"
            @click="loadSession(i)"
          >
            <div class="session-name">{{ s.name }}</div>
            <div class="session-sub">
              {{ s.params.path }} @ {{ s.params.baudRate }}
              <el-button link type="danger" size="small" @click.stop="deleteSession(i)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
          <div v-if="sessions.length === 0" class="hint" style="padding: 8px">
            暂无会话
          </div>

          <div v-if="actionStage || autoStage" role="status">
            {{ actionStage || autoStage }}
            <el-button size="small" text @click="cancelDeviceAction">取消动作</el-button>
          </div>
          <QuickCmdManager
            :enabled="open"
            :writer="macroWriter"
            :run-device-action="runDeviceAction"
            :get-device-profiles="getDeviceProfiles"
            :get-connection-generation="() => connectionGeneration"
            :device-config-version="deviceConfigVersion"
            :run-plugin-action="runPluginAction"
            :get-plugin-actions="getPluginActions"
            :plugin-config-version="pluginConfigVersion"
            @request-plugin-config="pluginManagerOpen = true"
            @request-device-config="openDeviceConfig('profiles')"
          />
        </div>

        <div class="sidebar-split" title="拖动调整宽度" @mousedown="onSidebarResize"></div>
      </template>

      <!-- 终端 + 发送 -->
      <div class="term-col">
        <div class="term-opts" aria-label="终端操作">
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
          <el-button
            size="small"
            text
            :icon="Setting"
            title="可视化编辑设备动作配置（OA 登录、取码接口、挑战码与结果判定）"
            @click="openDeviceConfig('global')"
          >
            设备动作
          </el-button>
          <el-tooltip
            v-if="autoProfiles.length"
            :content="`设备输出出现特征码时自动取口令并注入：${autoProfiles.map((profile) => profile.label).join('、')}`"
            placement="top"
          >
            <el-checkbox v-model="autoIntent" size="small" :disabled="!open" @change="(value: boolean) => setAutoWatch(value)">
              自动应答
            </el-checkbox>
          </el-tooltip>
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
            <el-checkbox v-model="showTime" size="small" @change="persistConfig">时间戳</el-checkbox>
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
        <el-dialog v-model="logSettings" title="会话日志设置" width="min(420px, 95vw)" append-to-body>
          <el-checkbox v-model="autoLog" @change="persistConfig">自动保存会话日志</el-checkbox>
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
          :local-echo="localEcho && !actionStage && !autoStage && !pluginBusy"
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
      <span class="serial-status-summary">{{ params.path || '串口' }} · {{ open ? '已连接' : '未连接' }}</span>
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

    <!-- 传输进度 -->
    <el-dialog
      v-model="transferDlg"
      title="文件传输"
      width="420px"
      :close-on-click-modal="false"
      :show-close="false"
      append-to-body
    >
      <div v-if="transfer" class="xfer-box">
        <div class="xfer-line">
          <el-tag size="small" effect="plain">{{ transfer.protocol.toUpperCase() }}</el-tag>
          <span>{{ transfer.dir === 'send' ? '发送' : '接收' }}</span>
          <span class="xfer-name">{{ transfer.name || '等待设备端…' }}</span>
        </div>
        <el-progress
          :percentage="transferPct"
          :indeterminate="!transfer.total"
          :status="transfer.state === 'error' ? 'exception' : transfer.state === 'done' ? 'success' : undefined"
        />
        <div class="hint xfer-count">
          {{ transfer.total ? `${transfer.bytes} / ${transfer.total} 字节` : '协商中…' }}
        </div>
      </div>
      <template #footer>
        <el-button :disabled="!transferring" @click="cancelTransfer">取消传输</el-button>
      </template>
    </el-dialog>
    <PluginManager
      v-model:visible="pluginManagerOpen"
      :panel-id="props.panelId"
      :connected="open"
      @changed="onPluginsChanged"
      @legacy-config="pluginManagerOpen = false; openDeviceConfig('global')"
    />
    <DeviceActionsManager
      v-model:visible="deviceConfigOpen"
      :panel-id="props.panelId"
      :initial-tab="deviceConfigInitialTab"
      @saved="onDeviceConfigSaved"
    />
  </div>
</template>

<style scoped>
.serial-panel { height:100%; overflow:hidden; padding:0; gap:0; container-type:inline-size; }
.mono { font-family:var(--font-mono); }
.hint { font-size:12px; color:var(--el-text-color-secondary); }
.conn-bar, .conn-group { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.conn-bar { justify-content:space-between; flex:none; padding:6px 10px; background:var(--el-bg-color-overlay); border-bottom:1px solid var(--el-border-color-lighter); }
.conn-bar h1 { margin:0; font:600 14px var(--font-mono); }
.conn-fields { border:0; padding:0; margin:0; min-width:0; }
.port-status { padding:2px 8px; border-radius:20px; font-size:12px; background:var(--el-fill-color); }
.port-status.online { color:var(--el-color-success); background:var(--el-color-success-light-9); }
.sig { display:inline-flex; gap:4px; }
.body { display:flex; flex:1; min-height:0; position:relative; }
.sessions { flex:none; min-width:150px; max-width:27%; padding:10px; overflow:auto; background:var(--el-bg-color-overlay); border-right:1px solid var(--el-border-color-lighter); }
.sidebar-split { flex:0 0 4px; margin:0 -2px; cursor:col-resize; z-index:1; }
.sidebar-split:hover { background:var(--el-color-primary); }
.sessions-head { display:flex; align-items:center; justify-content:space-between; font-size:13px; font-weight:600; }
.session-item { padding:5px 8px; border-radius:7px; cursor:pointer; }
.session-item:hover, .session-item.active { background:var(--el-fill-color-light); }
.session-name { font-size:13px; overflow-wrap:anywhere; }
.session-sub { font-size:12px; color:var(--el-text-color-secondary); display:flex; justify-content:space-between; align-items:center; }
.term-col { flex:1; display:flex; flex-direction:column; min-width:0; }
.term-col :deep(.term) { border:0; border-radius:0; box-shadow:none; padding:10px 12px; }
.term-col :deep(.search-bar) { margin:0; border-radius:0; border-width:0 0 1px; }
.term-opts, .term-group { display:flex; align-items:center; flex-wrap:wrap; gap:4px; }
.term-opts { padding:4px 10px; background:var(--el-bg-color-overlay); border-bottom:1px solid var(--el-border-color-lighter); }
.term-group + .term-group { border-inline-start:1px solid var(--el-border-color-lighter); padding-inline-start:5px; }
.term-opts :deep(.el-button) { margin:0; }
.display-action { margin-inline-start:auto !important; }
.display-settings { display:grid; grid-template-columns:auto 1fr; align-items:center; gap:8px; }
.display-settings :deep(.el-select) { width:100% !important; }
.send-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 10px; background:var(--el-bg-color-overlay); border-top:1px solid var(--el-border-color-lighter); }
.send-bar :deep(.el-button) { margin:0; }
.send-input { flex:1; min-width:135px; }
.serial-status { display:flex; justify-content:flex-end; gap:12px; padding:5px 12px; font-size:12px; color:var(--el-text-color-secondary); border-top:1px solid var(--el-border-color-lighter); }
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
.xfer-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.xfer-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.xfer-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.xfer-count {
  text-align: right;
}
</style>
