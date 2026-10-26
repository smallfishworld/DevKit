<script setup lang="ts">
import { onUnmounted, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import type { HistoryPage } from '../../../shared/terminal-stream'

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
    const result = await call('history:save') as { ok: boolean; error?: string }
    if (result.ok) ElMessage.success('日志已导出')
    else if (result.error !== '已取消') ElMessage.error(result.error || '导出失败')
  } catch (error) { ElMessage.error(String(error)) }
}
onUnmounted(() => { requestId++ })
</script>

<template>
  <el-button size="small" text @click="open">历史日志</el-button>
  <el-dialog v-model="visible" title="磁盘历史日志" width="85%" append-to-body @closed="requestId++; busy = false">
    <div class="history-toolbar">
      <el-input v-model="query" placeholder="关键词（不区分大小写）" clearable @keyup.enter="load(0, true)" />
      <el-button :disabled="busy" @click="load(0, true)">查询</el-button>
      <el-button :disabled="busy" @click="current">当前会话</el-button>
      <el-button :disabled="busy" @click="pick">打开日志文件</el-button>
      <el-button :disabled="busy" @click="save">导出当前会话</el-button>
    </div>
    <p class="history-path">{{ page.path || '当前会话暂无日志，可打开已有日志文件。' }}</p>
    <div v-loading="busy" class="history-content">
      <div v-for="row in page.rows" :key="row.offset" class="history-row"><span class="offset">{{ row.offset }}</span><span>{{ row.text }}</span></div>
      <p v-if="!page.rows.length && !busy">{{ page.eof ? '没有匹配记录。' : '本段没有匹配记录，点击下一段继续查找。' }}</p>
    </div>
    <template #footer>
      <span class="history-hint">每段最多扫描 1 MiB，显示 200 条；超长行按片段显示。已扫描至 {{ page.nextOffset.toLocaleString() }} / {{ page.size.toLocaleString() }} 字节</span>
      <el-button :disabled="busy || offsets.length < 2" @click="previous">上一段</el-button>
      <el-button :disabled="busy || page.eof" @click="next">下一段</el-button>
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
