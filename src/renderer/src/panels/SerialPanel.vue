<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CaretRight,
  CircleClose,
  Connection,
  Delete,
  Download,
  FolderOpened,
  Plus,
  Refresh,
  UploadFilled
} from '@element-plus/icons-vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import QuickCmdManager from '@renderer/components/QuickCmdManager.vue'
import type { SerialConfig, SerialParams, SerialTransferEvt, TransferProtocol } from '../../../shared/serial'
import { BAUD_RATES } from '../../../shared/serial'
import type { QuickCmdStep } from '../../../shared/term-macro'
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
const opening = ref(false)
const rxBytes = ref(0)
const txBytes = ref(0)
/** 字节计数节流：刷屏时每批 data 都写 ref 会频繁触发状态栏重渲，500ms 更新足够 */
let byteTimer: ReturnType<typeof setTimeout> | null = null
function updateBytesThrottled(rx: number, tx: number): void {
  if (byteTimer) return
  byteTimer = setTimeout(() => {
    byteTimer = null
    rxBytes.value = rx
    txBytes.value = tx
  }, 500)
}
const dtrOn = ref(false)
const rtsOn = ref(false)
const signals = ref<{ cts: boolean; dsr: boolean; dcd: boolean } | null>(null)

// ---------- 终端（TerminalView 共享组件：xterm.js 封装） ----------
const termView = ref<InstanceType<typeof TerminalView> | null>(null)
/** 本地回显：设备不回显的裸模块打开后能看到自己敲的字符 */
const localEcho = ref(false)
/** 终端字体族与字号（Ctrl+滚轮 / Ctrl+=/- 缩放） */
const termFont = ref('Consolas')
const termFontSize = ref(13)
const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]
/** 原始收发流水（供「存日志」导出；完整落盘由主进程自动日志负责） */
interface RawPiece {
  time: number
  dir: 'RX' | 'TX'
  text: string
}
const ringBuf: RawPiece[] = []

/** 键盘直入：原样发串口（Enter 发 \r，与真实终端一致）；录制时同步记录 */
function onTermData(data: string): void {
  if (!open.value) return
  if (recording.value) recordTermKey(data)
  window.api
    .invoke('serial', 'write', props.panelId, { mode: 'ascii', text: data, newline: 'none' })
    .catch(() => {})
}

function pushRaw(dir: RawPiece['dir'], text: string): void {
  ringBuf.push({ time: Date.now(), dir, text })
  if (ringBuf.length > 5000) ringBuf.splice(0, ringBuf.length - 5000)
}

const sendMode = ref<'ascii' | 'hex'>('ascii')
const sendText = ref('')
const sendNewline = ref<'none' | 'crlf' | 'lf' | 'cr'>('crlf')
const history = ref<string[]>([])
/** 定时发送面板：非常用功能，默认收起，点「定时」展开 */
const loopPanel = ref(false)
const loopOn = ref(false)
const loopPeriod = ref(1000)
let loopTimer: ReturnType<typeof setInterval> | null = null

const sessionName = ref('')

/** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
const sidebarWidth = ref(210)
const { onMouseDown: onSidebarResize } = useSidebarDrag(sidebarWidth, () => void persistConfig())

/** 自动日志开关（会话期间收发自动落盘，默认开启；重启记忆） */
const autoLog = ref(true)

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

/** 发文件：下拉选协议 → 系统文件选择框 → 确认开始 */
async function onSendFile(proto: TransferProtocol): Promise<void> {
  if (!open.value) {
    ElMessage.warning('串口未打开')
    return
  }
  const pick = (await window.api.invoke('serial', 'file:pick', props.panelId)) as {
    ok: boolean
    path?: string
  }
  if (!pick.ok || !pick.path) return
  xferProtocol.value = proto
  xferPath.value = pick.path
  xferKind.value = 'send'
  xferDlg.value = true
}

/** 收文件：下拉选协议 → 系统目录选择框 → 确认开始 */
async function onRecvFile(proto: TransferProtocol): Promise<void> {
  if (!open.value) {
    ElMessage.warning('串口未打开')
    return
  }
  const pick = (await window.api.invoke('serial', 'file:pick-dir', props.panelId)) as {
    ok: boolean
    path?: string
  }
  if (!pick.ok || !pick.path) return
  xferProtocol.value = proto
  xferPath.value = pick.path
  xferKind.value = 'recv'
  xferDlg.value = true
}

async function startXfer(): Promise<void> {
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
  unsubs.push(
    window.api.on('serial', props.panelId, 'data', (p) => {
      const d = p as DataEvt
      updateBytesThrottled(d.rxBytes, d.txBytes)
      pushRaw('RX', d.text)
      termView.value?.write(d.text)
    }),
    window.api.on('serial', props.panelId, 'tx', (p) => {
      const d = p as DataEvt
      updateBytesThrottled(d.rxBytes, d.txBytes)
      pushRaw('TX', d.text)
    }),
    window.api.on('serial', props.panelId, 'status', (p) => {
      const s = p as { open: boolean; error?: string }
      open.value = s.open
      if (!s.open) {
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
    window.api.on('serial', props.panelId, 'transfer', onTransferEvt)
  )
  const res = (await window.api.invoke('serial', 'attach', props.panelId)) as {
    config: SerialConfig
  }
  config.value = res.config
  Object.assign(params, res.config.last)
  termFont.value = config.value.termFont || 'Consolas'
  termFontSize.value = config.value.termFontSize || 13
  xferProtocol.value = config.value.xferProtocol || 'ymodem'
  autoLog.value = config.value.autoLog !== false
  if (config.value.sidebarWidth) sidebarWidth.value = config.value.sidebarWidth
  termView.value?.info('就绪。选择串口后点击「打开」，终端内可直接输入命令。')
  await refreshPorts()
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  stopLoop()
  stopSignalPoll()
  window.api.invoke('serial', 'dispose', props.panelId).catch(() => {})
})

async function refreshPorts(): Promise<void> {
  ports.value = (await window.api.invoke('serial', 'list', props.panelId)) as PortInfo[]
  // 串口列表带回填 COM 口后，标签随所选端口即时更新（便于开多个窗口区分）
  if (params.path) tabStore.rename(props.panelId, `${params.path}@${params.baudRate}`)
}

// ---------- 开关串口 ----------
async function openPort(): Promise<void> {
  if (!params.path) {
    ElMessage.warning('请选择串口')
    return
  }
  opening.value = true
  const res = (await window.api.invoke('serial', 'open', props.panelId, { ...params })) as {
    ok: boolean
    error?: string
  }
  opening.value = false
  if (res.ok) {
    open.value = true
    dtrOn.value = true
    rtsOn.value = true
    // 真正拉高 DTR/RTS（仅改 UI 状态不下发时，部分需要复位才能工作的设备会卡住）
    await window.api.invoke('serial', 'dtr', props.panelId, { on: true }).catch(() => {})
    await window.api.invoke('serial', 'rts', props.panelId, { on: true }).catch(() => {})
    termView.value?.info(`已打开 ${params.path} @ ${params.baudRate}，终端内可直接输入`)
    tabStore.rename(props.panelId, `${params.path}@${params.baudRate}`)
    persistConfig()
    startSignalPoll()
    termView.value?.focus()
  } else {
    ElMessage.error(`打开失败：${res.error}`)
  }
}

async function closePort(): Promise<void> {
  stopSignalPoll()
  await window.api.invoke('serial', 'close', props.panelId)
  open.value = false
  tabStore.rename(props.panelId, `${params.path}@${params.baudRate}`)
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

function send(): void {
  doSend(sendText.value, sendMode.value, sendNewline.value)
}

function startLoop(): void {
  if (loopOn.value) return
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
function clearTerm(): void {
  ringBuf.length = 0
  termView.value?.clear()
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function saveLog(): void {
  const content = ringBuf
    .map(
      (r) =>
        `[${fmtTime(r.time)}] ${r.dir.padEnd(4)} ${r.text.replace(/[\r\n\t]/g, (c) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' })[c] ?? c)}`
    )
    .join('\r\n')
  // 文件名带时分秒，以创建时间为准（主进程按此默认名弹出保存框，目录重启记忆）
  const now = new Date()
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  const safeName = params.path.replace(/[\\/:*?"<>|]/g, '_') || 'com'
  const name = `serial-${safeName}-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.log`
  void window.api
    .invoke('serial', 'log:save', props.panelId, { content, name })
    .then((res) => {
      if ((res as { ok: boolean }).ok) ElMessage.success('日志已保存')
    })
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
  if (res.ok && res.dir) ElMessage.success(`日志保存目录已设为：${res.dir}`)
}

// ---------- 会话与配置 ----------
async function persistConfig(): Promise<void> {
  if (!config.value) return
  config.value.last = { ...params }
  config.value.termFont = termFont.value
  config.value.termFontSize = termFontSize.value
  config.value.autoLog = autoLog.value
  config.value.sidebarWidth = sidebarWidth.value
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
  if (s) Object.assign(params, s.params)
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
    <!-- 连接工具栏：打开后参数区收起，只留 COM 口徽标 -->
    <div class="panel-section">
      <div class="conn-bar">
        <template v-if="!open">
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
          <el-button
            type="primary"
            size="small"
            :icon="CaretRight"
            :loading="opening"
            @click="openPort"
          >
            打开
          </el-button>
        </template>
        <template v-else>
          <el-tag type="success" size="large" class="com-badge" effect="dark">
            {{ params.path }}
          </el-tag>
          <el-button type="danger" size="small" :icon="CircleClose" @click="closePort">
            断开
          </el-button>
        </template>
        <el-divider direction="vertical" />
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
        <el-divider direction="vertical" />
        <el-input
          v-model="sessionName"
          size="small"
          placeholder="会话名"
          style="width: 110px"
        />
        <el-button size="small" :icon="Plus" @click="saveSession">存为会话</el-button>
      </div>
    </div>

    <div class="body">
      <!-- 会话库 + 快捷命令宏（全局共享）；宽度可拖动调整 -->
      <div class="sessions" :style="{ width: sidebarWidth + 'px' }">
        <div class="sessions-head">
          <span>会话</span>
          <span class="hint">点击载入参数</span>
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
          暂无会话。配置好参数后输入名称保存。
        </div>

        <QuickCmdManager :enabled="open" :writer="macroWriter" />
      </div>

      <!-- 拖动调整会话栏宽度（VS Code 式分隔条） -->
      <div class="sidebar-split" title="拖动调整宽度" @mousedown="onSidebarResize"></div>

      <!-- 终端 + 发送 -->
      <div class="term-col">
        <div class="term-opts">
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
          <el-tooltip content="字号（Ctrl+滚轮 或 Ctrl+= / Ctrl+- / Ctrl+0 缩放）" placement="top">
            <el-select v-model="termFontSize" size="small" filterable style="width: 74px">
              <el-option v-for="s in TERM_SIZES" :key="s" :value="s" :label="String(s)" />
            </el-select>
          </el-tooltip>
          <el-tooltip content="设备不回显的裸模块勾选后，终端可看到自己敲入的字符" placement="top">
            <el-checkbox v-model="localEcho" size="small">本地回显</el-checkbox>
          </el-tooltip>
          <el-button size="small" text @click="clearTerm">清空</el-button>
          <el-button size="small" text :icon="Download" @click="saveLog">存日志</el-button>
          <el-dropdown trigger="click" @command="(cmd: string) => (cmd === 'set' ? setLogDir() : openLogDir())">
            <el-button size="small" text :icon="FolderOpened">日志目录</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="set">设置保存路径</el-dropdown-item>
                <el-dropdown-item command="open">打开保存路径</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip content="会话期间所有收发自动落盘（关闭后仅手动「存日志」）" placement="top">
            <el-checkbox v-model="autoLog" size="small" @change="persistConfig">自动保存日志</el-checkbox>
          </el-tooltip>
          <el-tooltip content="发送文件到设备：先选协议（YMODEM/ZMODEM），再选文件" placement="top">
            <el-dropdown
              :disabled="!open || transferring"
              trigger="click"
              @command="(proto: string) => onSendFile(proto as TransferProtocol)"
            >
              <el-button size="small" text :icon="UploadFilled" :disabled="!open || transferring">
                发文件
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="ymodem">YMODEM 发送</el-dropdown-item>
                  <el-dropdown-item command="zmodem">ZMODEM 发送</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-tooltip>
          <el-tooltip content="接收设备发来的文件：先选协议，再选保存目录" placement="top">
            <el-dropdown
              :disabled="!open || transferring"
              trigger="click"
              @command="(proto: string) => onRecvFile(proto as TransferProtocol)"
            >
              <el-button size="small" text :icon="Download" :disabled="!open || transferring">
                收文件
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="ymodem">YMODEM 接收</el-dropdown-item>
                  <el-dropdown-item command="zmodem">ZMODEM 接收</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-tooltip>
          <span class="counters">
            RX <b>{{ rxBytes }}</b> TX <b>{{ txBytes }}</b>
          </span>
        </div>
        <TerminalView
          ref="termView"
          v-model:font-size="termFontSize"
          :font="termFont"
          :local-echo="localEcho"
          @data="onTermData"
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
            <el-option value="crlf" label="\r\n" />
            <el-option value="lf" label="\n" />
            <el-option value="cr" label="\r" />
          </el-select>
          <el-dropdown
            v-if="history.length"
            trigger="click"
            @command="(cmd: string) => (sendText = cmd)"
          >
            <el-button size="small">历史</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="h in history" :key="h" :command="h">
                  {{ h.slice(0, 60) }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-input
            v-model="sendText"
            size="small"
            class="send-input mono"
            :placeholder="sendMode === 'hex' ? 'HEX：AA BB 01' : '输入要发送的内容'"
            :disabled="loopOn"
            @keydown.ctrl.enter="send"
          />
          <el-button type="primary" size="small" :icon="Connection" :disabled="!open || loopOn" @click="send">
            发送
          </el-button>
          <!-- 定时发送：默认收起，点「定时」展开 -->
          <el-tooltip content="定时循环发送（非常用功能，展开后可用）" placement="top">
            <el-button
              size="small"
              :type="loopOn ? 'danger' : loopPanel ? 'warning' : 'default'"
              @click="loopPanel = !loopPanel"
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

    <!-- 传输确认 -->
    <el-dialog v-model="xferDlg" :title="xferKind === 'send' ? '发送文件到设备' : '接收设备发来的文件'" width="400px" append-to-body>
      <el-form label-width="80px" size="small" @submit.prevent>
        <el-form-item :label="xferKind === 'send' ? '发送文件' : '保存目录'">
          <div class="xfer-path">{{ xferPath }}</div>
        </el-form-item>
        <el-form-item label="传输协议">
          <el-tag size="small" effect="plain">{{ xferProtocol.toUpperCase() }}</el-tag>
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
        <el-button type="primary" @click="startXfer">开始传输</el-button>
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
  </div>
</template>

<style scoped>
.serial-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.mono {
  font-family: var(--font-mono);
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.conn-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.sig {
  display: inline-flex;
  gap: 4px;
}

.body {
  display: flex;
  gap: 6px;
  flex: 1;
  min-height: 0;
}

.sessions {
  flex: 0 0 auto;
  min-width: 150px;
  border-right: 1px solid var(--el-border-color-lighter);
  padding-right: 14px;
  overflow-y: auto;
}

/* 拖动调宽分隔条（VS Code 式）：平时 4px，悬停/拖动高亮 */
.sidebar-split {
  flex: 0 0 4px;
  margin: 0 -2px;
  cursor: col-resize;
  border-radius: 2px;
  z-index: 5;
}

.sidebar-split:hover {
  background: var(--el-color-primary);
  opacity: 0.5;
}

.sessions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  margin: 4px 0 8px;
}

.session-item {
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.session-item:hover {
  background: var(--el-fill-color);
}

.session-item.active {
  background: var(--el-fill-color-darker);
}

.session-name {
  font-size: 13px;
}

.session-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.com-badge {
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: 0.5px;
}

.term-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 8px;
}

.term-opts {
  display: flex;
  align-items: center;
  gap: 12px;
}

.counters {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.counters b {
  color: var(--el-color-success);
  font-family: var(--font-mono);
}

.send-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.send-input {
  flex: 1;
  min-width: 200px;
}

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

.xfer-path {
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-all;
  color: var(--el-text-color-regular);
}

.xfer-count {
  text-align: right;
}
</style>
