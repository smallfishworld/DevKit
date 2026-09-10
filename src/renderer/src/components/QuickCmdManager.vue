<script setup lang="ts">
/**
 * 终端快捷命令（宏）管理组件：串口助手 / SSH 终端共用
 * 左侧列表 + 无弹窗录制 + 多步骤编辑（命令 / 延时 / 按键）
 * 宏库与录制状态为全局共享（composables/useTermMacros）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowRight, CopyDocument, Delete, Download, EditPen, FolderAdd, Plus, Timer, Upload, VideoCamera } from '@element-plus/icons-vue'
import type { QuickCmd, QuickCmdStep } from '../../../shared/term-macro'
import { TERM_KEYS, keyName, stepPreview } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'

const props = defineProps<{
  /** 未连接时点击宏只提示不执行 */
  enabled: boolean
  /** 面板注入的步骤执行器（串口 / SSH 写法不同） */
  writer: (st: QuickCmdStep) => void
  /** 空提示文案 */
  emptyHint?: string
}>()

const {
  quickCmds,
  groups,
  recording,
  playing,
  recordedCount,
  loadOnce,
  createGroup,
  renameGroup,
  removeGroup,
  reorderGroups,
  reorderCmds,
  toggleRecord,
  recordSend,
  saveCmd,
  removeCmd,
  copyCmd,
  moveToGroup,
  playCmd,
  exportCmds,
  importCmds
} = useTermMacros()

// ---------- 编辑弹窗 ----------
const cmdDlg = ref(false)
/** 正在编辑的宏索引；-1 = 新增 */
const cmdEditIdx = ref(-1)
const cmdDraft = reactive<QuickCmd>({ name: '', group: '', steps: [] })

// ---------- 新建分组 ----------
const newGroupDlg = ref(false)
const newGroupName = ref('')

async function onNewGroup(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name) {
    ElMessage.warning('请输入分组名')
    return
  }
  const ok = await createGroup(name)
  if (!ok) {
    ElMessage.warning(`分组「${name}」已存在`)
    return
  }
  newGroupDlg.value = false
  newGroupName.value = ''
  ElMessage.success(`分组「${name}」已创建，可点组内 + 添加命令`)
}

// ---------- 重命名分组 ----------
const renameDlg = ref(false)
const renameTarget = ref('') // 正在重命名的旧分组名
const renameCache = ref('')

function openRenameDlg(name: string): void {
  renameTarget.value = name
  renameCache.value = name
  renameDlg.value = true
}

async function onRename(): Promise<void> {
  const ok = await renameGroup(renameTarget.value, renameCache.value)
  if (!ok) {
    ElMessage.warning('名称无效或已存在')
    return
  }
  renameDlg.value = false
  ElMessage.success('分组已重命名')
}

// ---------- 分组展示 ----------
/** 已收起的分组名集合 */
const collapsed = ref(new Set<string>())
/** 带分组的展示结构：分组按声明顺序（支持拖动排序），未分组在后；已声明的空分组也展示 */
const grouped = computed(() => {
  const grps: { name: string; items: { idx: number; cmd: QuickCmd }[]; empty: boolean }[] = []
  const ungrouped: { idx: number; cmd: QuickCmd }[] = []
  const declared = new Set(groups.value.map((g) => g.trim()).filter(Boolean))
  // 分组顺序以声明列表为准；命令上出现但未声明的组名（导入旧数据）追加在后
  const order = [...declared]
  quickCmds.value.forEach((cmd) => {
    const g = (cmd.group ?? '').trim()
    if (g && !order.includes(g)) order.push(g)
  })
  for (const name of order) {
    grps.push({ name, items: [], empty: true })
  }
  quickCmds.value.forEach((cmd, idx) => {
    const g = (cmd.group ?? '').trim()
    if (!g) {
      ungrouped.push({ idx, cmd })
      return
    }
    const grp = grps.find((x) => x.name === g)
    if (grp) {
      grp.items.push({ idx, cmd })
      grp.empty = false
    }
  })
  return { groups: grps, ungrouped }
})

/** 全部可选分组（编辑弹窗下拉）：命令上的分组 + 已声明的空分组 */
const groupNames = computed(() =>
  Array.from(
    new Set([
      ...groups.value.map((g) => g.trim()).filter(Boolean),
      ...quickCmds.value.map((c) => (c.group ?? '').trim()).filter(Boolean)
    ])
  )
)

function toggleGroup(name: string): void {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
}

onMounted(() => {
  void loadOnce()
})

function openCmdDlg(idx = -1, steps?: QuickCmdStep[], prefillGroup?: string): void {
  cmdEditIdx.value = idx
  const src = idx >= 0 ? quickCmds.value[idx] : undefined
  cmdDraft.name = src?.name ?? ''
  cmdDraft.group = src?.group ?? prefillGroup ?? ''
  cmdDraft.steps = src
    ? JSON.parse(JSON.stringify(src.steps))
    : steps
      ? JSON.parse(JSON.stringify(steps))
      : []
  cmdDlg.value = true
}

async function onSaveCmd(): Promise<void> {
  if (!cmdDraft.name.trim() || cmdDraft.steps.length === 0) {
    ElMessage.warning('名称与至少一个步骤必填')
    return
  }
  await saveCmd(
    {
      name: cmdDraft.name.trim(),
      group: cmdDraft.group?.trim() ?? '',
      steps: JSON.parse(JSON.stringify(cmdDraft.steps))
    },
    cmdEditIdx.value
  )
  cmdDlg.value = false
  ElMessage.success(cmdEditIdx.value >= 0 ? '已更新' : '已添加')
}

function addStep(type: QuickCmdStep['type']): void {
  if (type === 'cmd') cmdDraft.steps.push({ type: 'cmd', text: '', mode: 'ascii', crlf: true })
  else if (type === 'sleep') cmdDraft.steps.push({ type: 'sleep', ms: 500 })
  else cmdDraft.steps.push({ type: 'key', key: '\r' })
}

function delStep(idx: number): void {
  cmdDraft.steps.splice(idx, 1)
}

// ---------- 录制（停止后弹编辑窗整理保存） ----------
function onRecord(): void {
  const r = toggleRecord()
  if (!r.stopped) {
    ElMessage.success('录制中：直接在终端输入命令或按键；再点录制键停止并保存')
    return
  }
  if (r.steps.length === 0) {
    ElMessage.info('未录到任何内容，已取消录制')
    return
  }
  openCmdDlg(-1, r.steps)
}

// ---------- 回放 ----------
function onPlay(cmd: QuickCmd): void {
  if (!props.enabled) {
    ElMessage.warning('连接未打开')
    return
  }
  void playCmd(cmd, props.writer, () => props.enabled)
}

// ---------- 多选 / 拖拽（排序 + 分组移动） ----------
const selected = ref(new Set<string>())
const dragOver = ref('') // 悬停目标：分组名 / '__ungrouped__' / 'item:<name>'（插到该命令前）

/** 点击命令：Ctrl/Shift 多选，否则执行该命令 */
function onItemClick(name: string, e: MouseEvent): void {
  const cmd = quickCmds.value.find((c) => c.name === name)
  if (!cmd) return
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    const next = new Set(selected.value)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    selected.value = next
    return
  }
  selected.value = new Set()
  onPlay(cmd)
}

/** 开始拖动命令：把被拖项并入已选中集合，整体一起移动 */
function onDragStart(name: string, e: DragEvent): void {
  const next = new Set(selected.value)
  next.add(name)
  selected.value = next
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', [...next].join('\n'))
}

/** 拖动悬停判定：命令行自身是插入锚点（插到它前面） */
function onItemDragOver(name: string): void {
  dragOver.value = `item:${name}`
}

/** 命令行 drop：插到锚点命令之前，组别跟随锚点（锚点在组内即移入该组） */
async function onItemDrop(anchorName: string): Promise<void> {
  const names = [...selected.value]
  if (names.length === 0) return
  if (names.includes(anchorName) && names.length === 1) return
  const anchor = quickCmds.value.find((c) => c.name === anchorName)
  const group = anchor ? (anchor.group ?? '').trim() : null
  await reorderCmds(names, anchorName, group)
  selected.value = new Set()
  dragOver.value = ''
}

/** 拖到分组（整组区域）：移入该组（保留在组尾部） */
async function onDrop(group: string): Promise<void> {
  if (selected.value.size === 0) return
  const names = [...selected.value]
  await moveToGroup(names, group)
  selected.value = new Set()
  dragOver.value = ''
}

// ---------- 分组拖动排序 ----------
const dragGrp = ref('') // 正在拖动的分组名
const grpDropOver = ref('') // 分组排序悬停目标

function onGrpDragStart(name: string, e: DragEvent): void {
  dragGrp.value = name
  e.dataTransfer!.setData('text/plain', `__group__:${name}`)
  e.dataTransfer!.effectAllowed = 'move'
}

function onGrpDragEnd(): void {
  dragGrp.value = ''
  grpDropOver.value = ''
  dragOver.value = ''
}

/** 分组头 drop：拖的是组 → 插到目标组之前；拖的是命令 → 移入该组 */
async function onGrpDrop(before: string): Promise<void> {
  const dragged = dragGrp.value
  if (dragged) {
    onGrpDragEnd()
    if (dragged === before) return
    await reorderGroups(dragged, before)
    return
  }
  await onDrop(before)
}

// Esc 取消多选
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected.value.size > 0) selected.value = new Set()
})
// ---------- 导入 / 导出 ----------
async function onExport(): Promise<void> {
  const res = await exportCmds()
  if (res.ok) ElMessage.success(`已导出 ${res.count} 条快捷命令`)
  else if (res.error && res.error !== '已取消') ElMessage.warning(res.error)
}

async function onImport(): Promise<void> {
  const res = await importCmds()
  if (res.ok) {
    const srcName = res.source === 'mobaxterm' ? 'MobaXterm 宏' : 'DevKit 配置'
    ElMessage.success(`已从${srcName}导入 ${res.count} 条（同名已覆盖）`)
  } else if (res.error && res.error !== '已取消') {
    ElMessage.warning(res.error)
  }
}
</script>

<template>
  <div>
    <div class="sessions-head" style="margin-top: 10px">
      <span>快捷命令</span>
      <span>
        <el-tooltip
          :content="recording ? '停止录制并整理保存' : '录制宏：终端键入与发送都会记入（含自动延时与按键）'"
          placement="top"
        >
          <el-button size="small" text :type="recording ? 'danger' : 'default'" @click="onRecord">
            <el-icon><VideoCamera /></el-icon>
          </el-button>
        </el-tooltip>
        <el-tooltip content="新建分组：先建组，再在组内添加命令" placement="top">
          <el-button size="small" text :icon="FolderAdd" @click="newGroupDlg = true" />
        </el-tooltip>
        <el-tooltip content="新建命令（可设分组）" placement="top">
          <el-button size="small" text :icon="Plus" @click="openCmdDlg(-1)" />
        </el-tooltip>
        <el-tooltip content="导入配置：支持 DevKit JSON 与 MobaXterm 宏文件（.mxtmacros / ini）" placement="top">
          <el-button size="small" text :icon="Download" @click="onImport" />
        </el-tooltip>
        <el-tooltip content="导出配置：全部快捷命令存为 JSON" placement="top">
          <el-button size="small" text :icon="Upload" @click="onExport" />
        </el-tooltip>
      </span>
    </div>
    <div class="cmd-list">
      <!-- 分组（可展开/收起；整组作为拖放目标，命令拖到组内任意处即可移入） -->
      <div
        v-for="g in grouped.groups"
        :key="g.name"
        class="cmd-group"
        :class="{ 'drop-hover': dragOver === g.name }"
        @dragover.prevent="dragOver = g.name"
        @dragleave="dragOver === g.name ? (dragOver = '') : null"
        @drop.prevent="onDrop(g.name)"
      >
        <div
          class="cmd-group-head"
          :class="{ 'grp-drop-hover': grpDropOver === g.name }"
          draggable="true"
          title="拖动可调整分组顺序"
          @click="toggleGroup(g.name)"
          @dragstart="onGrpDragStart(g.name, $event)"
          @dragend="onGrpDragEnd"
          @dragover.prevent="grpDropOver = g.name"
          @dragleave="grpDropOver === g.name ? (grpDropOver = '') : null"
          @drop.prevent="onGrpDrop(g.name)"
        >
          <el-icon class="grp-arrow">
            <ArrowDown v-if="!collapsed.has(g.name)" />
            <ArrowRight v-else />
          </el-icon>
          <span class="grp-name">{{ g.name }}</span>
          <el-button
            class="grp-rename"
            link
            size="small"
            @click.stop="openRenameDlg(g.name)"
          >
            <el-icon><EditPen /></el-icon>
          </el-button>
          <el-button
            v-if="g.empty"
            class="grp-del"
            link
            type="danger"
            size="small"
            title="删除空分组"
            @click.stop="removeGroup(g.name)"
          >
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
        <template v-if="!collapsed.has(g.name)">
          <div
            v-for="it in g.items"
            :key="it.cmd.name"
            class="cmd-item"
            :class="[selected.has(it.cmd.name) ? 'selected' : '', dragOver === 'item:' + it.cmd.name ? 'drop-hover' : '']"
            draggable="true"
            :title="it.cmd.steps.map(stepPreview).join(' → ')"
            @click="onItemClick(it.cmd.name, $event)"
            @dragstart="onDragStart(it.cmd.name, $event)"
            @dragover.prevent="onItemDragOver(it.cmd.name)"
            @dragleave="dragOver === 'item:' + it.cmd.name ? (dragOver = '') : null"
            @drop.prevent="onItemDrop(it.cmd.name)"
          >
            <span class="cmd-name">{{ it.cmd.name }}</span>
            <span class="cmd-ops">
              <el-button link size="small" @click.stop="copyCmd(it.cmd.name)">
                <el-icon><CopyDocument /></el-icon>
              </el-button>
              <el-button link size="small" @click.stop="openCmdDlg(it.idx)">
                <el-icon><EditPen /></el-icon>
              </el-button>
              <el-button link type="danger" size="small" @click.stop="removeCmd(it.cmd.name)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </span>
          </div>
          <div v-if="g.empty" class="cmd-item empty-item" @click="openCmdDlg(-1, undefined, g.name)">
            <span class="hint">＋ 添加命令到此分组</span>
          </div>
        </template>
      </div>

      <!-- 未分组（拖放目标：把命令拖来这里移出分组） -->
      <div
        v-for="it in grouped.ungrouped"
        :key="it.cmd.name"
        class="cmd-item"
        :class="[selected.has(it.cmd.name) ? 'selected' : '', dragOver === 'item:' + it.cmd.name ? 'drop-hover' : '']"
        draggable="true"
        :title="it.cmd.steps.map(stepPreview).join(' → ')"
        @click="onItemClick(it.cmd.name, $event)"
        @dragstart="onDragStart(it.cmd.name, $event)"
        @dragover.prevent="onItemDragOver(it.cmd.name)"
        @dragleave="dragOver === 'item:' + it.cmd.name ? (dragOver = '') : null"
        @drop.prevent="onItemDrop(it.cmd.name)"
      >
        <span class="cmd-name">{{ it.cmd.name }}</span>
        <span class="cmd-ops">
          <el-button link size="small" @click.stop="copyCmd(it.cmd.name)">
            <el-icon><CopyDocument /></el-icon>
          </el-button>
          <el-button link size="small" @click.stop="openCmdDlg(it.idx)">
            <el-icon><EditPen /></el-icon>
          </el-button>
          <el-button link type="danger" size="small" @click.stop="removeCmd(it.cmd.name)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </span>
      </div>
      <div
        v-if="grouped.ungrouped.length > 0"
        class="ungrouped-drop"
        :class="{ 'drop-hover': dragOver === '__ungrouped__' }"
        @dragover.prevent="dragOver = '__ungrouped__'"
        @dragleave="dragOver === '__ungrouped__' ? (dragOver = '') : null"
        @drop.prevent="onDrop('')"
      >
        拖到此处移出分组 ▼
      </div>

      <div v-if="quickCmds.length === 0" class="hint" style="padding: 4px 8px">
        {{ emptyHint ?? '点 + 添加多步骤命令，或用录制按钮录下操作序列' }}
      </div>
      <div v-if="selected.size > 0" class="hint sel-hint">
        已选中 {{ selected.size }} 条 — 拖动到分组名下方即可移动，Esc 取消
      </div>
      <div v-if="recording" class="hint rec-hint">
        ● 录制中（{{ recordedCount }} 步）— 再点录制键停止并保存
      </div>
      <div v-if="playing" class="hint rec-hint">▶ 正在回放快捷命令…</div>
    </div>

    <!-- 新建分组 -->
    <el-dialog v-model="newGroupDlg" title="新建分组" width="320px" append-to-body>
      <el-input
        v-model="newGroupName"
        placeholder="输入分组名，如：烧录、测试、日志"
        @keydown.enter="onNewGroup"
      />
      <template #footer>
        <el-button @click="newGroupDlg = false">取消</el-button>
        <el-button type="primary" @click="onNewGroup">创建分组</el-button>
      </template>
    </el-dialog>

    <!-- 重命名分组 -->
    <el-dialog v-model="renameDlg" title="重命名分组" width="320px" append-to-body>
      <el-input
        v-model="renameCache"
        placeholder="输入新的分组名"
        @keydown.enter="onRename"
      />
      <template #footer>
        <el-button @click="renameDlg = false">取消</el-button>
        <el-button type="primary" @click="onRename">保存</el-button>
      </template>
    </el-dialog>

    <!-- 步骤编辑弹窗 -->
    <el-dialog
      v-model="cmdDlg"
      :title="cmdEditIdx >= 0 ? '编辑快捷命令' : '添加快捷命令'"
      width="560px"
      append-to-body
    >
      <el-form label-width="70px" size="small" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="cmdDraft.name" placeholder="如：上电自检流程" />
        </el-form-item>
        <el-form-item label="分组">
          <el-select
            v-model="cmdDraft.group"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="选已有分组或输入新名；留空 = 不分组"
            style="width: 100%"
          >
            <el-option v-for="g in groupNames" :key="g" :value="g" :label="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="steps-head">
        <span>步骤（按顺序执行）</span>
        <span>
          <el-button size="small" text :icon="Plus" @click="addStep('cmd')">命令</el-button>
          <el-button size="small" text :icon="Timer" @click="addStep('sleep')">延时</el-button>
          <el-button size="small" text :icon="EditPen" @click="addStep('key')">按键</el-button>
        </span>
      </div>
      <div class="steps-list">
        <div v-for="(st, i) in cmdDraft.steps" :key="i" class="step-row">
          <span class="step-idx">{{ i + 1 }}</span>
          <template v-if="st.type === 'cmd'">
            <el-select v-model="st.mode" size="small" style="width: 78px">
              <el-option value="ascii" label="ASCII" />
              <el-option value="hex" label="HEX" />
            </el-select>
            <el-input
              v-model="st.text"
              size="small"
              class="step-input"
              :placeholder="st.mode === 'hex' ? 'AA 55 01' : '命令文本'"
            />
            <el-checkbox v-model="st.crlf" size="small">换行</el-checkbox>
          </template>
          <template v-else-if="st.type === 'sleep'">
            <el-tag size="small" type="info" effect="plain">延时</el-tag>
            <el-input-number
              v-model="st.ms"
              :min="100"
              :step="100"
              size="small"
              controls-position="right"
              style="width: 110px"
            />
            <span class="hint">ms</span>
          </template>
          <template v-else>
            <el-tag size="small" type="warning" effect="plain">按键</el-tag>
            <el-select v-model="st.key" size="small" filterable class="step-input">
              <el-option v-for="k in TERM_KEYS" :key="k.name" :value="k.seq" :label="k.name" />
            </el-select>
            <span class="hint">{{ keyName(st.key ?? '') }}</span>
          </template>
          <el-button link type="danger" size="small" @click="delStep(i)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
        <div v-if="cmdDraft.steps.length === 0" class="hint" style="padding: 8px">
          尚无步骤：用上方「命令 / 延时 / 按键」按钮添加，或用录制按钮录下操作序列
        </div>
      </div>
      <template #footer>
        <el-button @click="cmdDlg = false">取消</el-button>
        <el-button type="primary" @click="onSaveCmd">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cmd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition: background 0.15s ease;
}

.cmd-item:hover {
  background: var(--el-fill-color);
}

.cmd-item.selected {
  background: var(--el-color-primary-light-9) !important;
  outline: 1px dashed var(--el-color-primary);
}

.cmd-item[data-drag] {
  opacity: 0.5;
}

.cmd-group.drop-hover,
.cmd-group.drop-hover > .cmd-group-head {
  background: var(--el-color-primary-light-9);
  outline: 1px dashed var(--el-color-primary);
  border-radius: 6px;
}

.ungrouped-drop {
  padding: 5px 9px;
  margin-top: 2px;
  border: 1px dashed var(--el-border-color);
  border-radius: 7px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
  cursor: pointer;
}

.ungrouped-drop.drop-hover {
  background: var(--el-color-primary-light-9);
  outline: 1px dashed var(--el-color-primary);
}

.empty-item {
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-style: italic;
}

.sel-hint {
  color: var(--el-color-primary);
  padding: 4px 8px;
}

.cmd-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-item.drop-hover {
  outline: 1px dashed var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.cmd-ops {
  display: none;
  flex-shrink: 0;
}

.cmd-item:hover .cmd-ops {
  display: inline-flex;
}

.rec-hint {
  color: var(--el-color-danger);
  padding: 4px 8px;
}

.cmd-group {
  margin-bottom: 2px;
}

.cmd-group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--el-color-primary, #5b8ac2);
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  user-select: none;
}

.cmd-group-head:hover {
  background: var(--el-fill-color);
}

.grp-rename {
  visibility: hidden;
  padding: 0 2px;
}

.grp-del {
  visibility: hidden;
  padding: 0 2px;
}

.cmd-group-head:hover .grp-rename,
.grp-rename:hover,
.cmd-group-head:hover .grp-del,
.grp-del:hover {
  visibility: visible;
}

.grp-drop-hover {
  outline: 1px dashed var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.grp-arrow {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.grp-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steps-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  margin: 4px 0 8px;
}

.steps-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.step-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.step-idx {
  flex: 0 0 18px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: right;
}

.step-input {
  flex: 1;
  min-width: 120px;
}
</style>
