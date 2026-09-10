<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, Delete, Promotion } from '@element-plus/icons-vue'
import type { NetConfig, NetMode, NetParams } from '../../../shared/net'
import { DEFAULT_NET_PARAMS } from '../../../shared/net'

const props = defineProps<{ panelId: string }>()

interface PeerInfo {
  id: string
  remote: string
}

interface TermLine {
  dir: 'rx' | 'tx' | 'info'
  peer: string
  text: string
  hex: string
  time: number
}

interface DataEvt {
  hex: string
  text: string
  bytes: number
  time: number
  peer: string
  rxBytes: number
  txBytes: number
}

const params = reactive<NetParams>({ ...DEFAULT_NET_PARAMS })
const running = ref(false)
const activeMode = computed<NetMode>(() => params.mode)
const rxBytes = ref(0)
const txBytes = ref(0)
const clients = ref<PeerInfo[]>([])
const targetId = ref('') // TCP Server：空 = 广播

const lines = ref<TermLine[]>([])
const displayHex = ref(false)
const showTimestamp = ref(false)
const paused = ref(false)
const termBox = ref<HTMLElement | null>(null)

const sendMode = ref<'ascii' | 'hex'>('ascii')
const sendText = ref('')
const sendNewline = ref<'none' | 'crlf' | 'lf' | 'cr'>('crlf')
const loopOn = ref(false)
const loopPeriod = ref(1000)
let loopTimer: ReturnType<typeof setInterval> | null = null

let unsubs: Array<() => void> = []

const modeLabel = computed(
  () => ({ 'tcp-server': 'TCP 服务端', 'tcp-client': 'TCP 客户端', udp: 'UDP' })[activeMode.value]
)

// ---------- 初始化 ----------
onMounted(async () => {
  unsubs.push(
    window.api.on('net', props.panelId, 'data', (p) => {
      const d = p as DataEvt
      rxBytes.value = d.rxBytes
      txBytes.value = d.txBytes
      pushLine('rx', d.peer, d.text, d.hex, d.time)
    }),
    window.api.on('net', props.panelId, 'tx', (p) => {
      const d = p as DataEvt & { target: string }
      rxBytes.value = d.rxBytes
      txBytes.value = d.txBytes
      pushLine('tx', d.target || (activeMode.value === 'tcp-client' ? params.host : '广播'), d.text, d.hex, d.time)
    }),
    window.api.on('net', props.panelId, 'clients', (p) => {
      clients.value = (p as { clients: PeerInfo[] }).clients
    }),
    window.api.on('net', props.panelId, 'status', (p) => {
      const s = p as { running: boolean; params: NetParams | null }
      running.value = s.running
      if (!s.running) {
        clients.value = []
        stopLoop()
      }
    }),
    window.api.on('net', props.panelId, 'error', (p) => {
      ElMessage.warning(`网络错误：${(p as { message: string }).message}`)
    })
  )
  const res = (await window.api.invoke('net', 'attach', props.panelId)) as { config: NetConfig }
  Object.assign(params, res.config.last)
  displayHex.value = res.config.displayHex
  showTimestamp.value = res.config.showTimestamp
  pushLine('info', '就绪。选择模式后点击「启动 / 连接」。', '', '', Date.now())
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  stopLoop()
  window.api.invoke('net', 'dispose', props.panelId).catch(() => {})
})

function pushLine(dir: TermLine['dir'], peer: string, text: string, hex: string, time: number): void {
  lines.value.push({ dir, peer, text, hex, time })
  if (lines.value.length > 5000) lines.value.splice(0, lines.value.length - 5000)
  if (!paused.value) {
    void nextTick(() => {
      const box = termBox.value
      if (box) box.scrollTop = box.scrollHeight
    })
  }
}

// ---------- 启停 ----------
async function start(): Promise<void> {
  const res = (await window.api.invoke('net', 'start', props.panelId, { ...params })) as {
    ok: boolean
    error?: string
  }
  if (res.ok) {
    running.value = true
    const desc =
      params.mode === 'tcp-server'
        ? `TCP 服务端监听 :${params.localPort}`
        : params.mode === 'tcp-client'
          ? `已连接 ${params.host}:${params.port}`
          : `UDP 绑定 :${params.localPort}，目标 ${params.host}:${params.port}`
    pushLine('info', desc, '', '', Date.now())
  } else {
    ElMessage.error(`启动失败：${res.error}`)
  }
}

async function stop(): Promise<void> {
  stopLoop()
  await window.api.invoke('net', 'stop', props.panelId)
  running.value = false
  clients.value = []
  pushLine('info', '已停止', '', '', Date.now())
}

// ---------- 发送 ----------
function doSend(text: string, mode: 'ascii' | 'hex', newline: 'none' | 'crlf' | 'lf' | 'cr'): void {
  if (!running.value) {
    ElMessage.warning('未启动')
    return
  }
  window.api
    .invoke('net', 'send', props.panelId, {
      mode,
      text,
      newline,
      targetId: params.mode === 'tcp-server' ? targetId.value || undefined : undefined
    })
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
  lines.value = []
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function lineBody(l: TermLine): string {
  const shown = displayHex.value ? l.hex : l.text
  return shown.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

// ---------- 配置 ----------
async function persistConfig(): Promise<void> {
  const cfg: NetConfig = {
    last: { ...params },
    displayHex: displayHex.value,
    showTimestamp: showTimestamp.value
  }
  await window.api.invoke('net', 'config:set', props.panelId, cfg)
}
</script>

<template>
  <div class="panel net-panel">
    <!-- 模式与参数 -->
    <div class="panel-section">
      <div class="conn-bar">
        <el-radio-group v-model="params.mode" :disabled="running" size="small" @change="persistConfig">
          <el-radio-button value="tcp-server">TCP 服务端</el-radio-button>
          <el-radio-button value="tcp-client">TCP 客户端</el-radio-button>
          <el-radio-button value="udp">UDP</el-radio-button>
        </el-radio-group>

        <template v-if="params.mode === 'tcp-server'">
          <span class="lbl">本地端口</span>
          <el-input-number
            v-model="params.localPort"
            :min="1"
            :max="65535"
            :controls="false"
            size="small"
            :disabled="running"
            style="width: 100px"
          />
        </template>

        <template v-else-if="params.mode === 'tcp-client'">
          <span class="lbl">目标地址</span>
          <el-input v-model="params.host" :disabled="running" size="small" style="width: 170px" />
          <span class="lbl">端口</span>
          <el-input-number
            v-model="params.port"
            :min="1"
            :max="65535"
            :controls="false"
            size="small"
            :disabled="running"
            style="width: 100px"
          />
        </template>

        <template v-else>
          <span class="lbl">本地端口</span>
          <el-input-number
            v-model="params.localPort"
            :min="1"
            :max="65535"
            :controls="false"
            size="small"
            :disabled="running"
            style="width: 96px"
          />
          <span class="lbl">目标地址</span>
          <el-input v-model="params.host" :disabled="running" size="small" style="width: 150px" />
          <span class="lbl">端口</span>
          <el-input-number
            v-model="params.port"
            :min="1"
            :max="65535"
            :controls="false"
            size="small"
            :disabled="running"
            style="width: 90px"
          />
        </template>

        <el-button
          v-if="!running"
          type="primary"
          size="small"
          :icon="Connection"
          @click="start"
        >
          {{ params.mode === 'tcp-client' ? '连接' : '启动' }}
        </el-button>
        <el-button v-else type="danger" size="small" @click="stop">停止</el-button>
        <el-tag :type="running ? 'success' : 'info'">
          {{ running ? `${modeLabel} 运行中` : '已停止' }}
        </el-tag>
        <span class="counters">
          RX <b>{{ rxBytes }}</b> TX <b>{{ txBytes }}</b>
        </span>
      </div>

      <!-- TCP Server 客户端列表 -->
      <div v-if="params.mode === 'tcp-server' && clients.length" class="client-row">
        <el-radio-group v-model="targetId" size="small">
          <el-radio-button value="">全部广播</el-radio-button>
          <el-radio-button v-for="c in clients" :key="c.id" :value="c.id">
            {{ c.remote }}
          </el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 终端 -->
    <div class="term-opts">
      <el-radio-group v-model="displayHex" size="small">
        <el-radio-button :value="false">ASCII</el-radio-button>
        <el-radio-button :value="true">HEX</el-radio-button>
      </el-radio-group>
      <el-checkbox v-model="showTimestamp" size="small">时间戳</el-checkbox>
      <el-checkbox v-model="paused" size="small">暂停滚动</el-checkbox>
      <el-button size="small" text @click="clearTerm">清空</el-button>
    </div>
    <div ref="termBox" class="term mono">
      <div v-for="(l, i) in lines" :key="i" class="term-line" :class="`is-${l.dir}`">
        <span v-if="showTimestamp" class="term-time">{{ fmtTime(l.time) }}</span>
        <span v-if="l.dir === 'tx'" class="term-arrow">→ </span>
        <span v-else-if="l.dir === 'info'" class="term-dot">• </span>
        <span v-if="l.peer && l.dir !== 'info'" class="term-peer">[{{ l.peer }}] </span>
        <span class="term-text">{{ lineBody(l) }}</span>
      </div>
    </div>

    <!-- 发送区 -->
    <div class="send-bar">
      <el-select v-model="sendMode" size="small" style="width: 82px" :disabled="loopOn">
        <el-option value="ascii" label="ASCII" />
        <el-option value="hex" label="HEX" />
      </el-select>
      <el-select v-model="sendNewline" size="small" style="width: 92px" :disabled="loopOn">
        <el-option value="none" label="无换行" />
        <el-option value="crlf" label="\r\n" />
        <el-option value="lf" label="\n" />
        <el-option value="cr" label="\r" />
      </el-select>
      <el-input
        v-model="sendText"
        size="small"
        class="send-input mono"
        :placeholder="sendMode === 'hex' ? 'HEX：AA BB 01' : '输入要发送的内容'"
        :disabled="loopOn"
        @keydown.ctrl.enter="send"
      />
      <el-button
        type="primary"
        size="small"
        :icon="Promotion"
        :disabled="!running || loopOn"
        @click="send"
      >
        发送
      </el-button>
      <template v-if="!loopOn">
        <el-input-number v-model="loopPeriod" :min="20" :step="100" size="small" style="width: 100px" />
        <el-button size="small" :icon="Delete" @click="startLoop">循环</el-button>
      </template>
      <el-button v-else type="danger" size="small" @click="stopLoop">停止循环</el-button>
    </div>
  </div>
</template>

<style scoped>
.net-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
  overflow: hidden;
}

.mono {
  font-family: var(--font-mono);
}

.lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.conn-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.client-row {
  margin-top: 8px;
  display: flex;
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

.term-opts {
  display: flex;
  align-items: center;
  gap: 12px;
}

.term {
  flex: 1;
  min-height: 240px;
  overflow-y: auto;
  background: #101418;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  color: #cfd8dc;
  white-space: pre-wrap;
  word-break: break-all;
}

.term-line.is-tx .term-text {
  color: #ffd54f;
}

.term-line.is-info .term-text {
  color: #78909c;
  font-style: italic;
}

.term-time {
  color: #546e7a;
  margin-right: 8px;
  font-size: 11px;
}

.term-arrow {
  color: #ffb300;
}

.term-dot {
  color: #546e7a;
}

.term-peer {
  color: #7ba3cc;
  font-size: 11px;
}

.send-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.send-input {
  flex: 1;
  min-width: 220px;
}
</style>
