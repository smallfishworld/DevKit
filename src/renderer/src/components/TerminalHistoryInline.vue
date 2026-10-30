<script setup lang="ts">
/**
 * Bounded, two-way disk-backed history. xterm stays live behind this overlay.
 * Only a small window of pages is materialized as DOM; evicted pages are
 * reloaded from disk on reverse scrolling, never appended without a limit.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { HistoryTailPage } from '../../../shared/terminal-stream'

const props = defineProps<{ panelId: string; font: string; fontSize: number; foreground: string; background: string }>()
const emit = defineEmits<{ (event: 'live'): void }>()
const PAGE_LINES = 160
const MAX_PAGES = 8
type Page = { end: number; data: HistoryTailPage }
const viewport = ref<HTMLElement | null>(null)
const pages = shallowRef<Page[]>([])
const newerEnds: number[] = []
const rows = computed(() => pages.value.flatMap(p => p.data.rows))
const busy = ref(false)
const errorText = ref('')
let alive = true

function captureAnchor(): { offset: number; top: number } | null {
  const el = viewport.value
  if (!el) return null
  const top = el.getBoundingClientRect().top
  for (const node of el.querySelectorAll<HTMLElement>('[data-history-offset]')) {
    const r = node.getBoundingClientRect()
    if (r.bottom >= top) return { offset: Number(node.dataset.historyOffset), top: r.top }
  }
  return null
}

async function keepPosition(anchor: { offset: number; top: number } | null, initial: boolean): Promise<void> {
  await nextTick()
  const el = viewport.value
  if (!alive || !el) return
  if (initial) { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 96); return }
  if (anchor) {
    const node = el.querySelector<HTMLElement>(`[data-history-offset="${anchor.offset}"]`)
    if (node) el.scrollTop += node.getBoundingClientRect().top - anchor.top
  }
}

async function loadOlder(initial = false): Promise<void> {
  if (busy.value || (!initial && !pages.value[0]?.data.hasMore)) return
  const end = initial ? undefined : pages.value[0].data.before
  const anchor = captureAnchor()
  busy.value = true
  errorText.value = ''
  try {
    const data = await window.api.invoke('serial', 'history:tail', props.panelId, {
      before: end, lines: PAGE_LINES
    }) as HistoryTailPage
    if (!alive) return
    if (!initial && (!data.rows.length || data.before >= end!)) {
      errorText.value = '日志历史游标没有继续前进，请检查文件是否发生变化'
      return
    }
    const windowPages = [{ end: end ?? data.size, data }, ...pages.value]
    if (windowPages.length > MAX_PAGES) {
      const evicted = windowPages.pop()!
      newerEnds.push(evicted.end)
    }
    pages.value = windowPages
    await keepPosition(anchor, initial)
  } catch (error) {
    if (alive) errorText.value = String(error)
  } finally {
    if (alive) busy.value = false
  }
}

async function loadNewer(): Promise<void> {
  if (busy.value || !newerEnds.length) return
  const end = newerEnds[newerEnds.length - 1]
  const anchor = captureAnchor()
  busy.value = true
  errorText.value = ''
  try {
    const data = await window.api.invoke('serial', 'history:tail', props.panelId, {
      before: end, lines: PAGE_LINES
    }) as HistoryTailPage
    if (!alive) return
    newerEnds.pop()
    const windowPages = [...pages.value, { end, data }]
    if (windowPages.length > MAX_PAGES) windowPages.shift()
    pages.value = windowPages
    await keepPosition(anchor, false)
  } catch (error) {
    if (alive) errorText.value = String(error)
  } finally {
    if (alive) busy.value = false
  }
}

function onScroll(): void {
  const el = viewport.value
  if (!el || busy.value) return
  if (el.scrollTop <= 80) void loadOlder()
  else if (newerEnds.length && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void loadNewer()
}
function onWheel(event: WheelEvent): void {
  const el = viewport.value
  if (!el || event.deltaY <= 0 || el.scrollTop + el.clientHeight < el.scrollHeight - 4) return
  event.preventDefault()
  if (newerEnds.length) void loadNewer()
  else emit('live')
}
onMounted(() => { void loadOlder(true); void nextTick(() => viewport.value?.focus({ preventScroll: true })) })
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
    <div v-if="busy" class="history-status">正在读取历史日志…</div>
    <div v-if="errorText" class="history-status">{{ errorText }}</div>
    <div v-for="row in rows" :key="row.offset" :data-history-offset="row.offset" class="history-line">{{ row.text }}</div>
    <div v-if="!rows.length && !busy" class="history-status">当前没有可浏览的历史日志</div>
    <div class="history-live-tip">往下滚动回到实时串口 · Esc / End 返回实时打印</div>
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
