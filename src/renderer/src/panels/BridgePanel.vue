<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Delete, Refresh, VideoPlay, VideoPause } from '@element-plus/icons-vue'
import type {
  BridgeChannelStatus,
  BridgeIdentityConfig,
  BridgeSharedFormat
} from '../../../shared/bridge-protocol'
import { MAX_UI_LOG } from '../../../shared/bridge-protocol'
import { useTabStore } from '@renderer/stores/tabs'

const props = defineProps<{ panelId: string }>()
const tabStore = useTabStore()

/** 标签页随身份命名，多开可区分：服务端 → 串口TCP桥接·服务端:9999；客户端 → 串口TCP桥接·客户端 192.168.1.10:9999 */
function syncTabTitle(): void {
  tabStore.rename(
    props.panelId,
    mode.value === 'server'
      ? `串口TCP桥接·服务端:${remotePort.value}`
      : `串口TCP桥接·客户端 ${remoteHost.value}:${remotePort.value}`
  )
}

// ---------- 状态 ----------

const mode = ref<'server' | 'client'>('server')
const remoteHost = ref('127.0.0.1')
const remotePort = ref(9999)
/** 服务端模式：管理端口开关；客户端模式：连接开关 */
const remoteOn = ref(false)
/** 管理连接运行状态（服务端=监听中，客户端=已连接） */
const remoteRunning = ref(false)

const identities = ref<string[]>([])
const lastIdentity = ref('')
/** 下拉当前选中（= 面板当前身份派生名） */
const currentIdentity = ref('')

const identity = reactive<BridgeIdentityConfig>({
  mode: 'server',
  remoteHost: '127.0.0.1',
  remotePort: 9999,
  remoteOn: false,
  shared: { dataBits: 8, parity: 'none', stopBits: 1, flowCtrl: 'none' },
  allowMulti: true,
  telnetMode: true,
  channels: []
})
/** 共享串口格式（面板始终持有完整格式，独立 reactive 便于模板直接绑定） */
const shared = reactive<BridgeSharedFormat>({ dataBits: 8, parity: 'none', stopBits: 1, flowCtrl: 'none' })
/** 8 通道界面行（与主进程配置同步的一份） */
const rows = reactive(
  Array.from({ length: 8 }, (_, i) => ({
    cid: i + 1,
    port: '',
    baudRate: 115200,
    tcpPort: 10000 + i + 1,
    running: false,
    clients: 0,
    rx: 0,
    tx: 0
  }))
)

const ports = ref<Array<{ path: string; friendlyName: string }>>([])
/** 本机 IPv4（服务端模式下拉展示）+ 默认出口 IP */
const ips = ref<Array<{ address: string; name: string }>>([])
const egressIp = ref('')

interface LogLine {
  time: number
  level: 'log' | 'info' | 'error'
  text: string
}
const logs = ref<LogLine[]>([])
const paused = ref(false)
const logBox = ref<HTMLElement | null>(null)

/** 任一通道运行中 → 共享格式锁定 */
const anyRunning = computed(() => rows.some((r) => r.running))
const remotePortInUse = computed(() => remoteRunning.value)

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

let unsubs: Array<() => void> = []

// ---------- 初始化 ----------

onMounted(async () => {
  unsubs.push(
    window.api.on('bridge', props.panelId, 'log', (p) => {
      const d = p as { cid: number; level: string; text: string }
      pushLog((d.level as LogLine['level']) ?? 'log', d.text)
    }),
    window.api.on('bridge', props.panelId, 'channel-status', (p) => {
      const d = p as { cid: number; text: string }
      const row = rows[d.cid - 1]
      if (row) row.running = d.text === '运行中'
    }),
    window.api.on('bridge', props.panelId, 'clients', (p) => {
      const d = p as { cid: number; count: number }
      const row = rows[d.cid - 1]
      if (row) row.clients = d.count
    }),
    window.api.on('bridge', props.panelId, 'remote', (p) => {
      const d = p as { state: string }
      if (d.state === 'connected' || d.state === 'disconnected') {
        remoteRunning.value = d.state === 'connected'
      } else if (d.state === 'identity-switched') {
        void refreshStatus()
      }
    }),
    window.api.on('bridge', props.panelId, 'remote-status', (p) => {
      const d = p as { channels: BridgeChannelStatus[]; shared: { allow_multi: boolean } | null }
      for (const ch of d.channels ?? []) {
        const row = rows[ch.cid - 1]
        if (!row) continue
        row.running = ch.running
        row.clients = ch.clients
        row.rx = ch.rx_bytes
        row.tx = ch.tx_bytes
        // 远端当前参数显示（本地未运行时跟随远端配置）
        if (!ch.running) {
          row.port = ch.port || row.port
          row.baudRate = ch.baudrate || row.baudRate
          row.tcpPort = ch.tcp_port || row.tcpPort
        }
      }
    }),
    window.api.on('bridge', props.panelId, 'remote-config-applied', (p) => {
      const d = p as { cid: number }
      pushLog('info', `远端已更新 CH${d.cid} 配置`)
    })
  )

  const res = (await window.api.invoke('bridge', 'attach', props.panelId)) as {
    identity: BridgeIdentityConfig
    identities: Record<string, BridgeIdentityConfig>
    lastIdentity: string
  }
  applyIdentity(res.identity)
  identities.value = Object.keys(res.identities ?? {}).sort()
  lastIdentity.value = res.lastIdentity
  currentIdentity.value = res.lastIdentity
  await refreshPorts()
  await refreshStatus()
  void refreshIps()
  counterTimer = setInterval(() => {
    if (mode.value === 'server') void refreshCounters()
  }, 300)
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  if (counterTimer) {
    clearInterval(counterTimer)
    counterTimer = null
  }
  window.api.invoke('bridge', 'dispose', props.panelId).catch(() => {})
})

function applyIdentity(cfg: BridgeIdentityConfig): void {
  mode.value = cfg.mode
  remoteHost.value = cfg.remoteHost
  remotePort.value = cfg.remotePort
  remoteOn.value = cfg.remoteOn
  Object.assign(shared, cfg.shared ?? { dataBits: 8, parity: 'none', stopBits: 1, flowCtrl: 'none' })
  identity.allowMulti = cfg.allowMulti ?? true
  identity.telnetMode = true // telnet 解析恒开，无 UI 开关
  for (let i = 0; i < 8; i++) {
    const ch = cfg.channels[i] ?? {}
    const row = rows[i]
    row.cid = i + 1
    row.port = String(ch.port ?? '')
    row.baudRate = Number(ch.baudRate ?? 115200)
    row.tcpPort = Number(ch.tcpPort ?? 10000 + i + 1)
    row.running = false
    row.clients = 0
    row.rx = 0
    row.tx = 0
  }
  syncTabTitle()
}

/** 本地配置改动 → 推给主进程持久化 */
async function persistIdentity(): Promise<void> {
  const cfg: BridgeIdentityConfig = {
    mode: mode.value,
    remoteHost: remoteHost.value,
    remotePort: remotePort.value,
    remoteOn: remoteOn.value,
    shared: { ...shared },
    allowMulti: identity.allowMulti,
    telnetMode: true, // telnet 解析恒开，无 UI 开关
    channels: rows.map((r) => ({ cid: r.cid, port: r.port, baudRate: r.baudRate, tcpPort: r.tcpPort }))
  }
  const res = (await window.api.invoke('bridge', 'config:set', props.panelId, cfg)) as { ok: boolean }
  if (!res.ok) ElMessage.error('配置保存失败')
  const listRes = (await window.api.invoke('bridge', 'config:list-identities', props.panelId)) as {
    identities: string[]
  }
  identities.value = listRes.identities
  // 身份随 host/port/mode 变化重派生
  const st = (await window.api.invoke('bridge', 'status', props.panelId)) as { identity: string }
  currentIdentity.value = st.identity
  syncTabTitle()
}

async function refreshPorts(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'list', props.panelId)) as Array<{
    path: string
    friendlyName: string
  }>
  ports.value = res ?? []
}

async function refreshIps(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'list-ips', props.panelId)) as {
    ips: Array<{ address: string; name: string }>
    egress: string
  }
  ips.value = res?.ips ?? []
  egressIp.value = res?.egress ?? ''
  // 服务端模式下当前 host 不在本机 IP 列表 → 选默认出口 IP
  if (mode.value === 'server' && ips.value.length) {
    const addrs = ips.value.map((i) => i.address)
    if (!addrs.includes(remoteHost.value)) {
      remoteHost.value = egressIp.value || addrs[0]
      await persistIdentity()
    }
  }
}

async function refreshStatus(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'status', props.panelId)) as {
    channels: BridgeChannelStatus[]
    remoteServerRunning: boolean
    remoteClientRunning: boolean
    identity: string
  }
  if (!res) return
  for (const ch of res.channels ?? []) {
    const row = rows[ch.cid - 1]
    if (!row) continue
    row.running = ch.running
    row.clients = ch.clients
    row.rx = ch.rx_bytes
    row.tx = ch.tx_bytes
    if (!ch.running) {
      row.port = ch.port || row.port
      row.baudRate = ch.baudrate || row.baudRate
      row.tcpPort = ch.tcp_port || row.tcpPort
    }
  }
  remoteRunning.value = res.remoteServerRunning || res.remoteClientRunning
  currentIdentity.value = res.identity
}

/**
 * 字节计数轮询（300ms）：
 * 只刷运行状态/客户端数/RX/TX，不碰 port/波特率/端口——避免打断正在编辑的参数。
 * 仅服务端模式轮询；客户端模式靠服务端主动推送（remote-status 事件）。
 */
async function refreshCounters(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'status', props.panelId)) as {
    channels: BridgeChannelStatus[]
  } | null
  if (!res?.channels) return
  for (const ch of res.channels) {
    const row = rows[ch.cid - 1]
    if (!row) continue
    row.running = ch.running
    row.clients = ch.clients
    row.rx = ch.rx_bytes
    row.tx = ch.tx_bytes
  }
}

let counterTimer: ReturnType<typeof setInterval> | null = null

// ---------- 模式切换 / 身份 ----------

async function switchMode(m: 'server' | 'client'): Promise<void> {
  mode.value = m
  await persistIdentity()
  if (m === 'server') await refreshIps() // 服务端模式同步本机 IP 下拉
  await refreshStatus()
}

async function onIdentityChange(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'config:switch-identity', props.panelId, {
    identity: currentIdentity.value
  })) as { ok: boolean; identity: BridgeIdentityConfig }
  if (!res.ok) {
    ElMessage.error('切换身份失败')
    return
  }
  applyIdentity(res.identity)
  pushLog('info', `已切换身份: ${currentIdentity.value}`)
  await refreshStatus()
}

async function deleteIdentity(): Promise<void> {
  if (!currentIdentity.value) return
  try {
    await ElMessageBox.confirm(`删除身份「${currentIdentity.value}」的配置？`, '删除身份', {
      type: 'warning'
    })
  } catch {
    return
  }
  const res = (await window.api.invoke('bridge', 'config:delete-identity', props.panelId, {
    identity: currentIdentity.value
  })) as { ok: boolean; remaining: string[] }
  if (!res.ok) return
  identities.value = res.remaining
  ElMessage.success('已删除')
  // 切到剩余的第一个身份（或新建默认）
  if (res.remaining.length) {
    currentIdentity.value = res.remaining[0]
    await onIdentityChange()
  } else {
    pushLog('info', '无剩余身份，将新建默认 server_9999')
  }
}

// ---------- 远程管理 ----------

async function toggleRemote(): Promise<void> {
  if (mode.value === 'server') {
    if (remoteRunning.value) {
      await window.api.invoke('bridge', 'remote-server:stop', props.panelId)
      remoteRunning.value = false
      remoteOn.value = false
      pushLog('info', '远程管理服务已停止')
      await persistIdentity()
    } else {
      const res = (await window.api.invoke('bridge', 'remote-server:start', props.panelId, {
        port: remotePort.value
      })) as { ok: boolean; error?: string }
      if (res.ok) {
        remoteRunning.value = true
        remoteOn.value = true
        pushLog('info', `远程管理服务已启动: 0.0.0.0:${remotePort.value}`)
        await persistIdentity()
        void refreshIps()
      } else {
        ElMessage.error(`管理端口启动失败：${res.error}`)
      }
    }
  } else {
    if (remoteRunning.value) {
      await window.api.invoke('bridge', 'remote:disconnect', props.panelId)
      remoteRunning.value = false
      remoteOn.value = false
      pushLog('info', '已断开管理连接')
      await persistIdentity()
    } else {
      const res = (await window.api.invoke('bridge', 'remote:connect', props.panelId, {
        host: remoteHost.value,
        port: remotePort.value
      })) as { ok: boolean; error?: string }
      if (res.ok) {
        remoteOn.value = true
        pushLog('info', `已连接到远端管理服务: ${remoteHost.value}:${remotePort.value}`)
        await persistIdentity()
      } else {
        ElMessage.error(`连接失败：${res.error}`)
      }
    }
  }
}

/** 客户端模式：向远端发管理命令 */
function remoteSend(cmd: string, kv: Record<string, unknown> = {}): void {
  if (!remoteRunning.value) {
    ElMessage.warning('请先连接远端')
    return
  }
  window.api
    .invoke('bridge', 'remote:send', props.panelId, { cmd, ...kv })
    .then((res) => {
      if (!(res as { ok: boolean }).ok) ElMessage.warning('发送失败')
    })
    .catch(() => {})
}

// ---------- 通道操作 ----------

async function startRow(row: (typeof rows)[number]): Promise<void> {
  const res = (await window.api.invoke('bridge', 'start', props.panelId, {
    cid: row.cid,
    port: row.port,
    baudRate: row.baudRate,
    tcpPort: row.tcpPort
  })) as true | string
  if (res !== true) {
    ElMessage.error(`CH${row.cid} 启动失败：${res}`)
  } else {
    row.running = true
  }
}

async function stopRow(row: (typeof rows)[number]): Promise<void> {
  await window.api.invoke('bridge', 'stop', props.panelId, { cid: row.cid })
  row.running = false
  row.clients = 0
}

async function startAll(): Promise<void> {
  const res = (await window.api.invoke('bridge', 'start-all', props.panelId)) as {
    ok: boolean
    errors: string[]
  }
  if (res.errors?.length) {
    ElMessage.warning(`全部启动：${res.errors.length} 路未启动（详见日志）`)
    res.errors.forEach((e) => pushLog('error', e))
  }
  await refreshStatus()
}

async function stopAll(): Promise<void> {
  await window.api.invoke('bridge', 'stop-all', props.panelId)
  await refreshStatus()
}

function breakRow(row: (typeof rows)[number]): void {
  window.api
    .invoke('bridge', 'break', props.panelId, { cid: row.cid })
    .then((res) => {
      if (!(res as { ok: boolean }).ok) ElMessage.warning(`CH${row.cid} 未运行`)
      else pushLog('info', `CH${row.cid} Break 已发送`)
    })
    .catch(() => {})
}

// ---------- 日志 ----------

function pushLog(level: LogLine['level'], text: string): void {
  logs.value.push({ time: Date.now(), level, text })
  if (logs.value.length > MAX_UI_LOG) logs.value.splice(0, logs.value.length - MAX_UI_LOG)
  if (!paused.value) {
    void nextTick(() => {
      const box = logBox.value
      if (box) box.scrollTop = box.scrollHeight
    })
  }
}

function clearLogs(): void {
  logs.value = []
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
</script>

<template>
  <div class="panel bridge-panel">
    <!-- 模式 + 远程管理 -->
    <div class="panel-section">
      <div class="conn-bar">
        <el-radio-group
          :model-value="mode"
          size="small"
          :disabled="remoteRunning"
          @update:model-value="switchMode(($event as 'server' | 'client'))"
        >
          <el-radio-button value="server">服务端</el-radio-button>
          <el-radio-button value="client">客户端</el-radio-button>
        </el-radio-group>

        <template v-if="mode === 'server'">
          <span class="lbl">服务端IP:</span>
          <el-select
            v-model="remoteHost"
            size="small"
            :disabled="remoteRunning"
            style="width: 170px"
            @change="persistIdentity"
          >
            <el-option v-for="i in ips" :key="i.address" :value="i.address" :label="i.address" />
          </el-select>
        </template>
        <template v-else>
          <span class="lbl">服务端IP:</span>
          <el-input
            v-model="remoteHost"
            size="small"
            :disabled="remoteRunning"
            style="width: 150px"
            @change="persistIdentity"
          />
        </template>
        <span class="lbl">管理端口</span>
        <el-input-number
          v-model="remotePort"
          :min="1"
          :max="65535"
          :controls="false"
          size="small"
          :disabled="remoteRunning"
          style="width: 90px"
          @change="persistIdentity"
        />

        <el-button
          v-if="!remoteRunning"
          type="primary"
          size="small"
          :icon="Connection"
          @click="toggleRemote"
        >
          {{ mode === 'server' ? '启动管理' : '连接' }}
        </el-button>
        <el-button v-else type="danger" size="small" @click="toggleRemote">
          {{ mode === 'server' ? '停止管理' : '断开' }}
        </el-button>
        <el-tag :type="remoteRunning ? 'success' : 'info'" size="small">
          {{ remoteRunning ? (mode === 'server' ? '管理服务运行中' : '已连接远端') : '未连接' }}
        </el-tag>
      </div>

      <!-- 身份下拉 -->
      <div class="conn-bar identity-bar">
        <span class="lbl">配置身份</span>
        <el-select
          v-model="currentIdentity"
          size="small"
          filterable
          allow-create
          style="width: 220px"
          @change="onIdentityChange"
        >
          <el-option v-for="i in identities" :key="i" :value="i" :label="i" />
        </el-select>
        <el-button size="small" :icon="Delete" @click="deleteIdentity">删除</el-button>
      </div>
    </div>

    <!-- 客户端模式：远端控制条 -->
    <div v-if="mode === 'client' && remoteRunning" class="panel-section remote-bar">
      <el-button size="small" @click="remoteSend('get_channels')">刷新状态</el-button>
      <el-button size="small" @click="remoteSend('get_ports')">刷新串口</el-button>
      <el-button size="small" type="success" :icon="VideoPlay" @click="remoteSend('start_all')">全部启动</el-button>
      <el-button size="small" type="danger" :icon="VideoPause" @click="remoteSend('stop_all')">全部停止</el-button>
      <span class="lbl" style="margin-left: auto">客户端模式仅远程管理，本地不启通道</span>
    </div>

    <!-- 8 通道表 -->
    <div v-if="mode === 'server'" class="panel-section">
      <div class="conn-bar">
        <span class="lbl">串口格式（8 路共享）</span>
        <el-select v-model="shared.dataBits" size="small" :disabled="anyRunning" style="width: 72px" @change="persistIdentity">
          <el-option :value="5" label="5 位" />
          <el-option :value="6" label="6 位" />
          <el-option :value="7" label="7 位" />
          <el-option :value="8" label="8 位" />
        </el-select>
        <el-select v-model="shared.parity" size="small" :disabled="anyRunning" style="width: 80px" @change="persistIdentity">
          <el-option value="none" label="无校验" />
          <el-option value="even" label="偶校验" />
          <el-option value="odd" label="奇校验" />
          <el-option value="mark" label="Mark" />
          <el-option value="space" label="Space" />
        </el-select>
        <el-select v-model="shared.stopBits" size="small" :disabled="anyRunning" style="width: 72px" @change="persistIdentity">
          <el-option :value="1" label="1 位" />
          <el-option :value="1.5" label="1.5 位" />
          <el-option :value="2" label="2 位" />
        </el-select>
        <el-select v-model="shared.flowCtrl" size="small" :disabled="anyRunning" style="width: 96px" @change="persistIdentity">
          <el-option value="none" label="无流控" />
          <el-option value="xonxoff" label="XON/XOFF" />
          <el-option value="rtscts" label="RTS/CTS" />
        </el-select>
        <el-divider direction="vertical" />
        <el-checkbox v-model="identity.allowMulti" size="small" @change="persistIdentity">多客户端</el-checkbox>
      </div>

      <el-table :data="rows" size="small" class="ch-table">
        <el-table-column label="CH" width="46">
          <template #default="{ row }">
            <b>CH{{ row.cid }}</b>
          </template>
        </el-table-column>
        <el-table-column label="串口" min-width="170">
          <template #default="{ row }">
            <el-select
              v-model="row.port"
              size="small"
              filterable
              :disabled="row.running"
              placeholder="选择串口"
              @change="persistIdentity"
            >
              <el-option
                v-for="p in ports"
                :key="p.path"
                :value="p.path"
                :label="p.friendlyName ? `${p.path}  (${p.friendlyName})` : p.path"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="波特率" width="110">
          <template #default="{ row }">
            <el-select v-model="row.baudRate" size="small" :disabled="row.running" @change="persistIdentity">
              <el-option v-for="b in BAUDS" :key="b" :value="b" :label="String(b)" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="TCP 端口" width="100">
          <template #default="{ row }">
            <el-input-number
              v-model="row.tcpPort"
              :min="1"
              :max="65535"
              :controls="false"
              size="small"
              :disabled="row.running"
              style="width: 84px"
              @change="persistIdentity"
            />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="72">
          <template #default="{ row }">
            <el-tag :type="row.running ? 'success' : 'info'" size="small">
              {{ row.running ? '运行' : '停止' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="客户端" width="64">
          <template #default="{ row }">
            <span class="mono">{{ row.clients }}</span>
          </template>
        </el-table-column>
        <el-table-column label="RX / TX 字节" min-width="150">
          <template #default="{ row }">
            <span class="mono">{{ row.rx }} / {{ row.tx }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="!row.running"
              type="primary"
              size="small"
              text
              @click="startRow(row)"
            >
              启动
            </el-button>
            <el-button v-else type="danger" size="small" text @click="stopRow(row)">停止</el-button>
            <el-button size="small" text :disabled="!row.running" @click="breakRow(row)">Break</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="conn-bar table-actions">
        <el-button type="success" size="small" :icon="VideoPlay" @click="startAll">全部启动</el-button>
        <el-button type="danger" size="small" :icon="VideoPause" @click="stopAll">全部停止</el-button>
        <el-button size="small" :icon="Refresh" @click="refreshPorts">刷新串口</el-button>
        <el-button size="small" :icon="Delete" @click="clearLogs">清空日志</el-button>
        <el-checkbox v-model="paused" size="small" style="margin-left: auto">暂停滚动</el-checkbox>
      </div>
    </div>

    <!-- 日志区 -->
    <div ref="logBox" class="logbox mono">
      <div v-for="(l, i) in logs" :key="i" class="log-line" :class="`is-${l.level}`">
        <span class="log-time">{{ fmtTime(l.time) }}</span>
        <span class="log-text">{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bridge-panel {
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
  white-space: nowrap;
}

.conn-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.identity-bar {
  margin-top: 10px;
}

.remote-bar {
  gap: 8px;
}

.ch-table {
  margin-top: 10px;
  width: 100%;
}

/* 表格下方的操作栏：与表格保持呼吸感 */
.table-actions {
  margin-top: 12px;
}

/* 表格行内小按钮间距收紧 */
:deep(.ch-table .el-button + .el-button) {
  margin-left: 6px;
}

.logbox {
  flex: 1;
  min-height: 140px;
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

.log-line {
  display: flex;
  gap: 8px;
}

.log-time {
  color: #546e7a;
  font-size: 11px;
  flex-shrink: 0;
}

.log-line.is-error .log-text {
  color: #ef9a9a;
}

.log-line.is-info .log-text {
  color: #78909c;
  font-style: italic;
}

/* Element Plus 表格在暗色下紧凑 */
:deep(.el-table) {
  --el-table-border-color: var(--el-border-color-lighter);
}
</style>
