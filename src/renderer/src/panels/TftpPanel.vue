<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Folder, FolderOpened } from '@element-plus/icons-vue'
import type { TransferInfo } from '../../../shared/types'

const props = defineProps<{ panelId: string }>()

const FIREWALL_HINT =
  '设备连不上时请放行 Windows 防火墙，管理员运行：netsh advfirewall firewall add rule ' +
  'name="DevKit-TFTP" dir=in action=allow protocol=UDP localport=69' +
  '（数据会话使用随机高位端口，建议直接放行本程序）。'

const port = ref(69)
const root = ref('')
const running = ref(false)
const starting = ref(false)
const logs = ref<{ line: string; time: number }[]>([])
const transfers = ref<TransferInfo[]>([])
const transferMap = new Map<number, TransferInfo>()

onMounted(async () => {
  // 读取上次使用的端口/根目录（无保存记录时服务端返回默认值）
  const res = (await window.api.invoke('tftp', 'config:get', props.panelId)) as {
    port: number
    root: string
  }
  if (Number.isFinite(res.port) && res.port >= 1 && res.port <= 65535) port.value = res.port
  root.value = res.root
})

/** 端口+根目录持久化：启动成功与选择目录时各回写一次 */
function persistConfig(): void {
  void window.api
    .invoke('tftp', 'config:set', props.panelId, { port: port.value, root: root.value })
    .catch(() => {})
}

function fmtBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function upsertTransfer(info: TransferInfo): void {
  const idx = transferMap.get(info.id)
  if (idx) {
    Object.assign(idx, info, { startedAt: idx.startedAt })
  } else {
    transferMap.set(info.id, { ...info })
    transfers.value.unshift(transferMap.get(info.id) as TransferInfo)
    if (transfers.value.length > 50) {
      const removed = transfers.value.pop()
      if (removed) transferMap.delete(removed.id)
    }
  }
}

let unsubList: Array<() => void> = []

async function startServer(): Promise<void> {
  starting.value = true
  unsubList.forEach((u) => u())
  unsubList = [
    window.api.on('tftp', props.panelId, 'log', (payload) => {
      logs.value.unshift(payload as { line: string; time: number })
      if (logs.value.length > 200) logs.value.pop()
    }),
    window.api.on('tftp', props.panelId, 'transfer', (payload) => {
      upsertTransfer(payload as TransferInfo)
    }),
    window.api.on('tftp', props.panelId, 'dir-picked', (payload) => {
      root.value = (payload as { root: string }).root
      persistConfig()
    })
  ]
  const res = (await window.api.invoke('tftp', 'start', props.panelId, {
    port: port.value,
    root: root.value
  })) as { ok: boolean; error?: string }
  starting.value = false
  if (res.ok) {
    running.value = true
    persistConfig()
    ElMessage.success(`TFTP 服务器已启动 :${port.value}`)
  } else {
    ElMessage.error(`启动失败: ${res.error}`)
  }
}

async function stopServer(): Promise<void> {
  await window.api.invoke('tftp', 'stop', props.panelId)
  running.value = false
  ElMessage.info('TFTP 服务器已停止')
}

function pickDir(): void {
  void window.api.invoke('tftp', 'pick-dir', props.panelId)
}

function openDir(): void {
  void window.api.invoke('tftp', 'open-dir', props.panelId, { root: root.value })
}

onUnmounted(() => {
  unsubList.forEach((u) => u())
  window.api.invoke('tftp', 'dispose', props.panelId).catch(() => {})
})
</script>

<template>
  <div class="panel">
    <!-- 配置区 -->
    <div class="panel-section">
      <h3>服务器配置</h3>
      <div class="panel-row">
        <span>端口</span>
        <el-input-number v-model="port" :min="1" :max="65535" :disabled="running" size="small" />
        <span>根目录</span>
        <el-input
          v-model="root"
          size="small"
          style="width: 320px"
          :disabled="running"
          placeholder="设备下载/上传的目录"
        />
        <el-button size="small" :icon="Folder" :disabled="running" @click="pickDir">
          选择目录
        </el-button>
        <el-button size="small" :icon="FolderOpened" @click="openDir">打开目录</el-button>
        <el-button
          v-if="!running"
          type="primary"
          size="small"
          :loading="starting"
          @click="startServer"
        >
          启动
        </el-button>
        <el-button v-else type="danger" size="small" @click="stopServer">停止</el-button>
        <el-tag :type="running ? 'success' : 'info'">
          {{ running ? `运行中 UDP :${port}` : '已停止' }}
        </el-tag>
      </div>
      <el-alert
        type="info"
        :closable="false"
        style="margin-top: 10px"
        title="防火墙提示"
        :description="FIREWALL_HINT"
      />
    </div>

    <!-- 传输列表 -->
    <div class="panel-section">
      <h3>传输记录</h3>
      <el-table :data="transfers" height="240" size="small" style="width: 100%">
        <el-table-column label="方向" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.dir === 'rrq' ? 'primary' : 'warning'">
              {{ row.dir === 'rrq' ? '设备下载' : '设备上传' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="filename" label="文件" min-width="160" show-overflow-tooltip />
        <el-table-column prop="peer" label="客户端" width="140" />
        <el-table-column label="进度" width="180">
          <template #default="{ row }">
            <el-progress
              v-if="row.totalBytes > 0"
              :percentage="Math.min(100, Math.round((row.transferred / row.totalBytes) * 100))"
              :status="row.done ? (row.ok ? 'success' : 'exception') : undefined"
            />
            <span v-else>{{ row.done ? (row.ok ? '完成' : '失败') : '传输中…' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已传" width="110">
          <template #default="{ row }">{{ fmtBytes(row.transferred) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag v-if="!row.done" size="small">进行中</el-tag>
            <el-tag v-else-if="row.ok" size="small" type="success">完成</el-tag>
            <el-tooltip v-else :content="row.error ?? ''">
              <el-tag size="small" type="danger">失败</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 日志 -->
    <div class="panel-section">
      <h3>日志</h3>
      <div class="log-box mono">
        <div v-for="(log, i) in logs" :key="i" class="log-line">
          <span class="log-time">{{ new Date(log.time).toLocaleTimeString() }}</span>
          {{ log.line }}
        </div>
        <div v-if="logs.length === 0" class="log-empty">暂无日志</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: var(--font-mono);
}

.log-box {
  height: 180px;
  overflow-y: auto;
  background: var(--el-fill-color-darker);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}

.log-line {
  line-height: 1.7;
  word-break: break-all;
}

.log-time {
  color: var(--el-text-color-secondary);
  margin-right: 8px;
}

.log-empty {
  color: var(--el-text-color-secondary);
}
</style>
