<script setup lang="ts">
/**
 * Disk-backed history browsed inside the terminal viewport. It is deliberately
 * independent of xterm's live output; rendering older pages cannot stall serial
 * capture or force the live cursor to jump.
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { HistoryTailPage } from '../../../shared/terminal-stream'

const props = defineProps<{ panelId: string; font: string; fontSize: number; foreground: string; background: string }>()
const emit = defineEmits<{ (event: 'live'): void }>()
const viewport = ref<HTMLElement | null>(null)
const rows = ref<HistoryTailPage['rows']>([])
const busy = ref(false)
const hasMore = ref(false)
const errorText = ref('')
let before: number | undefined
let alive = true

async function loadOlder(initial = false): Promise<void> {
  if (busy.value || (!initial && !hasMore.value)) return
  const el = viewport.value
  const height = el?.scrollHeight ?? 0
  const top = el?.scrollTop ?? 0
  busy.value = true
  try {
    const page = await window.api.invoke('serial', 'history:tail', props.panelId, {
      before: initial ? undefined : before,
      lines: 160
    }) as HistoryTailPage
    if (!alive) return
    before = page.before
    hasMore.value = page.hasMore
    rows.value = [...page.rows, ...rows.value]
    await nextTick()
    if (el) {
      // Keep the same text under the mouse after a page is inserted above it.
      el.scrollTop = initial
        ? Math.max(0, el.scrollHeight - el.clientHeight - 96)
        : top + el.scrollHeight - height
    }
  } catch (error) {
    if (alive) errorText.value = String(error)
  } finally {
    if (alive) busy.value = false
  }
}

function onScroll(): void {
  if (viewport.value && viewport.value.scrollTop <= 80) void loadOlder()
}
function onWheel(event: WheelEvent): void {
  const el = viewport.value
  if (!el) return
  // Going forward past the latest historical row returns to the live terminal.
  if (event.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
    event.preventDefault()
    emit('live')
  }
}
onMounted(() => { void loadOlder(true) })
onUnmounted(() => { alive = false })
</script>

<template>
  <div
    ref="viewport"
    class="disk-history"
    :style="{ fontFamily: font, fontSize: fontSize + 'px', color: foreground, background }"
    tabindex="0"
    @scroll.passive="onScroll"
    @wheel="onWheel"
    @keydown.esc="emit('live')"
    @keydown.end="emit('live')"
  >
    <div v-if="busy" class="history-status">正在读取更早的日志…</div>
    <div v-if="errorText" class="history-status">{{ errorText }}</div>
    <div v-for="row in rows" :key="row.offset" class="history-line">{{ row.text }}</div>
    <div v-if="!rows.length && !busy" class="history-status">当前没有可浏览的历史日志</div>
    <div class="history-live-tip">向下滚动至最新记录，继续查看实时串口打印</div>
  </div>
</template>

<style scoped>
.disk-history {
  position: absolute;
  inset: 0;
  z-index: 3;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 8px;
  font-family: Consolas, "Microsoft YaHei", monospace;
  line-height: 1.35;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  scrollbar-gutter: stable;
}
.history-line { min-height: 1.35em; }
.history-status, .history-live-tip { font-size: 11px; opacity: .65; padding: 4px 0; }
.history-live-tip { text-align: center; }
</style>
