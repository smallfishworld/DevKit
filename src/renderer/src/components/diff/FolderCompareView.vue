<script setup lang="ts">
/**
 * 文件夹对比（Beyond Compare 双栏树风格）：
 * - 左右双栏对齐行（勾选框 | 左名 | 右名 | 操作），目录可折叠，depth 缩进
 * - 单侧独有的行在对侧格显示 "—"
 * - 勾选多个差异文件后批量同步（一次确认 → 逐条 folder:sync → 重扫）
 * - 行内悬停单项操作保留；「对比」跳文本/十六进制视图（父层传路径）
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderOpened } from '@element-plus/icons-vue'
import type { DiffEncoding, FolderEntry, FolderScanRes, FolderSyncRes } from '../../../../shared/diff'
import { ENCODINGS, useDiff } from '../../composables/useDiff'
import { useDropSides } from '../../composables/useDiffDrop'
import { buildTree, countDescendants, flattenTree, type FolderNode } from './folderAlign'

const emit = defineEmits<{
  (e: 'compareFile', left: string, right: string, hex: boolean): void
}>()

const { pickDir, readFile, scanFolder, syncFolder, statPath } = useDiff()

const props = defineProps<{
  /** 面板级拖入的目录（seq 递增防同路径不触发） */
  pending?: { left: string; right: string; seq: number } | null
}>()

const enc = ref<DiffEncoding>('auto')
const leftDir = ref('')
const rightDir = ref('')
const extIgnore = ref('')
const ignoreCase = ref(false)
const onlyDiff = ref(false)
const res = shallowRef<FolderScanRes | null>(null)
const busy = ref(false)

// ---------- 树 ----------
const collapsed = ref(new Set<string>())
const tree = computed<FolderNode[]>(() => (res.value?.ok ? buildTree(res.value.entries) : []))
const shown = computed<FolderNode[]>(() => flattenTree(tree.value, collapsed.value, onlyDiff.value))

const statusText: Record<string, string> = {
  identical: '相同',
  'only-left': '仅左侧',
  'only-right': '仅右侧',
  differ: '不同',
  dir: '目录',
  ignored: '已忽略'
}

function toggleCollapse(node: FolderNode): void {
  const next = new Set(collapsed.value)
  if (next.has(node.key)) next.delete(node.key)
  else next.add(node.key)
  collapsed.value = next
}

// ---------- 勾选批量同步 ----------
const selected = ref(new Set<string>())
const SYNCABLE: string[] = ['differ', 'only-left', 'only-right']

function checkable(node: FolderNode): boolean {
  return !node.isDir && SYNCABLE.includes(node.status)
}

/** selected 中的 rel → 树节点（用于批量操作时判断该侧是否存在） */
const nodeByRel = computed<Map<string, FolderNode>>(() => {
  const m = new Map<string, FolderNode>()
  const walk = (list: FolderNode[]): void => {
    for (const n of list) {
      m.set(n.key, n)
      if (n.children) walk(n.children)
    }
  }
  walk(tree.value)
  return m
})

function toggleSel(node: FolderNode): void {
  const next = new Set(selected.value)
  if (next.has(node.key)) next.delete(node.key)
  else next.add(node.key)
  selected.value = next
}

function selectAllDiff(): void {
  const next = new Set<string>()
  for (const n of nodeByRel.value.values()) {
    if (checkable(n)) next.add(n.key)
  }
  selected.value = next
}
function clearSel(): void {
  selected.value = new Set()
}

/** 批量同步。dir 语义 = 被修改的一侧（copy 源为对侧；delete 删 dir 侧） */
async function batchSync(dir: 'left-to-right' | 'right-to-left', op: 'copy' | 'delete'): Promise<void> {
  const nodes = [...selected.value].map((k) => nodeByRel.value.get(k)).filter(Boolean) as FolderNode[]
  if (!nodes.length) return
  // 只保留操作有意义的行：copy 源侧存在；delete 目标侧存在
  const sourceIsLeft = dir === 'right-to-left'
  const items = nodes.filter((n) => {
    const hasLeft = n.status === 'differ' || n.status === 'only-left'
    const hasRight = n.status === 'differ' || n.status === 'only-right'
    return op === 'copy' ? (sourceIsLeft ? hasLeft : hasRight) : sourceIsLeft ? hasLeft : hasRight
  })
  if (!items.length) {
    ElMessage.info('选中项不适用该操作')
    return
  }
  const sideName = dir === 'left-to-right' ? '右侧' : '左侧'
  const verb = op === 'copy' ? `复制到${sideName}` : `删除${sideName}副本`
  let ok = false
  try {
    await ElMessageBox.confirm(`将${verb} ${items.length} 个条目？`, '批量操作', {
      type: 'warning',
      confirmButtonText: '执行'
    })
    ok = true
  } catch {
    ok = false
  }
  if (!ok) return
  busy.value = true
  const failures: { rel: string; error?: string }[] = []
  try {
    for (const n of items) {
      const ret = (await syncFolder({
        dir,
        rel: n.key,
        op,
        left: leftDir.value,
        right: rightDir.value
      })) as FolderSyncRes
      if (!ret.ok) failures.push({ rel: n.key, error: ret.error })
    }
  } finally {
    busy.value = false
  }
  if (failures.length) {
    ElMessage.warning(`${items.length - failures.length} 项成功，${failures.length} 项失败：${failures[0].rel}${failures[0].error ? `（${failures[0].error}）` : ''}${failures.length > 1 ? ' 等' : ''}`)
  } else {
    ElMessage.success(`已${verb} ${items.length} 项`)
  }
  selected.value = new Set()
  await run()
}

// ---------- 单项操作（悬停按钮） ----------
async function syncEntry(
  node: FolderNode,
  dir: 'left-to-right' | 'right-to-left',
  op: 'copy' | 'delete'
): Promise<void> {
  const sideName = dir === 'left-to-right' ? '右侧' : '左侧'
  const verb = op === 'copy' ? `复制到${sideName}` : `删除${sideName}副本`
  let ok = false
  try {
    await ElMessageBox.confirm(`确定${verb}「${node.name}」？`, '确认操作', {
      type: 'warning',
      confirmButtonText: '执行'
    })
    ok = true
  } catch {
    ok = false
  }
  if (!ok) return
  const ret = (await syncFolder({
    dir,
    rel: node.key,
    op,
    left: leftDir.value,
    right: rightDir.value
  })) as FolderSyncRes
  if (!ret.ok) {
    ElMessage.warning(`操作失败：${ret.error}`)
    return
  }
  ElMessage.success('已执行')
  await run()
}

// ---------- 对比 / 扫描 ----------
async function compareEntry(node: FolderNode): Promise<void> {
  if (!node.entry || node.status !== 'differ') return
  const leftPath = joinPath(leftDir.value, node.key)
  const rightPath = joinPath(rightDir.value, node.key)
  const [l, r] = await Promise.all([
    readFile({ path: leftPath, encoding: enc.value }),
    readFile({ path: rightPath, encoding: enc.value })
  ])
  if (!l.ok || !r.ok) {
    ElMessage.warning('读取文件失败')
    return
  }
  const hex = l.kind === 'binary' || r.kind === 'binary'
  emit('compareFile', leftPath, rightPath, hex)
}

function joinPath(root: string, rel: string): string {
  return `${root}${root.endsWith('/') || root.endsWith('\\') ? '' : '/'}${rel.replace(/\\/g, '/')}`
}

// ---------- pending 消费（面板级拖入目录） ----------
let lastSeq = -1
async function consumePending(): Promise<void> {
  const p = props.pending
  if (!p || p.seq === lastSeq) return
  lastSeq = p.seq
  if (p.left) leftDir.value = p.left
  if (p.right) rightDir.value = p.right
  if (leftDir.value && rightDir.value) await run()
  else if (leftDir.value || rightDir.value) ElMessage.info('已填入一侧目录，再拖入或选择另一侧后点「扫描」')
}
watch(
  () => props.pending,
  () => void consumePending()
)
onMounted(() => void consumePending())

async function pick(side: 'left' | 'right'): Promise<void> {
  const p = await pickDir(side === 'left' ? '选择左侧目录' : '选择右侧目录')
  if (!p.ok) return
  if (side === 'left') leftDir.value = p.path!
  else rightDir.value = p.path!
}

// ---------- 拖放目录（拖 1 个 → 落点侧；拖 2 个 → 首给落点侧、次给对侧；须为目录） ----------
const { overLeft, overRight, onDragOver: onDropOver, onDragLeave, onDrop: onDropDirs } = useDropSides(
  async (side, paths) => {
    const st = await statPath(paths[0])
    if (!st.ok || !st.isDir) {
      ElMessage.warning('文件夹对比需拖入目录（不是文件）')
      return
    }
    if (side === 'left') leftDir.value = paths[0]
    else rightDir.value = paths[0]
    if (paths.length > 1) {
      const st2 = await statPath(paths[1])
      if (st2.ok && st2.isDir) {
        if (side === 'left') rightDir.value = paths[1]
        else leftDir.value = paths[1]
      }
    }
    await run()
  }
)

async function run(): Promise<void> {
  if (busy.value) return
  if (!leftDir.value || !rightDir.value) {
    ElMessage.info('请先选择左右两侧目录')
    return
  }
  busy.value = true
  try {
    res.value = await scanFolder({
      left: leftDir.value,
      right: rightDir.value,
      filter: {
        extIgnore: extIgnore.value.split(/[,，\s]+/).filter(Boolean),
        ignoreCase: ignoreCase.value,
        ignoreWhitespace: false
      }
    })
    collapsed.value = new Set()
    selected.value = new Set()
    if (!res.value.ok && res.value.error) ElMessage.warning(res.value.error)
  } catch (err) {
    ElMessage.warning(`扫描失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="opts-row">
      <el-select v-model="enc" size="small" style="width: 170px">
        <el-option v-for="e in ENCODINGS" :key="e.value" :value="e.value" :label="e.label" />
      </el-select>
      <el-input
        v-model="extIgnore"
        size="small"
        placeholder="忽略扩展名，如 log,obj,tmp"
        style="width: 200px"
        clearable
      />
      <el-checkbox v-model="ignoreCase" size="small">忽略大小写</el-checkbox>
      <el-checkbox v-model="onlyDiff" size="small">只看差异</el-checkbox>
      <el-button type="primary" size="small" :loading="busy" @click="run">扫描</el-button>
    </div>

    <div class="path-row">
      <el-input
        v-model="leftDir"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overLeft }"
        placeholder="左侧目录路径（可输入、浏览或拖入文件夹）"
        clearable
        @dragover="onDropOver('left', $event)"
        @dragleave="onDragLeave('left')"
        @drop="onDropDirs('left', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="pick('left')" />
        </template>
      </el-input>
      <span class="vs">⇄</span>
      <el-input
        v-model="rightDir"
        size="small"
        class="path-input"
        :class="{ 'drop-over': overRight }"
        placeholder="右侧目录路径（可输入、浏览或拖入文件夹）"
        clearable
        @dragover="onDropOver('right', $event)"
        @dragleave="onDragLeave('right')"
        @drop="onDropDirs('right', $event)"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="pick('right')" />
        </template>
      </el-input>
    </div>

    <div v-if="res?.ok" class="stats-row">
      <el-tag v-if="res.counts.differ + res.counts['only-left'] + res.counts['only-right'] === 0 && res.counts.identical > 0" type="success" size="small">两目录内容相同</el-tag>
      <template v-else>
        <el-tag type="danger" size="small">不同 {{ res.counts.differ }}</el-tag>
        <el-tag size="small" style="color: var(--dk-st-only-left)">仅左 {{ res.counts['only-left'] }}</el-tag>
        <el-tag size="small" style="color: var(--dk-st-only-right)">仅右 {{ res.counts['only-right'] }}</el-tag>
        <el-tag type="success" size="small">相同 {{ res.counts.identical }}</el-tag>
        <el-tag v-if="res.counts.ignored" type="info" size="small" effect="plain">忽略 {{ res.counts.ignored }}</el-tag>
      </template>
      <span class="batch-bar">
        <el-button size="small" text @click="selectAllDiff">全选差异</el-button>
        <el-button v-if="selected.size > 0" size="small" text @click="clearSel">清空</el-button>
        <template v-if="selected.size > 0">
          <el-button size="small" type="primary" @click="batchSync('left-to-right', 'copy')">复制到右侧 ({{ selected.size }})</el-button>
          <el-button size="small" type="primary" @click="batchSync('right-to-left', 'copy')">复制到左侧 ({{ selected.size }})</el-button>
          <el-button size="small" type="danger" plain @click="batchSync('right-to-left', 'delete')">删除左侧副本 ({{ selected.size }})</el-button>
          <el-button size="small" type="danger" plain @click="batchSync('left-to-right', 'delete')">删除右侧副本 ({{ selected.size }})</el-button>
        </template>
      </span>
    </div>

    <div v-if="res?.ok" class="folder-box">
      <!-- 表头 -->
      <div class="frow fhead">
        <span class="cb-spacer" />
        <span class="f-name">{{ basename(leftDir) }}</span>
        <span class="f-name">{{ basename(rightDir) }}</span>
        <span class="f-ops" />
      </div>
      <div v-for="node in shown" :key="node.key" class="frow" :class="['st-' + node.status, node.isDir ? 'isdir' : '', selected.has(node.key) ? 'checked' : '']">
        <span class="f-cb">
          <el-checkbox
            v-if="checkable(node)"
            :model-value="selected.has(node.key)"
            @change="toggleSel(node)"
          />
          <span v-else class="cb-spacer" />
        </span>
        <span
          class="f-name f-left"
          :style="{ paddingLeft: node.depth * 16 + 'px' }"
          :class="{ 'name-click': node.isDir }"
          @click="node.isDir && toggleCollapse(node)"
        >
          <span v-if="node.isDir" class="dir-arrow">{{ collapsed.has(node.key) ? '▸' : '▾' }}</span>
          <template v-if="node.status !== 'only-right'">
            <span :class="{ 'mono-name': !node.isDir }">{{ node.name }}</span>
            <span v-if="node.isDir && collapsed.has(node.key)" class="dir-count">+{{ countDescendants(node) }}</span>
          </template>
          <span v-else class="side-absent">—</span>
        </span>
        <span class="f-name f-right">
          <span v-if="node.status !== 'only-left'" :class="{ 'mono-name': !node.isDir }">{{ node.name }}</span>
          <span v-else class="side-absent">—</span>
        </span>
        <span class="f-ops">
          <template v-if="!node.isDir && node.status !== 'ignored' && node.status !== 'identical'">
            <template v-if="node.status === 'differ' || node.status === 'only-left'">
              <el-button link size="small" @click.stop="syncEntry(node, 'left-to-right', 'copy')">→右</el-button>
            </template>
            <template v-if="node.status === 'differ' || node.status === 'only-right'">
              <el-button link size="small" @click.stop="syncEntry(node, 'right-to-left', 'copy')">→左</el-button>
            </template>
            <template v-if="node.status === 'only-left'">
              <el-button link type="danger" size="small" @click.stop="syncEntry(node, 'right-to-left', 'delete')">删左</el-button>
            </template>
            <template v-else-if="node.status === 'only-right'">
              <el-button link type="danger" size="small" @click.stop="syncEntry(node, 'left-to-right', 'delete')">删右</el-button>
            </template>
            <el-button v-if="node.status === 'differ'" link size="small" @click.stop="compareEntry(node)">对比</el-button>
          </template>
        </span>
      </div>
      <div v-if="shown.length === 0" class="hint" style="padding: 8px">
        {{ onlyDiff ? '没有任何差异' : '（空）' }}
      </div>
    </div>
  </div>
</template>

<script lang="ts">
function basename(p: string): string {
  if (!p) return '（左）'
  const t = p.replace(/[\\/]+$/, '')
  return t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1) || p
}
</script>

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
.mono-name {
  font-family: var(--font-mono);
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.stats-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  flex-wrap: wrap;
}
.batch-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.folder-box {
  background: #101418;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 12px;
  max-height: 55vh;
  overflow: auto;
  color: #cfd8dc;
}
.frow {
  display: grid;
  grid-template-columns: 26px 1fr 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
}
.frow.fhead {
  position: sticky;
  top: 0;
  background: #161b21;
  z-index: 1;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-weight: 600;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.frow:hover {
  background: rgba(255, 255, 255, 0.03);
}
.frow.checked {
  background: var(--el-color-primary-light-9);
}
.f-cb {
  flex: 0 0 26px;
  display: inline-flex;
  justify-content: center;
}
.cb-spacer {
  display: inline-block;
  width: 14px;
}
.f-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-right {
  border-left: 1px solid var(--el-border-color-lighter);
  padding-left: 8px;
}
.name-click {
  cursor: pointer;
}
.dir-arrow {
  display: inline-block;
  width: 12px;
  color: var(--el-text-color-secondary);
}
.dir-count {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-left: 6px;
}
.side-absent {
  color: #3a4650;
}
.isdir .f-name {
  font-weight: 600;
}
.f-ops {
  display: inline-flex;
  gap: 0;
  opacity: 0;
  flex: 0 0 auto;
}
.frow:hover .f-ops {
  opacity: 1;
}

.st-only-left .f-left:not(.side-absent),
.st-only-left .f-left .mono-name {
  color: var(--dk-st-only-left);
}
.st-only-right .f-right:not(.side-absent),
.st-only-right .f-right .mono-name {
  color: var(--dk-st-only-right);
}
.st-differ .f-name {
  color: var(--dk-st-differ);
}
.st-identical .f-name {
  color: var(--dk-st-identical);
}
.st-ignored .f-name {
  color: var(--dk-st-ignored);
  opacity: 0.75;
}
.st-dir .f-name {
  color: var(--dk-st-dir);
}
</style>