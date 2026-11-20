<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowRight,
  CircleClose,
  Connection,
  Delete,
  Download,
  Edit,
  FolderOpened,
  Key,
  Lock,
  Plus,
  Search
} from '@element-plus/icons-vue'
import TerminalView from '@renderer/components/TerminalView.vue'
import TerminalHistory from '@renderer/components/TerminalHistory.vue'
import { useTerminalStream } from '../composables/useTerminalStream'
import { ByteCounterThrottle } from '../../../shared/terminal-stream'
import QuickCmdManager from '@renderer/components/QuickCmdManager.vue'
import SerialDevicePlugins from '@renderer/components/SerialDevicePlugins.vue'
import type { SshConfig, SshParams } from '../../../shared/ssh'

import type { QuickCmdStep } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'
import { useSidebarDrag } from '../composables/useSidebarDrag'
import { useTabStore } from '@renderer/stores/tabs'

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()
const recentParams = tabStore.tabs.find((tab) => tab.id === props.panelId)?.sshParams

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
watch([open, connecting], ([connected, pending]) => {
  tabStore.setConnection(props.panelId, connected ? 'connected' : pending ? 'connecting' : 'disconnected')
}, { immediate: true })
const rxBytes = ref(0)
const txBytes = ref(0)

const termView = ref<InstanceType<typeof TerminalView> | null>(null)
useTerminalStream('ssh', props.panelId, termView)
const termFont = ref('Consolas')
const termFontSize = ref(13)
const TERM_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]

/** 顶部工具栏「已存预设」的当前选中项（只用于选择/删除） */
const presetName = ref('')
/** 保存预设时输入的名字；留空则用「用户名@主机」生成 */
const presetSaveName = ref('')
/** 保存预设的命名行是否展开；删除预设需要点两次确认 */
const presetSaving = ref(false)
const presetDeleteArmed = ref(false)

/** 左侧侧栏宽度（快捷命令栏，拖动分隔条调整，重启记忆） */
const sidebarWidth = ref(210)
const { onMouseDown: onSidebarResize } = useSidebarDrag(sidebarWidth, () => void persistConfig())
/** 左侧侧栏（快捷命令栏）显示/隐藏 */
const sidebarHidden = ref(false)
/** 折叠/展开整条侧栏（与快捷命令栏一起收起；重启记忆） */
function toggleSidebar(): void {
  sidebarHidden.value = !sidebarHidden.value
  void persistConfig()
}

/** 自动日志开关（连接期间收发自动落盘，默认开启；重启记忆） */
const autoLog = ref(true)
/** 终端时间戳显示（每批数据前插 [HH:MM:SS.mmm]，与日志格式一致；重启记忆） */
const showTime = ref(false)



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
const byteCounter = new ByteCounterThrottle((rx, tx) => {
  rxBytes.value = rx
  txBytes.value = tx
})
function updateBytesThrottled(rx: number, tx: number): void { byteCounter.update(rx, tx) }

// ---------- 初始化 ----------
onMounted(async () => {
  unsubs.push(
    window.api.on('ssh', props.panelId, 'data', (p) => {
      const d = p as DataEvt
      if (typeof d.rxBytes === 'number') updateBytesThrottled(d.rxBytes, d.txBytes)
    }),
    window.api.on('ssh', props.panelId, 'tx', (p) => {
      const d = p as DataEvt
      if (typeof d.rxBytes === 'number') updateBytesThrottled(d.rxBytes, d.txBytes)
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
    }),

  )
  const res = (await window.api.invoke('ssh', 'attach', props.panelId)) as { config: SshConfig }
  config.value = res.config
  Object.assign(params, res.config.last, recentParams ? { ...recentParams, password: '' } : undefined)
  if (params.host) rememberConnection()
  termFont.value = config.value.termFont || 'Consolas'
  termFontSize.value = config.value.termFontSize || 13
  autoLog.value = config.value.autoLog !== false
  showTime.value = config.value.showTime === true
  if (config.value.sidebarWidth) sidebarWidth.value = config.value.sidebarWidth
  sidebarHidden.value = config.value.sidebarHidden === true
  termView.value?.info('就绪。填写主机信息后点击「连接」，终端内直接输入命令。')
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  byteCounter.dispose()
  window.api.invoke('ssh', 'dispose', props.panelId).catch(() => {})
})

function rememberConnection(): void {
  const { host, port, username, authType, privateKeyPath } = params
  tabStore.setConnection(props.panelId, open.value ? 'connected' : 'disconnected', {
    sshParams: { host, port, username, authType, privateKeyPath }
  })
  tabStore.rename(props.panelId, `${username}@${host}`)
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
    termView.value?.info(`已连接 ${params.username}@${params.host}:${params.port}`)
    rememberConnection()
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
/** 工具栏「查找」按钮：展开终端查找栏（等效 Ctrl+F） */
function openTermSearch(): void {
  termView.value?.openSearch()
}

function clearTerm(): void {
  void window.api.invoke('ssh', 'output:reset', props.panelId).catch((error) => ElMessage.error(String(error)))
}

function saveLog(): void {
  // 从磁盘按块导出，日志正文不经渲染端。
  void window.api
    .invoke('ssh', 'log:mem-save', props.panelId)
    .then((res) => {
      const r = res as { ok: boolean; error?: string }
      if (r.ok) ElMessage.success('日志已保存')
      else if (r.error && r.error !== '已取消') ElMessage.warning(`存日志失败：${r.error}`)
    })
    .catch(() => {})
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
  if (res.ok && res.dir) ElMessage.success(`日志保存目录已设为：${res.dir}（新会话生效）`)
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
  config.value.sidebarHidden = sidebarHidden.value
  await window.api.invoke('ssh', 'config:set', props.panelId, JSON.parse(JSON.stringify(config.value)))
}

/** 展开「预设名」输入行（点「存为预设」先命名，避免弹框抢焦点把工具栏状态弄乱） */
function openSavePreset(): void {
  if (!params.host.trim()) {
    ElMessage.warning('请先填写主机')
    return
  }
  presetSaveName.value = presetName.value.trim() || `${params.username}@${params.host}`
  presetSaving.value = true
}

/** 把当前填写的主机/认证参数存成预设（同名覆盖） */
async function saveSession(): Promise<void> {
  if (!config.value) return
  if (!params.host.trim()) {
    ElMessage.warning('请先填写主机')
    return
  }
  const name = presetSaveName.value.trim() || `${params.username}@${params.host}`
  presetSaving.value = false
  const list = config.value.sessions.filter((s) => s.name !== name)
  list.unshift({ name, params: JSON.parse(JSON.stringify(params)) as SshParams })
  config.value.sessions = list
  presetName.value = name
  await persistConfig()
  ElMessage.success(`预设「${name}」已保存`)
}

/** 选中预设：套用其中的连接参数（不自动连接） */
function applyPreset(name: string | undefined): void {
  presetDeleteArmed.value = false
  const preset = sessions.value.find((s) => s.name === name)
  if (preset) Object.assign(params, preset.params)
}

/** 第一次点击进入待确认状态，再点一次才真正删除 */
function requestDeletePreset(): void {
  if (!presetDeleteArmed.value) {
    presetDeleteArmed.value = true
    return
  }
  void deleteSelectedPreset()
}

async function deleteSelectedPreset(): Promise<void> {
  presetDeleteArmed.value = false
  const preset = sessions.value.find((s) => s.name === presetName.value)
  if (!preset || !config.value) return
  config.value.sessions = config.value.sessions.filter((s) => s.name !== preset.name)
  presetName.value = ''
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
        <el-select
          v-model="presetName"
          size="small"
          filterable
          clearable
          placeholder="套用已存预设"
          aria-label="已存预设"
          style="width: 168px"
          @change="applyPreset"
        >
          <el-option
            v-for="item in sessions"
            :key="item.name"
            :value="item.name"
            :label="`${item.name}（${item.params.username}@${item.params.host}:${item.params.port}）`"
          />
        </el-select>
        <el-button size="small" :icon="Plus" title="把当前填写的参数保存为预设（同名覆盖）" @click="openSavePreset">存为预设</el-button>
        <el-button size="small" :type="presetDeleteArmed ? 'danger' : undefined"
          :aria-label="presetDeleteArmed ? '确认删除所选预设' : '删除所选预设'"
          :title="presetDeleteArmed ? '再点一次确认删除' : '删除所选预设'"
          :disabled="!presetName" @click="requestDeletePreset">
          <span v-if="presetDeleteArmed">确认</span><el-icon v-else><Delete /></el-icon>
        </el-button>
        <template v-if="presetSaving">
          <el-input
            v-model="presetSaveName"
            size="small"
            placeholder="预设名"
            aria-label="预设名"
            style="width: 150px"
            @keydown.enter="saveSession"
            @keydown.esc="presetSaving = false"
          />
          <el-button size="small" type="primary" @click="saveSession">保存</el-button>
          <el-button size="small" @click="presetSaving = false">取消</el-button>
        </template>
      </div>
    </div>

    <div class="body">
      <!-- 快捷命令栏；可拖动调宽，也可整体折叠/展开。
           连接参数预设收进了顶部工具栏的下拉里，侧栏不再单列一块。 -->
      <template v-if="!sidebarHidden">
        <div class="sessions" :style="{ width: sidebarWidth + 'px' }">
          <QuickCmdManager :enabled="open" :writer="macroWriter" />
          <p v-if="sessions.length" class="hint preset-note">⚠ 预设里的密码以明文保存在本机 config.json，请勿保存生产环境密码</p>
        </div>

        <!-- 拖动调整侧栏宽度（VS Code 式分隔条）；中央折叠把手 -->
        <div class="sidebar-split" title="拖动调整宽度" @mousedown="onSidebarResize">
          <button class="split-toggle" title="折叠快捷命令栏" @mousedown.stop @click="toggleSidebar">
            <svg viewBox="0 0 8 12" width="7" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 1L1.5 6l5 5" />
            </svg>
          </button>
        </div>
      </template>

      <!-- 折叠后的细条：点击展开侧栏 -->
      <div v-else class="sidebar-collapsed" :title="'展开快捷命令栏'" @click="toggleSidebar">
        <el-icon :size="16"><ArrowRight /></el-icon>
      </div>

      <!-- 终端 -->
      <div class="term-col">
        <div class="term-opts">
          <el-button size="small" text :icon="Search" title="查找（Ctrl+F）" @click="openTermSearch">查找</el-button>
          <el-button size="small" text @click="clearTerm">清屏</el-button>
          <el-button size="small" text :icon="Download" @click="saveLog">保存日志</el-button>
          <TerminalHistory tool="ssh" :panel-id="props.panelId" />
          <el-popover placement="bottom-start" :width="270" trigger="click">
            <template #reference><el-button size="small" text :icon="FolderOpened">日志设置</el-button></template>
          <el-tooltip content="连接期间所有收发自动落盘（关闭后仅手动「存日志」）" placement="top">
            <el-checkbox v-model="autoLog" size="small" title="新会话生效；关闭后使用临时历史，关闭面板或开始新会话时删除" @change="persistConfig">保留日志</el-checkbox>
          </el-tooltip>
            <div class="panel-row">
              <el-button size="small" @click="setLogDir">设置保存路径</el-button>
              <el-button size="small" @click="openLogDir">打开保存路径</el-button>
            </div>
          </el-popover>
          <el-popover placement="bottom-end" :width="280" trigger="click">
            <template #reference><el-button size="small" text>显示设置</el-button></template>
            <div class="ssh-display-settings">
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
          <el-tooltip content="每行前显示本地时间 [HH:MM:SS.mmm]，与日志落盘格式一致" placement="top">
            <el-checkbox v-model="showTime" size="small" @change="persistConfig">时间戳</el-checkbox>
          </el-tooltip>
            </div>
          </el-popover>
          <SerialDevicePlugins :panel-id="props.panelId" :connected="open" transport="ssh" />
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
.panel.ssh-panel { padding:0; gap:0; }
.ssh-panel > .panel-section { padding:9px 14px; border-width:0 0 1px; border-radius:0; background:var(--el-bg-color-overlay); }
.ssh-panel .body { gap:0; }
/* 顶部内边距与 .term-opts 的 7px 对齐：快捷命令标题与终端工具栏同一水平线 */
.ssh-panel .sessions { display:flex; flex-direction:column; padding:7px 12px 14px; overflow:hidden; background:var(--el-bg-color-overlay); }
.preset-note { flex:none; margin:12px 2px 0; padding-top:10px; border-top:1px solid var(--el-border-color-lighter); line-height:1.5; }
.ssh-panel .term-col { gap:0; }
.ssh-panel .term-opts { padding:7px 14px; flex-wrap:wrap; background:var(--el-bg-color-overlay); border-bottom:1px solid var(--el-border-color-lighter); }
.ssh-panel .term-col :deep(.term) { border:0; border-radius:0; box-shadow:none; padding:12px 14px; }
.ssh-display-settings { display:flex; flex-wrap:wrap; gap:8px; }

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
  gap: 10px;
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
  position: relative;
  z-index: 5;
}

.sidebar-split:hover {
  background: var(--el-color-primary);
  opacity: 0.5;
}

/* 分隔条中央的折叠把手：默认近乎隐没（透明底，只余浅灰细箭头），悬停才浮出底色与描边；
   mousedown.stop 避免点击把手被当成拖动调宽 */
.split-toggle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--el-text-color-placeholder);
  opacity: 0.45;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
  z-index: 6;
}

.sidebar-split:hover .split-toggle {
  opacity: 1;
}

.split-toggle:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--el-color-primary);
}

/* 折叠后的细条（VS Code 式）：占 16px，点击展开 */
.sidebar-collapsed {
  flex: 0 0 auto;
  width: 16px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: background 0.15s ease;
}

.sidebar-collapsed:hover {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
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
  flex-wrap: wrap;
  gap: 6px;
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
