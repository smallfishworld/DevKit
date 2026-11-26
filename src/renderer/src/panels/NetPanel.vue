<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { Connection, Delete, Promotion } from '@element-plus/icons-vue'
import SerialDevicePlugins from '@renderer/components/SerialDevicePlugins.vue'
import type { NetConfig, NetMode, NetParams } from '../../../shared/net'
import { DEFAULT_NET_PARAMS } from '../../../shared/net'
import { useTabStore } from '@renderer/stores/tabs'

const ElMessage = usePanelMessage()
const { t, locale } = useI18n()

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()

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

/** 标签页随模式与地址命名 */
watch(
  [params, locale],
  () => {
    const label =
      params.mode === 'tcp-server'
        ? t('net.tabTcpServer', { port: params.localPort })
        : params.mode === 'tcp-client'
          ? t('net.tabTcpClient', { host: params.host, port: params.port })
          : t('net.tabUdp', { port: params.localPort })
    tabStore.rename(props.panelId, label)
  },
  { deep: true, immediate: true }
)

const modeLabel = computed(
  () => ({ 'tcp-server': t('net.tcpServer'), 'tcp-client': t('net.tcpClient'), udp: t('net.udp') })[activeMode.value]
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
      pushLine('tx', d.target || (activeMode.value === 'tcp-client' ? params.host : t('net.broadcast')), d.text, d.hex, d.time)
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
      ElMessage.warning(t('net.netError', { message: (p as { message: string }).message }))
    })
  )
  const res = (await window.api.invoke('net', 'attach', props.panelId)) as { config: NetConfig }
  Object.assign(params, res.config.last)
  displayHex.value = res.config.displayHex
  showTimestamp.value = res.config.showTimestamp
  pushLine('info', t('net.readyInfo'), '', '', Date.now())
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
        ? t('net.listeningInfo', { port: params.localPort })
        : params.mode === 'tcp-client'
          ? t('net.connectedInfo', { host: params.host, port: params.port })
          : t('net.udpBoundInfo', { localPort: params.localPort, host: params.host, port: params.port })
    pushLine('info', desc, '', '', Date.now())
  } else {
    ElMessage.error(t('net.startFailed', { error: res.error ?? '' }))
  }
}

async function stop(): Promise<void> {
  stopLoop()
  await window.api.invoke('net', 'stop', props.panelId)
  running.value = false
  clients.value = []
  pushLine('info', t('net.stopped'), '', '', Date.now())
}

// ---------- 发送 ----------
function doSend(text: string, mode: 'ascii' | 'hex', newline: 'none' | 'crlf' | 'lf' | 'cr'): void {
  if (!running.value) {
    ElMessage.warning(t('net.notStarted'))
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
    ElMessage.warning(t('net.enterContentFirst'))
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
          <el-radio-button value="tcp-server">{{ t('net.tcpServer') }}</el-radio-button>
          <el-radio-button value="tcp-client">{{ t('net.tcpClient') }}</el-radio-button>
          <el-radio-button value="udp">{{ t('net.udp') }}</el-radio-button>
        </el-radio-group>

        <template v-if="params.mode === 'tcp-server'">
          <span class="lbl">{{ t('net.localPort') }}</span>
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
          <span class="lbl">{{ t('net.targetAddress') }}</span>
          <el-input v-model="params.host" :disabled="running" size="small" style="width: 170px" />
          <span class="lbl">{{ t('net.port') }}</span>
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
          <span class="lbl">{{ t('net.localPort') }}</span>
          <el-input-number
            v-model="params.localPort"
            :min="1"
            :max="65535"
            :controls="false"
            size="small"
            :disabled="running"
            style="width: 96px"
          />
          <span class="lbl">{{ t('net.targetAddress') }}</span>
          <el-input v-model="params.host" :disabled="running" size="small" style="width: 150px" />
          <span class="lbl">{{ t('net.port') }}</span>
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
          {{ params.mode === 'tcp-client' ? t('net.connect') : t('net.start') }}
        </el-button>
        <el-button v-else type="danger" size="small" @click="stop">{{ t('net.stop') }}</el-button>
        <el-tag size="small" :type="running ? 'success' : 'info'">
          {{ running ? t('net.runningStatus', { mode: modeLabel }) : t('net.stopped') }}
        </el-tag>
        <span class="counters">
          RX <b>{{ rxBytes }}</b> TX <b>{{ txBytes }}</b>
        </span>
      </div>

      <!-- TCP Server 客户端列表 -->
      <div v-if="params.mode === 'tcp-server' && clients.length" class="client-row">
        <el-radio-group v-model="targetId" size="small">
          <el-radio-button value="">{{ t('net.broadcastAll') }}</el-radio-button>
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
      <el-checkbox v-model="showTimestamp" size="small">{{ t('net.timestamp') }}</el-checkbox>
      <el-checkbox v-model="paused" size="small">{{ t('net.pauseScroll') }}</el-checkbox>
      <el-button size="small" text @click="clearTerm">{{ t('net.clear') }}</el-button>
      <SerialDevicePlugins :panel-id="props.panelId" :connected="running" transport="net" />
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
        <el-option value="none" :label="t('net.noNewline')" />
        <el-option value="crlf" label="\r\n" />
        <el-option value="lf" label="\n" />
        <el-option value="cr" label="\r" />
      </el-select>
      <el-input
        v-model="sendText"
        size="small"
        class="send-input mono"
        :placeholder="sendMode === 'hex' ? t('net.hexPlaceholder') : t('net.asciiPlaceholder')"
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
        {{ t('net.send') }}
      </el-button>
      <template v-if="!loopOn">
        <el-input-number v-model="loopPeriod" :min="20" :step="100" size="small" style="width: 100px" />
        <el-button size="small" :icon="Delete" @click="startLoop">{{ t('net.loop') }}</el-button>
      </template>
      <el-button v-else type="danger" size="small" @click="stopLoop">{{ t('net.stopLoop') }}</el-button>
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
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-all;
}

.term-line.is-tx .term-text {
  color: var(--el-color-warning);
}

.term-line.is-info .term-text {
  color: var(--el-text-color-secondary);
  font-style: italic;
}

.term-time {
  color: var(--el-text-color-placeholder);
  margin-right: 8px;
  font-size: 12px;
}

.term-arrow {
  color: var(--el-color-warning);
}

.term-dot {
  color: var(--el-text-color-placeholder);
}

.term-peer {
  color: var(--el-color-primary);
  font-size: 12px;
}

.send-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.send-input {
  flex: 1;
  min-width: 220px;
}
</style>
