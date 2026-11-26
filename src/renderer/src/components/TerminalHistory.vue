<script setup lang="ts">
import { onUnmounted, ref, shallowRef } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import type { HistoryPage } from '../../../shared/terminal-stream'
import type { IpcResultCode } from '../../../shared/ipc-result'
import { useI18n } from 'vue-i18n'

const ElMessage = usePanelMessage()
const { t } = useI18n()

const props = defineProps<{ tool: string; panelId: string }>()
const visible = ref(false)
const busy = ref(false)
const query = ref('')
const selected = ref(false)
const page = shallowRef<HistoryPage>({ path: '', rows: [], size: 0, nextOffset: 0, eof: true })
const offsets = ref<number[]>([0])
let requestId = 0
const call = (action: string, payload?: unknown) => window.api.invoke(props.tool, action, props.panelId, payload)

async function load(offset = 0, reset = false): Promise<void> {
  const id = ++requestId
  busy.value = true
  if (reset) offsets.value = [0]
  try {
    const result = await call('history:query', { offset, query: query.value, selected: selected.value }) as HistoryPage
    if (id === requestId) page.value = result
  } catch (error) { if (id === requestId) ElMessage.error(String(error)) }
  finally { if (id === requestId) busy.value = false }
}
function open(): void { visible.value = true; void load(0, true) }
function next(): void { offsets.value.push(page.value.nextOffset); void load(page.value.nextOffset) }
function previous(): void { offsets.value.pop(); void load(offsets.value[offsets.value.length - 1]) }
async function pick(): Promise<void> {
  if ((await call('history:pick') as { ok: boolean }).ok) { selected.value = true; await load(0, true) }
}
function current(): void { selected.value = false; void load(0, true) }
async function save(): Promise<void> {
  try {
    const result = await call('history:save') as { ok: boolean; code?: IpcResultCode; error?: string }
    if (result.ok) ElMessage.success(t('history.exported'))
    else if (result.code !== 'CANCELLED') ElMessage.error(result.error || t('history.exportFailed'))
  } catch (error) { ElMessage.error(String(error)) }
}
onUnmounted(() => { requestId++ })
</script>

<template>
  <el-button size="small" text @click="open">{{ t('history.button') }}</el-button>
  <el-dialog v-model="visible" :title="t('history.title')" width="85%" append-to-body @closed="requestId++; busy = false">
    <div class="history-toolbar">
      <el-input v-model="query" :placeholder="t('history.queryPlaceholder')" clearable @keyup.enter="load(0, true)" />
      <el-button :disabled="busy" @click="load(0, true)">{{ t('history.query') }}</el-button>
      <el-button :disabled="busy" @click="current">{{ t('history.current') }}</el-button>
      <el-button :disabled="busy" @click="pick">{{ t('history.openFile') }}</el-button>
      <el-button :disabled="busy" @click="save">{{ t('history.export') }}</el-button>
    </div>
    <p class="history-path">{{ page.path || t('history.noPath') }}</p>
    <div v-loading="busy" class="history-content">
      <div v-for="row in page.rows" :key="row.offset" class="history-row"><span class="offset">{{ row.offset }}</span><span>{{ row.text }}</span></div>
      <p v-if="!page.rows.length && !busy">{{ t(page.eof ? 'history.noMatches' : 'history.noMatchesPage') }}</p>
    </div>
    <template #footer>
      <span class="history-hint">{{ t('history.scanHint', { offset: page.nextOffset.toLocaleString(), size: page.size.toLocaleString() }) }}</span>
      <el-button :disabled="busy || offsets.length < 2" @click="previous">{{ t('history.previous') }}</el-button>
      <el-button :disabled="busy || page.eof" @click="next">{{ t('history.next') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.history-toolbar { display: flex; gap: 8px; }
.history-path, .history-hint { color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.history-hint { margin-right: 12px; }
.history-content { height: 50vh; overflow: auto; background: var(--el-bg-color); font: 12px/1.6 Consolas, monospace; }
.history-row { display: flex; gap: 12px; padding: 2px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.offset { color: var(--el-text-color-placeholder); flex: 0 0 80px; user-select: none; }
</style>
