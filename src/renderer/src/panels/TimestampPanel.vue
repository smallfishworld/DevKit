<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'

/** 自动识别 s / ms / us / ns / 0xHEX 时间戳 */
function parseTs(input: string): number | null {
  const t = input.trim()
  if (!t) return null
  let n: number
  if (/^0x[0-9a-f]+$/i.test(t)) {
    n = parseInt(t.slice(2), 16)
  } else if (/^-?\d+$/.test(t)) {
    n = parseInt(t, 10)
  } else {
    const v = Date.parse(t)
    return Number.isNaN(v) ? null : v
  }
  if (!Number.isFinite(n)) return null
  const abs = Math.abs(n)
  if (abs < 1e11) return n * 1000 // 秒
  if (abs < 1e14) return n // 毫秒
  if (abs < 1e17) return Math.round(n / 1000) // 微秒
  return Math.round(n / 1e6) // 纳秒
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, '0')
}

function fmtLocal(ms: number): string {
  const d = new Date(ms)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 星期${week}`
  )
}

function fmtUtc(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

const nowMs = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => (nowMs.value = Date.now()), 500)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const tsInput = ref('')
const dateInput = ref('')

const parsed = computed(() => parseTs(tsInput.value))

const result = computed(() => {
  if (parsed.value === null) return null
  const ms = parsed.value
  const d = new Date(ms)
  return {
    ms,
    local: fmtLocal(ms),
    utc: fmtUtc(ms),
    iso: d.toISOString(),
    sec: Math.floor(ms / 1000),
    msStr: ms.toString(),
    hexSec: '0x' + Math.floor(ms / 1000).toString(16).toUpperCase(),
    hexMs: '0x' + ms.toString(16).toUpperCase(),
    rel: (() => {
      const diff = ms - Date.now()
      const abs = Math.abs(diff)
      const unit =
        abs < 60000
          ? `${(abs / 1000).toFixed(1)} 秒`
          : abs < 3600000
            ? `${(abs / 60000).toFixed(1)} 分钟`
            : abs < 86400000
              ? `${(abs / 3600000).toFixed(1)} 小时`
              : `${(abs / 86400000).toFixed(1)} 天`
      return diff >= 0 ? `${unit} 后` : `${unit} 前`
    })()
  }
})

function useNow(): void {
  tsInput.value = nowMs.value.toString()
}

function useNowSec(): void {
  tsInput.value = Math.floor(nowMs.value / 1000).toString()
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制')
}

function fromDate(): void {
  if (!dateInput.value) {
    ElMessage.warning('请先选择日期时间')
    return
  }
  const ms = new Date(dateInput.value).getTime()
  if (Number.isNaN(ms)) {
    ElMessage.error('日期格式无效')
    return
  }
  tsInput.value = ms.toString()
}
</script>

<template>
  <div class="panel ts-panel">
    <div class="panel-section">
      <h3>当前时间</h3>
      <div class="now-row mono">
        <div class="now-item">
          <span class="lbl">Unix 秒</span>
          <b>{{ Math.floor(nowMs / 1000) }}</b>
          <el-button size="small" text :icon="CopyDocument" @click="copy(Math.floor(nowMs / 1000).toString())" />
        </div>
        <div class="now-item">
          <span class="lbl">Unix 毫秒</span>
          <b>{{ nowMs }}</b>
          <el-button size="small" text :icon="CopyDocument" @click="copy(nowMs.toString())" />
        </div>
        <div class="now-item">
          <span class="lbl">本地时间</span>
          <b>{{ fmtLocal(nowMs) }}</b>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <h3>时间戳 → 日期</h3>
      <div class="row">
        <el-input
          v-model="tsInput"
          class="mono"
          placeholder="输入时间戳：秒 / 毫秒 / 微秒 / 纳秒 / 0xHEX / 日期文本均可"
          style="flex: 1"
          clearable
        />
        <el-button size="small" @click="useNowSec">当前(秒)</el-button>
        <el-button size="small" @click="useNow">当前(毫秒)</el-button>
      </div>
      <template v-if="tsInput && result">
        <el-descriptions :column="2" border size="small" style="margin-top: 10px">
          <el-descriptions-item label="本地时间">{{ result.local }}</el-descriptions-item>
          <el-descriptions-item label="UTC">{{ result.utc }}</el-descriptions-item>
          <el-descriptions-item label="ISO 8601">{{ result.iso }}</el-descriptions-item>
          <el-descriptions-item label="相对当前">{{ result.rel }}</el-descriptions-item>
          <el-descriptions-item label="秒级时间戳">
            {{ result.sec }}
            <el-button size="small" text :icon="CopyDocument" @click="copy(result.sec.toString())" />
          </el-descriptions-item>
          <el-descriptions-item label="毫秒级时间戳">
            {{ result.msStr }}
            <el-button size="small" text :icon="CopyDocument" @click="copy(result.msStr)" />
          </el-descriptions-item>
          <el-descriptions-item label="HEX(秒)">
            {{ result.hexSec }}
            <el-button size="small" text :icon="CopyDocument" @click="copy(result.hexSec)" />
          </el-descriptions-item>
          <el-descriptions-item label="HEX(毫秒)">
            {{ result.hexMs }}
            <el-button size="small" text :icon="CopyDocument" @click="copy(result.hexMs)" />
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <el-alert
        v-else-if="tsInput && !result"
        type="error"
        :closable="false"
        title="无法解析的时间戳"
        style="margin-top: 10px"
      />
    </div>

    <div class="panel-section">
      <h3>日期 → 时间戳</h3>
      <div class="row">
        <el-date-picker
          v-model="dateInput"
          type="datetime"
          placeholder="选择日期时间"
          format="YYYY-MM-DD HH:mm:ss"
          style="flex: 1"
        />
        <el-button size="small" type="primary" @click="fromDate">转换到上方</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ts-panel {
  overflow: auto;
}

.mono,
.now-item b {
  font-family: var(--font-mono);
}

.now-row {
  display: flex;
  gap: 40px;
  flex-wrap: wrap;
}

.now-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.now-item .lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
