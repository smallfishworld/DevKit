<script setup lang="ts">
/**
 * 文本/文件夹/十六进制对比：顶层模式切换壳。
 * 文件夹视图"对比文件"时切到对应视图并传递路径（seq 递增防同路径不触发），
 * 目标视图载入双文件并自动对比。
 */
import { computed, ref, shallowRef } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import TextCompareView from '../components/diff/TextCompareView.vue'
import HexCompareView from '../components/diff/HexCompareView.vue'
import FolderCompareView from '../components/diff/FolderCompareView.vue'
import { useDiff } from '../composables/useDiff'
import { useI18n } from 'vue-i18n'

const ElMessage = usePanelMessage()
const { t } = useI18n()

type Mode = 'text' | 'hex' | 'folder'
const mode = ref<Mode>('text')

const modes = computed<{ value: Mode; label: string }[]>(() => [
  { value: 'text', label: t('diffShell.text') },
  { value: 'hex', label: t('diffShell.hex') },
  { value: 'folder', label: t('diffShell.folder') }
])

/** 文件夹视图 → 文本/十六进制视图的待处理跳转 */
const pending = shallowRef<{ left: string; right: string; hex: boolean; seq: number } | null>(null)
let seq = 0

function onCompareFile(left: string, right: string, hex: boolean): void {
  mode.value = hex ? 'hex' : 'text'
  pending.value = { left, right, hex, seq: ++seq }
}

// ---------- 拖放：拖文件/目录到面板任意位置 → 自动切模式并传路径给目标视图 ----------
const { statPath } = useDiff()
const dropOver = ref(false)

async function onPanelDrop(e: DragEvent): Promise<void> {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
  e.preventDefault()
  dropOver.value = false
  const files = Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file')
  const paths: string[] = []
  for (const it of files.slice(0, 2)) {
    const f = it.getAsFile()
    if (!f) continue
    try {
      const p = window.api.dragPath(f)
      if (p) paths.push(p)
    } catch {
      /* 已失效跳过 */
    }
  }
  if (paths.length === 0) return
  const st = await statPath(paths[0])
  if (!st.ok) {
    ElMessage.warning(t('diffShell.inaccessible'))
    return
  }
  // 目录 → 文件夹模式；文件 → 文本模式（路径经 pending 传给目标视图自动载入对比）
  mode.value = st.isDir ? 'folder' : 'text'
  if (st.isDir) {
    // 文件夹模式：路径直接经 props 传给视图（left/right 同型,空 = 未填）
    dirPending.value = { left: paths[0], right: paths.length > 1 ? paths[1] : '', seq: ++dropSeq }
  } else {
    // 文本/十六进制模式：仅当拖入 2 个文件时经 pending 传双路径；单文件留在落区处理
    if (paths.length > 1) {
      pending.value = { left: paths[0], right: paths[1], hex: false, seq: ++seq }
    }
    // 单文件面板级拖放无明确左右意图，不处理；用户可拖到具体输入框
  }
}

/** 文件夹模式的拖入路径传递 */
const dirPending = shallowRef<{ left: string; right: string; seq: number } | null>(null)
let dropSeq = 0

function onPanelDragOver(e: DragEvent): void {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dropOver.value = true
}
</script>

<template>
  <div
    class="panel diff-panel"
    :class="{ 'drop-over': dropOver }"
    @dragover="onPanelDragOver"
    @dragleave="dropOver = false"
    @drop="onPanelDrop"
  >
    <el-radio-group v-model="mode" size="small" class="mode-switch">
      <el-radio-button v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
    </el-radio-group>
    <div class="view-host">
      <TextCompareView v-if="mode === 'text'" :pending="pending" />
      <HexCompareView v-else-if="mode === 'hex'" :pending="pending" />
      <FolderCompareView v-else :pending="dirPending" @compare-file="onCompareFile" />
    </div>
  </div>
</template>

<style scoped>
.diff-panel {
  overflow: auto;
  padding: 4px;
}
.mode-switch {
  margin-bottom: 10px;
}
.view-host {
  min-height: 200px;
}
</style>
