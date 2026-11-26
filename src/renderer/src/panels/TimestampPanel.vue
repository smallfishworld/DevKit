<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { CopyDocument } from '@element-plus/icons-vue'
import { encodeInteger, parseCalendarTime } from '../../../shared/converter-workbench'
import { useI18n } from 'vue-i18n'

const ElMessage = usePanelMessage()
const { t } = useI18n()

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
  const week = t(`timestamp.weekdays.${d.getDay()}`)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${t('timestamp.weekday', { day: week })}`
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
const dateInput = ref('')
const dateMillis = ref<number | string>(0)
const dateZone = ref<'local' | 'utc'>('local')
const reverseTime = computed(() => typeof dateMillis.value === 'number' ? parseCalendarTime(dateInput.value, dateMillis.value, dateZone.value) : null)

function setCalendar(ms: number): void {
  const d = new Date(ms)
  const calendar = dateZone.value === 'local' ? new Date(ms - d.getTimezoneOffset() * 60_000) : d
  dateInput.value = calendar.toISOString().slice(0, 19)
  dateMillis.value = d.getMilliseconds()
}
const dateResult = computed(() => {
  const ms = reverseTime.value
  if (ms === null) return []
  const sec = Math.floor(ms / 1000)
  return [
    { label: t('timestamp.unixSeconds'), value: String(sec) },
    { label: t('timestamp.unixMilliseconds'), value: String(ms) },
    { label: t('timestamp.hexSeconds'), value: '0x' + sec.toString(16).toUpperCase() },
    { label: t('timestamp.hexMilliseconds'), value: '0x' + ms.toString(16).toUpperCase() },
    { label: t('timestamp.littleEndianSeconds'), value: encodeInteger(BigInt(sec), 4).le }
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
          ? t('timestamp.signedSeconds', { value: (abs / 1000).toFixed(1) })
          : abs < 3600000
            ? t('timestamp.signedMinutes', { value: (abs / 60000).toFixed(1) })
            : abs < 86400000
              ? t('timestamp.signedHours', { value: (abs / 3600000).toFixed(1) })
              : t('timestamp.signedDays', { value: (abs / 86400000).toFixed(1) })
      return t(diff >= 0 ? 'timestamp.after' : 'timestamp.before', { value: unit })
    })()
  }
})

function useNow(): void {
  tsInput.value = nowMs.value.toString()
}

function syncNow(): void {
  nowMs.value = Date.now()
  setCalendar(nowMs.value)
  useNow()
}

function useNowSec(): void {
  tsInput.value = Math.floor(nowMs.value / 1000).toString()
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success(t('extraCommon.copied'))
}

function fromDate(): void {
  if (reverseTime.value === null) {
    ElMessage.warning(t('timestamp.selectValid'))
    return
  }
  tsInput.value = new Date(reverseTime.value).toISOString()
}

function setMidnight(): void {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  tsInput.value = date.getTime().toString()
}

function shiftTimestamp(delta: number): void {
  const adjusted = new Date((parsed.value ?? nowMs.value) + delta)
  if (Number.isFinite(adjusted.getTime())) tsInput.value = adjusted.toISOString()
}

const shiftOptions = computed(() => [
  [t('timestamp.minusDay'), -86400000], [t('timestamp.minusHour'), -3600000],
  [t('timestamp.plusHour'), 3600000], [t('timestamp.plusDay'), 86400000]
] as const)

const resultFields = computed(() => result.value ? [
  [t('timestamp.localTime'), result.value.local], ['UTC', result.value.utc], ['ISO 8601', result.value.iso],
  [t('timestamp.relativeNow'), result.value.rel], [t('timestamp.unixSeconds'), result.value.sec],
  [t('timestamp.unixMilliseconds'), result.value.msStr], [t('timestamp.hexSeconds'), result.value.hexSec],
  [t('timestamp.hexMilliseconds'), result.value.hexMs]
] as const : [])
</script>

<template>
  <div class="panel ts-panel converter-page">
    <header class="converter-head">
      <div>
        <h1>{{ t('timestamp.title') }}</h1>
        <p>{{ t('timestamp.subtitle') }}</p>
      </div>
      <el-button size="small" type="primary" plain @click="syncNow">{{ t('timestamp.syncNow') }}</el-button>
    </header>
    <section class="clock-strip" :aria-label="t('timestamp.liveClock')">
      <strong class="clock-state">{{ t(clockPaused ? 'timestamp.paused' : 'timestamp.live') }}</strong>
      <el-button size="small" @click="copy(Math.floor(nowMs / 1000).toString())">{{ t('timestamp.seconds') }} (s) <code>{{ Math.floor(nowMs / 1000) }}</code></el-button>
      <el-button size="small" @click="copy(nowMs.toString())">{{ t('timestamp.milliseconds') }} (ms) <code>{{ nowMs }}</code></el-button>
      <span class="clock-local">{{ t('timestamp.local') }} <code>{{ fmtLocal(nowMs) }}</code></span>
      <div class="clock-actions">
        <el-button size="small" @click="useNow">{{ t('timestamp.fillParser') }}</el-button>
        <el-button size="small" text :aria-pressed="clockPaused" @click="clockPaused = !clockPaused">{{ t(clockPaused ? 'timestamp.resume' : 'timestamp.pause') }}</el-button>
      </div>
    </section>
    <div class="converter-split">
      <section class="panel-section">
        <h3>{{ t('timestamp.toDate') }}</h3>
        <el-input v-model="tsInput" size="small" class="mono" :aria-label="t('timestamp.inputAria')" :placeholder="t('timestamp.inputPlaceholder')" clearable />
        <div class="converter-row">
          <el-button size="small" @click="useNowSec">{{ t('timestamp.currentSeconds') }}</el-button>
          <el-button size="small" @click="useNow">{{ t('timestamp.currentMilliseconds') }}</el-button>
          <el-button size="small" @click="tsInput = '0x68037880'">{{ t('timestamp.hexExample') }}</el-button>
          <el-button size="small" @click="setMidnight">{{ t('timestamp.midnight') }}</el-button>
          <el-button v-for="[label, delta] in shiftOptions"
            :key="label" size="small" @click="shiftTimestamp(delta)">{{ label }}</el-button>
        </div>
        <div v-if="result" class="result-grid">
          <button
            v-for="[label, value] in resultFields"
            :key="label" type="button" class="result-item" @click="copy(String(value))"
          >
            <span>{{ label }}</span><code>{{ value }}</code><el-icon><CopyDocument /></el-icon>
          </button>
        </div>
        <el-alert v-else-if="tsInput.trim()" type="error" :closable="false" :title="t('timestamp.invalidTimestamp')" />
      </section>
      <section class="panel-section">
        <h3>{{ t('timestamp.toTimestamp') }}</h3>
        <el-radio-group v-model="dateZone" size="small" :aria-label="t('timestamp.timezoneAria')">
          <el-radio-button value="local">{{ t('timestamp.localZone') }}</el-radio-button>
          <el-radio-button value="utc">UTC</el-radio-button>
        </el-radio-group>
        <div class="calendar-fields">
          <label>{{ t('timestamp.dateLabel') }}<input v-model="dateInput" type="datetime-local" step="1" /></label>
          <label>{{ t('timestamp.millisLabel') }}<input v-model.number="dateMillis" type="number" min="0" max="999" step="1" /></label>
        </div>
        <p v-if="dateInput && reverseTime === null" role="alert" class="calendar-error">{{ t('timestamp.invalidDate') }}</p>
        <div class="converter-row">
          <el-button size="small" @click="setCalendar(Date.now())">{{ t('timestamp.currentTime') }}</el-button>
          <el-button size="small" :disabled="!dateInput" @click="dateInput = dateInput.slice(0, 16); dateMillis = 0">{{ t('timestamp.zeroMinute') }}</el-button>
          <el-button size="small" type="primary" :disabled="reverseTime === null" @click="fromDate">{{ t('timestamp.fillLeft') }}</el-button>
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
.calendar-fields { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.calendar-fields label { display:grid; gap:4px; font-size:12px; color:var(--el-text-color-secondary); }
.calendar-fields input { height:28px; color:var(--el-text-color-primary); background:var(--el-fill-color-blank); border:1px solid var(--el-border-color); border-radius:6px; font:inherit; padding:4px 8px; }
.calendar-fields input[type="number"] { width:84px; }
.calendar-error { color:var(--el-color-danger); font-size:12px; }
.clock-strip { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:10px 12px; background:var(--el-bg-color-overlay); border:1px solid var(--el-border-color-lighter); border-radius:8px; font-size:12px; }
.clock-strip .el-button { margin:0; }
.clock-state { color:var(--el-color-success); }
.clock-actions { display:flex; gap:8px; margin-inline-start:auto; }
.clock-local { color:var(--el-text-color-secondary); }
.result-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(168px, 1fr)); gap:8px; margin-top:12px; }
.result-item { display:grid; align-items:center; gap:4px 8px; grid-template-columns:minmax(0,1fr) auto; padding:8px 10px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-bg-color-page); color:inherit; text-align:start; cursor:pointer; }
.result-item:hover { border-color:var(--el-color-primary); }
.result-item span { grid-column:1/-1; color:var(--el-text-color-secondary); font-size:12px; }
.result-item code { overflow-wrap:anywhere; }
</style>
