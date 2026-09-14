<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleClose,
  Connection,
  Delete,
  Download,
  Edit,
  FolderOpened,
  Key,
  Lock,
  Plus
} from '@element-plus/icons-vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import QuickCmdManager from '@renderer/components/QuickCmdManager.vue'
import type { SshConfig, SshParams, SshSessionInfo } from '../../../shared/ssh'
import { cleanLogBody, estimateBytes, fileNameStamp, fmtStamp, splitTerminalLines } from '../../../shared/logtext'
import type { QuickCmdStep } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import { useTabStore } from '@renderer/stores/tabs'

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()

interface DataEvt {
  text: string
  bytes: number
  time: number
  rxBytes: number
  txBytes: number
}

// ---------- 状态 ----------
const config = ref<SshConfig | null>(null)
const params = reactive<SshParams>({
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: ''
})
const open = ref(false)
const connecting = ref(false)
const rxBytes = ref(0)
const txBytes = ref(0)

const termView = ref<InstanceType<typeof TerminalView> | null>(null)
const termFont = ref('Consolas')
const termFontSize = ref(13)
const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]

const sessionName = ref('')

/** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
const sidebarWidth = ref(210)
const { onMouseDown: onSidebarResize } = useSidebarDrag(sidebarWidth, () => void persistConfig())

/** 自动日志开关（连接期间收发自动落盘，默认开启；重启记忆） */
const autoLog = ref(true)
/** 终端时间戳显示（每批数据前插 [HH:MM:SS.mmm]，与日志格式一致；重启记忆） */
const showTime = ref(false)

/** 原始收发流水（供「存日志」导出；完整落盘由主进程自动日志负责）
 *  MobaXterm 式全量内存日志：不截断条数，按字节上限管理；超限弹窗并停止记录/显示，清屏后恢复 */
interface RawPiece {
  time: number
  /** 清洗后文本（剥 ANSI/归一行），与主进程落盘内容一致 */
  text: string
}
const ringBuf: RawPiece[] = []
/** 内存日志上限（字节，按 UTF-16 估算） */
const LOG_MEM_LIMIT = 500 * 1024 * 1024
let logBytes = 0
/** 超限后置位：停止记录与终端显示，清屏（或重连）后恢复 */
let logOverflow = false

let unsubs: Array<() => void> = []

const sessions = computed(() => config.value?.sessions ?? [])

// ---------- 快捷命令宏（全局共享，与串口助手同一份宏库与录制状态） ----------
const { recording, recordTermKey } = useTermMacros()

/** 宏步骤执行器：SSH 写法（命令追加 \r；按键原样） */
function macroWriter(st: QuickCmdStep): void {
  if (st.type === 'key') {
    window.api.invoke('ssh', 'write', props.panelId, { text: st.key ?? '' }).catch(() => {})
    return
  }
  const text = (st.text ?? '') + (st.crlf && st.mode !== 'hex' ? '\r' : '')
  window.api.invoke('ssh', 'write', props.panelId, { text }).catch(() => {})
}

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

// ---------- 初始化 ----------
onMounted(async () => {
  unsubs.push(
    window.api.on('ssh', props.panelId, 'data', (p) => {
      const d = p as DataEvt
      updateBytesThrottled(d.rxBytes, d.txBytes)
      pushRaw(d.text)
      if (!logOverflow) termView.value?.write(d.text)
    }),
    window.api.on('ssh', props.panelId, 'tx', (p) => {
      const d = p as DataEvt
      updateBytesThrottled(d.rxBytes, d.txBytes)
      pushRaw(d.text)
    }),
    window.api.on('ssh', props.panelId, 'status', (p) => {
      const s = p as { open: boolean; error?: string }
      open.value = s.open
      if (!s.open) {
        if (s.error) ElMessage.error(`SSH 已断开：${s.error}`)
        else termView.value?.info('连接已关闭')
      }
    }),
    window.api.on('ssh', props.panelId, 'error', (p) => {
      ElMessage.warning(`SSH 错误：${(p as { message: string }).message}`)
    })
  )
  const res = (await window.api.invoke('ssh', 'attach', props.panelId)) as { config: SshConfig }
  config.value = res.config
  Object.assign(params, res.config.last)
  termFont.value = config.value.termFont || 'Consolas'
  termFontSize.value = config.value.termFontSize || 13
  autoLog.value = config.value.autoLog !== false
  showTime.value = config.value.showTime === true
  if (config.value.sidebarWidth) sidebarWidth.value = config.value.sidebarWidth
  termView.value?.info('就绪。填写主机信息后点击「连接」，终端内直接输入命令。')
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  window.api.invoke('ssh', 'dispose', props.panelId).catch(() => {})
})

/** 日志管道的未完行尾巴（与主进程同一套按完整行切分，保证存日志与落盘一致） */
let lineCarry = ''

function pushRaw(text: string): void {
  if (logOverflow) return
  // 按完整行切分：最后一个 \n 之前才是完整行，之后（未完行/半个 \r\r\n 终止符）留给下一批，
  // 终止符跨批不产生幻影空行；行间空串 = 设备真实空行，照常保留
  const { lines, carry } = splitTerminalLines(lineCarry + text)
  lineCarry = carry
  if (lines.length === 0) return
  const cleaned = lines.map((l) => cleanLogBody(l)).join('\n')
  ringBuf.push({ time: Date.now(), text: cleaned })
  logBytes += estimateBytes(cleaned)
  if (logBytes > LOG_MEM_LIMIT) {
    // 内存日志超限：告知用户并停止记录/显示，清屏后恢复（MobaXterm 同款行为）
    logOverflow = true
    void ElMessageBox.alert(
      `会话内存日志已达上限（约 ${Math.round(LOG_MEM_LIMIT / 1024 / 1024)}MB）。已停止记录与显示，` +
        `清空终端后继续。请先「存日志」保留已收内容。`,
      '内存日志已满',
      { confirmButtonText: '知道了', type: 'warning' }
    ).catch(() => {})
  }
}

// ---------- 连接 ----------
async function connect(): Promise<void> {
  if (!params.host.trim()) {
    ElMessage.warning('请填写主机地址')
    return
  }
  connecting.value = true
  const res = (await window.api.invoke('ssh', 'connect', props.panelId, { ...params })) as {
    ok: boolean
    error?: string
  }
  connecting.value = false
  if (res.ok) {
    open.value = true
    // 重连 = 新会话：解除内存日志溢出锁定并清流水（旧缓冲已达上限时会立刻再次锁死）
    ringBuf.length = 0
    logBytes = 0
    logOverflow = false
    lineCarry = ''
    termView.value?.info(`已连接 ${params.username}@${params.host}:${params.port}`)
    tabStore.rename(props.panelId, `${params.username}@${params.host}`)
    persistConfig()
    termView.value?.focus()
  } else {
    ElMessage.error(`连接失败：${res.error}`)
  }
}

async function disconnect(): Promise<void> {
  await window.api.invoke('ssh', 'close', props.panelId)
  open.value = false
  tabStore.rename(props.panelId, `${params.username}@${params.host}`)
  termView.value?.info('已断开')
}

/** 键盘直入：原样发 SSH 通道（Enter 为 \r，由远端 pty 处理）；录制时同步记录 */
function onTermData(data: string): void {
  if (!open.value) return
  if (recording.value) recordTermKey(data)
  window.api.invoke('ssh', 'write', props.panelId, { text: data }).catch(() => {})
}

/** 终端尺寸变化：转发 setWindow，让 vim/top 等全屏程序正确布局 */
function onTermResize(size: { cols: number; rows: number }): void {
  if (!open.value) return
  window.api.invoke('ssh', 'resize', props.panelId, size).catch(() => {})
}

// ---------- 终端工具栏 ----------
function clearTerm(): void {
  // 清屏同时清内存流水并解除溢出锁定（先存日志再清，否则清掉的内容不可再导出）
  ringBuf.length = 0
  logBytes = 0
  logOverflow = false
  lineCarry = ''
  termView.value?.clear()
}

function saveLog(): void {
  // 内容与主进程自动落盘同格式：每行 [YYYY-MM-DD HH:MM:SS.mmm] 清洗后内容。
  // 每段 text 为按完整行切分的若干行（\n 分隔，无结尾终止符），按行重组逐行补戳
  const lines: string[] = []
  for (const r of ringBuf) {
    const stamp = fmtStamp(r.time, true)
    const body = r.text.endsWith('\n') ? r.text.slice(0, -1) : r.text
    for (const line of body.split('\n')) lines.push(`[${stamp}] ${line}`)
  }
  const content = lines.join('\r\n') + (lines.length ? '\r\n' : '')
  // 文件名 ssh-<主机>-<创建时刻 YYYYMMDD-HHMMSS>.log（主进程按此默认名弹保存框，目录重启记忆）
  const safeHost = params.host.replace(/[\\/:*?"<>|]/g, '_') || 'host'
  const name = `ssh-${safeHost}-${fileNameStamp()}.log`
  void window.api
    .invoke('ssh', 'log:save', props.panelId, { content, name })
    .then((res) => {
      if ((res as { ok: boolean }).ok) ElMessage.success('日志已保存')
    })
}

function openLogDir(): void {
  void window.api.invoke('ssh', 'log:open-dir', props.panelId).catch(() => {})
}

/** 设置手动「存日志」的保存目录（重启记忆） */
async function setLogDir(): Promise<void> {
  const res = (await window.api.invoke('ssh', 'log:set-dir', props.panelId)) as {
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
  config.value.showTime = showTime.value
  config.value.sidebarWidth = sidebarWidth.value
  await window.api.invoke('ssh', 'config:set', props.panelId, JSON.parse(JSON.stringify(config.value)))
}

async function saveSession(): Promise<void> {
  if (!config.value) return
  const name = sessionName.value.trim() || `${params.username}@${params.host}`
  const list = config.value.sessions.filter((s) => s.name !== name)
  list.unshift({ name, params: JSON.parse(JSON.stringify(params)) as SshParams })
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

/** 选择私钥文件（主进程对话框） */
async function pickKeyFile(): Promise<void> {
  const res = (await window.api.invoke('ssh', 'pick-key', props.panelId)) as {
    ok: boolean
    path?: string
  }
  if (res.ok && res.path) params.privateKeyPath = res.path
}
</script>

<template>
  <div class="panel ssh-panel">
    <!-- 连接工具栏：连接后参数区收起，只留主机徽标 -->
    <div class="panel-section">
      <div class="conn-bar">
        <template v-if="!open">
          <el-input
            v-model="params.host"
            placeholder="主机 IP 或主机名"
            size="small"
            style="width: 180px"
            @keydown.enter="connect"
          />
          <el-input-number
            v-model="params.port"
            :min="1"
            :max="65535"
            size="small"
            style="width: 96px"
            controls-position="right"
          />
          <el-input
            v-model="params.username"
            placeholder="用户名"
            size="small"
            style="width: 110px"
            @keydown.enter="connect"
          />
          <el-select v-model="params.authType" size="small" style="width: 96px">
            <el-option value="password" label="密码" />
            <el-option value="key" label="私钥" />
          </el-select>
          <el-input
            v-if="params.authType === 'password'"
            v-model="params.password"
            type="password"
            show-password
            placeholder="密码"
            size="small"
            style="width: 150px"
            @keydown.enter="connect"
          />
          <template v-else>
            <el-input
              v-model="params.privateKeyPath"
              placeholder="私钥文件路径"
              size="small"
              style="width: 200px"
            />
            <el-button size="small" :icon="FolderOpened" @click="pickKeyFile" />
          </template>
          <el-button
            type="primary"
            size="small"
            :icon="Connection"
            :loading="connecting"
            @click="connect"
          >
            连接
          </el-button>
        </template>
        <template v-else>
          <el-tag type="success" size="default" class="host-badge mono" effect="dark">
            {{ params.username }}@{{ params.host }}
          </el-tag>
          <el-button type="danger" size="small" :icon="CircleClose" @click="disconnect">
            断开
          </el-button>
        </template>
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
      <!-- 会话库；宽度可拖动调整 -->
      <div class="sessions" :style="{ width: sidebarWidth + 'px' }">
        <div class="sessions-head">
          <span>会话</span>
          <span class="hint">点击载入参数</span>
        </div>
        <div
          v-for="(s, i) in sessions"
          :key="s.name"
          class="session-item"
          :class="{ active: s.params.host === params.host && s.params.port === params.port }"
          @click="loadSession(i)"
        >
          <div class="session-name">{{ s.name }}</div>
          <div class="session-sub">
            {{ s.params.authType === 'key' ? `${s.params.username}@${s.params.host}:${s.params.port}` : `${s.params.username}@${s.params.host}:${s.params.port} · 密码` }}
            <el-button link type="danger" size="small" @click.stop="deleteSession(i)">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
        <div v-if="sessions.length === 0" class="hint" style="padding: 8px">
          暂无会话。连接成功后输入名称保存。
        </div>
        <div class="sessions-head" style="margin-top: 10px">
          <span class="hint">⚠ 密码明文保存在本机 config.json，请勿保存生产环境密码</span>
        </div>

        <QuickCmdManager :enabled="open" :writer="macroWriter" />
      </div>

      <!-- 拖动调整会话栏宽度（VS Code 式分隔条） -->
      <div class="sidebar-split" title="拖动调整宽度" @mousedown="onSidebarResize"></div>

      <!-- 终端 -->
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
          <el-button size="small" text @click="clearTerm">清空</el-button>
          <el-tooltip content="每行前显示本地时间 [HH:MM:SS.mmm]，与日志落盘格式一致" placement="top">
            <el-checkbox v-model="showTime" size="small" @change="persistConfig">时间戳</el-checkbox>
          </el-tooltip>
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
          <el-tooltip content="连接期间所有收发自动落盘（关闭后仅手动「存日志」）" placement="top">
            <el-checkbox v-model="autoLog" size="small" @change="persistConfig">自动保存日志</el-checkbox>
          </el-tooltip>
          <span class="counters">
            RX <b>{{ rxBytes }}</b> TX <b>{{ txBytes }}</b>
          </span>
        </div>
        <TerminalView
          ref="termView"
          v-model:font-size="termFontSize"
          :font="termFont"
          :show-time="showTime"
          @data="onTermData"
          @resize="onTermResize"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ssh-panel {
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

.host-badge {
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.5px;
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

.sessions-head .hint {
  font-weight: 400;
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
</style>
