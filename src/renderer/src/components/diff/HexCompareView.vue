<script setup lang="ts">
/**
 * 十六进制对比：读两侧文件 → diff:hex → 16 字节对齐表。
 * 逐字节着色：同/异/仅左/仅右（缺侧 '--'）。偏移锚点可点击定位。
 * 大文件（行数过多）只渲染差异行。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened } from '@element-plus/icons-vue'
import type { DiffEncoding, HexDiffRes, HexRow } from '../../../../shared/diff'
import { ENCODINGS, useDiff } from '../../composables/useDiff'
import { useDropSides } from '../../composables/useDiffDrop'

const props = defineProps<{
  /** 父层（文件夹视图"对比文件"）传入的待比较文件；seq 递增防同路径不触发 */
  pending?: { left: string; right: string; hex: boolean; seq: number } | null
}>()

const { pickFile, readFile, diffHex } = useDiff()

const enc = ref<DiffEncoding>('auto')
const leftPath = ref('')
const rightPath = ref('')
const leftBinary = ref(false)
const rightBinary = ref(false)
const result = ref<HexDiffRes | null>(null)
const busy = ref(false)

/** pending 消费（文件夹视图跳转进来）：载路径并自动对比 */
let lastSeq = -1
function consumePending(): void {
  const p = props.pending
  if (!p || p.seq === lastSeq || !p.hex) return
  lastSeq = p.seq
  leftPath.value = p.left
  rightPath.value = p.right
  leftBinary.value = false
  rightBinary.value = false
  void run()
}
watch(
  () => props.pending,
  () => consumePending()
)
onMounted(() => consumePending())

async function open(side: 'left' | 'right'): Promise<void> {
  const picked = await pickFile(side === 'left' ? '选择左侧二进制/文件' : '选择右侧二进制/文件')
  if (!picked.ok) return
  const ok = await openFromPath(side, picked.path!)
  if (ok) result.value = null
}

/** 按路径载入（浏览或手输共用） */
async function openFromPath(side: 'left' | 'right', p: string): Promise<boolean> {
  const res = await readFile({ path: p, encoding: enc.value })
  if (!res.ok) {
    ElMessage.warning(`读取失败：${res.error}`)
    return false
  }
  if (side === 'left') {
    leftPath.value = p
    leftBinary.value = res.kind === 'binary'
  } else {
    rightPath.value = p
    rightBinary.value = res.kind === 'binary'
  }
  return true
}

/** 路径输入框回车/失焦：按输入路径载入 */
async function onPathInput(side: 'left' | 'right'): Promise<void> {
  const p = side === 'left' ? leftPath.value.trim() : rightPath.value.trim()
  if (!p) return
  const ok = await openFromPath(side, p)
  if (ok) result.value = null
}

// ---------- 拖放文件（拖 1 个 → 落点侧；拖 2 个 → 首给落点侧、次给对侧） ----------
const { overLeft, overRight, onDragOver: onDropOver, onDragLeave, onDrop: onDropFiles } = useDropSides(
  async (side, paths) => {
    const ok1 = await openFromPath(side, paths[0])
    let ok2 = true
    if (paths.length > 1) ok2 = await openFromPath(side === 'left' ? 'right' : 'left', paths[1])
    if (ok1 && ok2) void run()
  }
)

async function run(): Promise<void> {
  if (busy.value || !leftPath.value || !rightPath.value) {
    if (!leftPath.value || !rightPath.value) ElMessage.info('请先打开左右两侧文件')
    return
  }
  busy.value = true
  try {
    const [l, r] = await Promise.all([
      readFile({ path: leftPath.value, encoding: enc.value }),
      readFile({ path: rightPath.value, encoding: enc.value })
    ])
    if (!l.ok || !r.ok) {
      ElMessage.warning(`读取失败：${!l.ok ? l.error : r.error}`)
      return
    }
    result.value = await diffHex({ leftHex: l.hex ?? '', rightHex: r.hex ?? '' })
  } catch (err) {
    ElMessage.warning(`对比失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

/** 字节级 class：给定左右两列表，判断某位未配对 byte 的状态 */
function byteClass(lb: number, rb: number): string {
  if (lb < 0) return 'no-left'
  if (rb < 0) return 'no-right'
  return lb === rb ? 'same' : 'diff'
}

/** ASCII 表示：可打印字符原样，否则 '·' */
function asc(b: number): string {
  if (b < 0 || b < 32 || b > 126) return '·'
  return String.fromCharCode(b)
}

const rowCount = computed(() => (result.value ? result.value.rows.length : 0))

/** 大体积保护：行太多时只显示有差异的行 */
const shownRows = computed<HexRow[]>(() => {
  if (!result.value) return []
  if (result.value.identical) return result.value.rows
  return result.value.rows.filter((r) => r.type !== 'same')
})
</script>

<template>
  <div>
    <div class="opts-row">
      <el-select v-model="enc" size="small" style="width: 190px">
        <el-option v-for="e in ENCODINGS" :key="e.value" :value="e.value" :label="e.label" />
      </el-select>
      <el-button type="primary" size="small" :loading="busy" @click="run">对比</el-button>
    </div>

    <div class="path-row mono">
      <el-input
        v-model="leftPath"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overLeft }"
        placeholder="左侧文件路径（可输入、浏览或拖入文件）"
        clearable
        @change="onPathInput('left')"
        @dragover="onDropOver('left', $event)"
        @dragleave="onDragLeave('left')"
        @drop="onDropFiles('left', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="open('left')" />
        </template>
      </el-input>
      <span class="vs">⇄</span>
      <el-input
        v-model="rightPath"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overRight }"
        placeholder="右侧文件路径（可输入、浏览或拖入文件）"
        clearable
        @change="onPathInput('right')"
        @dragover="onDropOver('right', $event)"
        @dragleave="onDragLeave('right')"
        @drop="onDropFiles('right', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="open('right')" />
        </template>
      </el-input>
    </div>
    <div v-if="leftBinary || rightBinary" class="hint warn">文件为二进制（十六进制对比正常）</div>

    <div v-if="result" class="stats-row">
      <span class="hint">左 {{ result.leftSize }} B / 右 {{ result.rightSize }} B</span>
      <el-tag v-if="result.identical" type="success" size="small">完全相同</el-tag>
      <template v-else>
        <el-tag type="danger" size="small">差异字节 {{ result.diffCount }}</el-tag>
      </template>
      <span v-if="rowCount > 100" class="hint">只显示差异行（{{ shownRows.length }} / {{ rowCount }}）</span>
    </div>

    <div v-if="result" class="hex-box mono">
      <div class="hex-head">
        <span class="h-off">偏移</span>
        <span class="h-side">左侧</span>
        <span class="h-asc">ASCII</span>
        <span class="h-side">右侧</span>
        <span class="h-asc">ASCII</span>
      </div>
      <div v-for="(r, i) in shownRows" :key="i" class="hex-row">
        <span class="h-off">{{ r.offset.toString(16).padStart(8, '0') }}</span>
        <span class="h-bytes">
          <template v-for="(b, j) in r.leftBytes" :key="'l' + j">
            <span
              :class="['byte', byteClass(b, r.rightBytes[j] ?? -1), b < 0 ? 'dash' : '']"
              :title="b < 0 ? '缺失' : `0x${b.toString(16).toUpperCase()}`"
              >{{ b < 0 ? '--' : b.toString(16).padStart(2, '0').toUpperCase() }}</span
            >
          </template>
        </span>
        <span class="h-asc">{{ r.leftBytes.map(asc).join('') }}</span>
        <span class="h-bytes">
          <template v-for="(b, j) in r.rightBytes" :key="'r' + j">
            <span
              :class="['byte', byteClass(r.leftBytes[j] ?? -1, b), b < 0 ? 'dash' : '']"
              :title="b < 0 ? '缺失' : `0x${b.toString(16).toUpperCase()}`"
              >{{ b < 0 ? '--' : b.toString(16).padStart(2, '0').toUpperCase() }}</span
            >
          </template>
        </span>
        <span class="h-asc">{{ r.rightBytes.map(asc).join('') }}</span>
      </div>
      <div v-if="shownRows.length === 0" class="hint" style="padding: 8px">（空）</div>
    </div>
  </div>
</template>

<style scoped>
.opts-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 8px;
}
.path-input {
  flex: 1;
  min-width: 120px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.vs {
  color: var(--el-text-color-secondary);
}
.mono {
  font-family: var(--font-mono);
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.warn {
  color: var(--el-color-warning);
}
.stats-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
}

.hex-box {
  background: #101418;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
  max-height: 480px;
  overflow: auto;
  color: #cfd8dc;
  padding: 4px 6px;
}
.hex-head,
.hex-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.h-off {
  flex: 0 0 70px;
  color: #78909c;
}
.h-side {
  flex: 0 0 246px;
  color: #546e7a;
  text-align: center;
}
.h-asc {
  flex: 0 0 120px;
  color: #90a4ae;
  letter-spacing: 2px;
}
.h-bytes {
  flex: 0 0 246px;
}
.byte {
  display: inline-block;
  width: 17px;
  text-align: center;
}
.byte.same {
  color: #a5d6a7;
}
.byte.diff {
  color: var(--dk-st-differ);
  background: var(--dk-del-seg);
  border-radius: 2px;
}
.byte.no-left {
  color: var(--dk-st-only-left);
  background: rgba(123, 163, 204, 0.16);
  border-radius: 2px;
}
.byte.no-right {
  color: var(--dk-st-only-right);
  background: rgba(223, 173, 114, 0.16);
  border-radius: 2px;
}
.byte.dash {
  color: #37474f;
  background: transparent;
}
.hex-row:hover {
  background: rgba(255, 255, 255, 0.02);
}
</style>