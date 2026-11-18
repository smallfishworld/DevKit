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
const clockPaused = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    if (!clockPaused.value) nowMs.value = Date.now()
  }, 500)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const tsInput = ref('')
const dateInput = ref<Date | null>(null)
const dateResult = computed(() => {
  const ms = dateInput.value?.getTime()
  if (ms === undefined || Number.isNaN(ms)) return []
  const sec = Math.floor(ms / 1000)
  return [
    { label: 'Unix 秒', value: String(sec) },
    { label: 'Unix 毫秒', value: String(ms) },
    { label: 'HEX 秒', value: '0x' + sec.toString(16).toUpperCase() },
    { label: 'HEX 毫秒', value: '0x' + ms.toString(16).toUpperCase() }
  ]
})

const parsed = computed(() => parseTs(tsInput.value))

const result = computed(() => {
  if (parsed.value === null) return null
  const ms = parsed.value
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return null
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

function syncNow(): void {
  nowMs.value = Date.now()
  dateInput.value = new Date(nowMs.value)
  useNow()
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
  <div class="panel ts-panel converter-page">
    <header class="converter-head">
      <div>
        <h1>时间戳转换</h1>
        <p>秒、毫秒、微秒、纳秒、十六进制与日期互转</p>
      </div>
      <el-button size="small" type="primary" plain @click="syncNow">同步当前时刻</el-button>
    </header>
    <section class="clock-strip" aria-label="实时 Unix 时钟">
      <strong class="clock-state">{{ clockPaused ? '已暂停' : '实时时钟' }}</strong>
      <el-button size="small" @click="copy(Math.floor(nowMs / 1000).toString())">秒 (s) <code>{{ Math.floor(nowMs / 1000) }}</code></el-button>
      <el-button size="small" @click="copy(nowMs.toString())">毫秒 (ms) <code>{{ nowMs }}</code></el-button>
      <span class="clock-local">本地 <code>{{ fmtLocal(nowMs) }}</code></span>
      <div class="clock-actions">
        <el-button size="small" @click="useNow">填入下方解析</el-button>
        <el-button size="small" text :aria-pressed="clockPaused" @click="clockPaused = !clockPaused">{{ clockPaused ? '继续刷新' : '暂停刷新' }}</el-button>
      </div>
    </section>
    <div class="converter-split">
      <section class="panel-section">
        <h3>时间戳 → 日期时间</h3>
        <el-input v-model="tsInput" class="mono" aria-label="输入时间戳" placeholder="输入时间戳或日期字符串" clearable />
        <div class="converter-row">
          <el-button size="small" @click="useNowSec">当前秒</el-button>
          <el-button size="small" @click="useNow">当前毫秒</el-button>
        </div>
        <div v-if="result" class="result-grid">
          <button
            v-for="[label, value] in [
              ['本地时间', result.local], ['UTC', result.utc], ['ISO 8601', result.iso],
              ['相对当前', result.rel], ['Unix 秒', result.sec], ['Unix 毫秒', result.msStr],
              ['HEX 秒', result.hexSec], ['HEX 毫秒', result.hexMs]
            ]"
            :key="label" type="button" class="result-item" @click="copy(String(value))"
          >
            <span>{{ label }}</span><code>{{ value }}</code><el-icon><CopyDocument /></el-icon>
          </button>
        </div>
        <el-alert v-else-if="tsInput.trim()" type="error" :closable="false" title="无法解析的时间戳" />
      </section>
      <section class="panel-section">
        <h3>日期时间 → 时间戳</h3>
        <el-date-picker v-model="dateInput" type="datetime" aria-label="选择日期时间" placeholder="选择日期时间" format="YYYY-MM-DD HH:mm:ss" />
        <div class="converter-row">
          <el-button size="small" @click="dateInput = new Date()">当前时刻</el-button>
          <el-button size="small" type="primary" @click="fromDate">转换到左侧</el-button>
        </div>
        <div v-if="dateResult.length" class="result-grid">
          <button v-for="item in dateResult" :key="item.label" type="button" class="result-item" @click="copy(item.value)">
            <span>{{ item.label }}</span><code>{{ item.value }}</code><el-icon><CopyDocument /></el-icon>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mono, code { font-family:var(--font-mono); }
.clock-strip { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:9px 12px; background:var(--el-bg-color-overlay); border:1px solid var(--el-border-color-lighter); border-radius:8px; font-size:12px; }
.clock-strip .el-button { margin:0; }
.clock-state { color:var(--el-color-success); }
.clock-actions { display:flex; gap:5px; margin-inline-start:auto; }
.clock-local { color:var(--el-text-color-secondary); }
.result-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:8px; margin-top:10px; }
.result-item { display:grid; gap:4px 10px; grid-template-columns:minmax(0,1fr) auto; padding:8px 10px; border:1px solid var(--el-border-color-lighter); border-radius:7px; background:var(--el-bg-color-page); color:inherit; text-align:start; cursor:pointer; }
.result-item:hover { border-color:var(--el-color-primary); }
.result-item span { grid-column:1/-1; color:var(--el-text-color-secondary); font-size:12px; }
.result-item code { overflow-wrap:anywhere; }
</style>
