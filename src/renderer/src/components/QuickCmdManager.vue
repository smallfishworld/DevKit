<script setup lang="ts">
/**
 * 终端快捷命令（宏）管理组件：串口助手 / SSH 终端共用
 * 左侧列表 + 无弹窗录制 + 多步骤编辑（命令 / 延时 / 按键）
 * 宏库与录制状态为全局共享（composables/useTermMacros）
 */
import { computed, onMounted, reactive, ref, watch, watchEffect } from 'vue'
import { usePanelMessage } from '@renderer/composables/panelOverlays'
import { usePanelDocument } from '@renderer/composables/usePanelWindow'
import { ArrowDown, ArrowRight, CopyDocument, Delete, EditPen, Plus, Timer, VideoCamera } from '@element-plus/icons-vue'
import type { QuickCmd, QuickCmdStep, PluginActionReference, PluginMacroAction } from '../../../shared/term-macro'
import { TERM_KEYS, keyName, stepPreview, resolveDropInsertion, validatePlayback } from '../../../shared/term-macro'
import { useTermMacros } from '../composables/useTermMacros'
import { pluginActionKey } from './plugin-config-form'
import { useI18n } from 'vue-i18n'

const ElMessage = usePanelMessage()
const { t } = useI18n()
const ownerDocument = usePanelDocument()

const props = defineProps<{
  /** 未连接时点击宏只提示不执行 */
  enabled: boolean
  /** 面板注入的步骤执行器（串口 / SSH / 本地终端写法不同） */
  writer: (st: QuickCmdStep) => Promise<void> | void
  getConnectionGeneration?: () => number
  runPluginAction?: (action: PluginActionReference) => Promise<void>
  getPluginActions?: () => Promise<{ actions: PluginMacroAction[]; error?: string }>
  pluginConfigVersion?: number
  /** 空提示文案 */
  emptyHint?: string
}>()

const emit = defineEmits<{
  (e: 'request-plugin-config'): void
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
const pluginActions = ref<PluginMacroAction[]>([])
const pluginConfigError = ref('')

async function refreshPluginActions(): Promise<void> {
  if (!props.getPluginActions) return
  try {
    const result = await props.getPluginActions()
    pluginActions.value = result.actions
    pluginConfigError.value = result.error || ''
  } catch (failure) {
    pluginActions.value = []
    pluginConfigError.value = failure instanceof Error ? failure.message : t('quickCmd.loadPluginsFailed')
  }
}
function selectedPluginAction(step: QuickCmdStep): string {
  return step.instanceId && step.actionId ? pluginActionKey(step.instanceId, step.actionId) : ''
}
function selectPluginAction(step: QuickCmdStep, key: string): void {
  const action = pluginActions.value.find(item => pluginActionKey(item.instanceId, item.actionId) === key)
  if (action) { step.instanceId = action.instanceId; step.actionId = action.actionId }
}
function pluginActionAvailable(step: QuickCmdStep): boolean {
  return pluginActions.value.some(item => item.instanceId === step.instanceId && item.actionId === step.actionId)
}
watch(() => props.pluginConfigVersion, () => { void refreshPluginActions() })

// ---------- 新建分组 ----------
const newGroupDlg = ref(false)
const newGroupName = ref('')

async function onNewGroup(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name) {
    ElMessage.warning(t('quickCmd.groupRequired'))
    return
  }
  const ok = await createGroup(name)
  if (!ok) {
    ElMessage.warning(t('quickCmd.groupExists', { name }))
    return
  }
  newGroupDlg.value = false
  newGroupName.value = ''
  ElMessage.success(t('quickCmd.groupCreated', { name }))
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
    ElMessage.warning(t('quickCmd.invalidName'))
    return
  }
  renameDlg.value = false
  ElMessage.success(t('quickCmd.renamed'))
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
  void refreshPluginActions()
}

async function onSaveCmd(): Promise<void> {
  if (!cmdDraft.name.trim() || cmdDraft.steps.length === 0) {
    ElMessage.warning(t('quickCmd.required'))
    return
  }
  if (cmdDraft.steps.some(step => step.type === 'plugin-action' && (!step.instanceId || !step.actionId))) {
    ElMessage.warning(pluginConfigError.value || t('quickCmd.choosePlugin'))
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
  ElMessage.success(t(cmdEditIdx.value >= 0 ? 'quickCmd.updated' : 'quickCmd.added'))
}

function addStep(type: QuickCmdStep['type']): void {
  if (type === 'cmd') cmdDraft.steps.push({ type: 'cmd', text: '', mode: 'ascii', crlf: true })
  else if (type === 'sleep') cmdDraft.steps.push({ type: 'sleep', ms: 500 })
  else if (type === 'plugin-action') {
    const first = pluginActions.value[0]
    cmdDraft.steps.push({ type, instanceId: first?.instanceId || '', actionId: first?.actionId || '' })
  }
  else cmdDraft.steps.push({ type: 'key', key: '\r' })
}

function delStep(idx: number): void {
  cmdDraft.steps.splice(idx, 1)
}

// ---------- 录制（停止后弹编辑窗整理保存） ----------
function onRecord(): void {
  const r = toggleRecord()
  if (!r.stopped) {
    ElMessage.success(t('quickCmd.recording'))
    return
  }
  if (r.steps.length === 0) {
    ElMessage.info(t('quickCmd.recordingEmpty'))
    return
  }
  openCmdDlg(-1, r.steps)
}

defineExpose({ finishRecording: () => { if (recording.value) onRecord() } })

// ---------- 回放 ----------
async function onPlay(cmd: QuickCmd): Promise<void> {
  if (!props.enabled) {
    ElMessage.warning(t('quickCmd.disconnected'))
    return
  }
  const usesPlugin = cmd.steps.some((step) => step?.type === 'plugin-action')
  const generation = usesPlugin ? props.getConnectionGeneration?.() : undefined
  const canContinue = (): boolean => props.enabled &&
    (generation === undefined || generation === props.getConnectionGeneration?.())
  if (usesPlugin && props.runPluginAction) await refreshPluginActions()
  const error = validatePlayback(cmd, props.runPluginAction ? pluginActions.value : undefined)
  if (error) {
    ElMessage.warning(usesPlugin && pluginConfigError.value ? pluginConfigError.value : error)
    return
  }
  if (!canContinue()) {
    ElMessage.warning(t('quickCmd.connectionChanged'))
    return
  }
  try { await playCmd(cmd, props.writer, canContinue, props.runPluginAction) } catch (failure) {
    ElMessage.warning(failure instanceof Error ? failure.message : t('quickCmd.runFailed'))
  }
}

// ---------- 多选 / 拖拽（排序 + 分组移动） ----------
const selected = ref(new Set<string>())
/** 是否有命令正在拖动：只有拖动时才显示「移出分组」落区，平时侧栏底部就是干净的留白 */
const dragging = ref(false)
const dragOver = ref('') // 悬停目标：分组名 / '__tail__' / 'item:<name>'（插到该命令前） / 'itemafter:<name>'（插到该命令后）

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
  dragging.value = true
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', [...next].join('\n'))
}

/** 拖动结束（无论落在哪里）：复位落区，避免「拖到此处」提示残留在侧栏底部 */
function onDragEnd(): void {
  dragging.value = false
  dragOver.value = ''
}

/** 拖动悬停判定：行上半部 = 插到该命令前，下半部 = 插到该命令后 */
function onItemDragOver(name: string, e: DragEvent): void {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  dragOver.value = e.clientY - rect.top < rect.height / 2 ? `item:${name}` : `itemafter:${name}`
}

function onItemDragLeave(name: string, e: DragEvent): void {
  // Chromium 指针移到行内子元素也会触发父级 dragleave，relatedTarget 仍在行内时忽略
  const el = e.currentTarget as HTMLElement
  if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
  if (dragOver.value === `item:${name}` || dragOver.value === `itemafter:${name}`) dragOver.value = ''
}

/** 命令行 drop：按悬停位置插到锚点前/后，组别跟随锚点（锚点在组内即移入该组）。
 *  行级 dragover/drop 已加 .stop：事件若冒泡到分组容器，会把 dragOver 覆盖成组名
 *  （after 判定失效退化为插前），drop 还会再触发一次 moveToGroup 移到组尾。 */
async function onItemDrop(anchorName: string): Promise<void> {
  const after = dragOver.value === `itemafter:${anchorName}`
  const names = [...selected.value]
  if (names.length === 0) {
    dragOver.value = ''
    return
  }
  if (names.includes(anchorName) && names.length === 1) {
    // 拖到自身上：无操作，但须复位选中与指示，否则残留到下次拖动
    selected.value = new Set()
    dragOver.value = ''
    return
  }
  const anchor = quickCmds.value.find((c) => c.name === anchorName)
  if (!anchor) {
    dragOver.value = ''
    return
  }
  // 插入点判定抽为纯函数 resolveDropInsertion（共享模块，可单测）；
  // beforeName 为 null 表示插到列表末尾（reorderCmds 对不存在的 beforeName 即插末尾）
  const { beforeName, group } = resolveDropInsertion(quickCmds.value, anchorName, names, after)
  await reorderCmds(names, beforeName ?? '__end__', group)
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

watchEffect((onCleanup) => {
  const owner = ownerDocument.value
  const cancelSelection = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selected.value.size > 0) selected.value = new Set()
  }
  owner.addEventListener('keydown', cancelSelection)
  onCleanup(() => owner.removeEventListener('keydown', cancelSelection))
})
// ---------- 导入 / 导出 ----------
async function onExport(): Promise<void> {
  const res = await exportCmds()
  if (res.ok) ElMessage.success(t('quickCmd.exported', { count: res.count }))
  else if (res.code !== 'CANCELLED' && res.error) ElMessage.warning(res.error)
}

async function onImport(): Promise<void> {
  const res = await importCmds()
  if (res.ok) {
    const srcName = res.source === 'mobaxterm' ? 'MobaXterm' : t('quickCmd.devkitConfig')
    ElMessage.success(t('quickCmd.imported', { source: srcName, count: res.count }))
  } else if (res.code !== 'CANCELLED' && res.error) {
    ElMessage.warning(res.error)
  }
}
</script>

<template>
  <div class="quick-cmd">
    <div class="sessions-head cmd-head">
      <span>{{ t('quickCmd.title') }}</span>
      <span class="cmd-head-actions">
        <el-tooltip
          :content="t(recording ? 'quickCmd.stopRecording' : 'quickCmd.startRecording')"
          placement="top"
        >
          <el-button size="small" text :type="recording ? 'danger' : 'default'" @click="onRecord">
            <el-icon><VideoCamera /></el-icon>
          </el-button>
        </el-tooltip>
        <el-button size="small" text :icon="Plus" :aria-label="t('quickCmd.newAria')" @click="openCmdDlg(-1)" />
        <el-dropdown trigger="click">
          <el-button size="small" text :aria-label="t('quickCmd.menuAria')">⋯</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="newGroupDlg = true">{{ t('quickCmd.newGroup') }}</el-dropdown-item>
              <el-dropdown-item @click="onImport">{{ t('quickCmd.import') }}</el-dropdown-item>
              <el-dropdown-item @click="onExport">{{ t('quickCmd.export') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
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
          :title="t('quickCmdUi.dragGroupTitle')"
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
            :title="t('quickCmdUi.deleteEmptyGroupTitle')"
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
            :class="[
              selected.has(it.cmd.name) ? 'selected' : '',
              dragOver === 'item:' + it.cmd.name ? 'drop-before' : '',
              dragOver === 'itemafter:' + it.cmd.name ? 'drop-after' : ''
            ]"
            draggable="true"
            :title="it.cmd.steps.map(stepPreview).join(' → ')"
            @click="onItemClick(it.cmd.name, $event)"
            @dragstart="onDragStart(it.cmd.name, $event)"
            @dragend="onDragEnd"
            @dragover.prevent.stop="onItemDragOver(it.cmd.name, $event)"
            @dragleave="onItemDragLeave(it.cmd.name, $event)"
            @drop.prevent.stop="onItemDrop(it.cmd.name)"
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
            <span class="hint">{{ t('quickCmdUi.addToGroup') }}</span>
          </div>
        </template>
      </div>

      <!-- 未分组（拖放目标：把命令拖来这里移出分组） -->
      <div
        v-for="it in grouped.ungrouped"
        :key="it.cmd.name"
        class="cmd-item"
        :class="[
          selected.has(it.cmd.name) ? 'selected' : '',
          dragOver === 'item:' + it.cmd.name ? 'drop-before' : '',
          dragOver === 'itemafter:' + it.cmd.name ? 'drop-after' : ''
        ]"
        draggable="true"
        :title="it.cmd.steps.map(stepPreview).join(' → ')"
        @click="onItemClick(it.cmd.name, $event)"
        @dragstart="onDragStart(it.cmd.name, $event)"
        @dragend="onDragEnd"
        @dragover.prevent.stop="onItemDragOver(it.cmd.name, $event)"
        @dragleave="onItemDragLeave(it.cmd.name, $event)"
        @drop.prevent.stop="onItemDrop(it.cmd.name)"
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
      <div v-if="quickCmds.length === 0" class="hint" style="padding: 4px 8px">
        {{ emptyHint ?? t('quickCmdUi.defaultEmptyHint') }}
      </div>
      <div v-if="selected.size > 0" class="hint sel-hint">
        {{ t('quickCmdUi.selectedHint', { count: selected.size }) }}
      </div>
      <div v-if="recording" class="hint rec-hint">
        {{ t('quickCmdUi.recordingHint', { count: recordedCount }) }}
      </div>
      <div v-if="playing" class="hint rec-hint">{{ t('quickCmdUi.playingHint') }}</div>
    </div>

    <!-- 列表下方的空白：平时就是留白，拖命令时才变成「移出分组」落区。
         放在滚动区之外，命令再多也不会被挤走，侧栏剩余高度也有了用途 -->
    <div
      class="cmd-tail"
      :class="{ active: dragOver === '__tail__', visible: dragging }"
      @dragover.prevent="dragOver = '__tail__'"
      @dragleave="dragOver === '__tail__' ? (dragOver = '') : null"
      @drop.prevent="onDrop('')"
    >
      <span v-if="dragging">{{ t('quickCmdUi.dropOutGroup') }}</span>
    </div>

    <!-- 新建分组 -->
    <el-dialog v-model="newGroupDlg" :title="t('quickCmdUi.newGroupTitle')" width="320px" append-to-body>
      <el-input
        v-model="newGroupName"
        :placeholder="t('quickCmdUi.newGroupPlaceholder')"
        @keydown.enter="onNewGroup"
      />
      <template #footer>
        <el-button @click="newGroupDlg = false">{{ t('quickCmdUi.cancel') }}</el-button>
        <el-button type="primary" @click="onNewGroup">{{ t('quickCmdUi.createGroup') }}</el-button>
      </template>
    </el-dialog>

    <!-- 重命名分组 -->
    <el-dialog v-model="renameDlg" :title="t('quickCmdUi.renameGroupTitle')" width="320px" append-to-body>
      <el-input
        v-model="renameCache"
        :placeholder="t('quickCmdUi.renameGroupPlaceholder')"
        @keydown.enter="onRename"
      />
      <template #footer>
        <el-button @click="renameDlg = false">{{ t('quickCmdUi.cancel') }}</el-button>
        <el-button type="primary" @click="onRename">{{ t('quickCmdUi.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- 步骤编辑弹窗 -->
    <el-dialog
      v-model="cmdDlg"
      :title="cmdEditIdx >= 0 ? t('quickCmdUi.editCmdTitle') : t('quickCmdUi.addCmdTitle')"
      width="560px"
      append-to-body
    >
      <el-form label-width="70px" size="small" @submit.prevent>
        <el-form-item :label="t('quickCmdUi.fieldName')">
          <el-input v-model="cmdDraft.name" :placeholder="t('quickCmdUi.cmdNamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('quickCmdUi.fieldGroup')">
          <el-select
            v-model="cmdDraft.group"
            filterable
            allow-create
            default-first-option
            clearable
            :placeholder="t('quickCmdUi.groupSelectPlaceholder')"
            style="width: 100%"
          >
            <el-option v-for="g in groupNames" :key="g" :value="g" :label="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="steps-head">
        <span>{{ t('quickCmdUi.stepsLabel') }}</span>
        <span>
          <el-button size="small" text :icon="Plus" @click="addStep('cmd')">{{ t('quickCmdUi.stepCmd') }}</el-button>
          <el-button size="small" text :icon="Timer" @click="addStep('sleep')">{{ t('quickCmdUi.stepSleep') }}</el-button>
          <el-button size="small" text :icon="EditPen" @click="addStep('key')">{{ t('quickCmdUi.stepKey') }}</el-button>
          <el-button v-if="runPluginAction" size="small" text :icon="Plus" @click="addStep('plugin-action')">{{ t('quickCmdUi.stepPluginAction') }}</el-button>
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
              :placeholder="st.mode === 'hex' ? 'AA 55 01' : t('quickCmdUi.cmdTextPlaceholder')"
            />
            <el-checkbox v-model="st.crlf" size="small">{{ t('quickCmdUi.newline') }}</el-checkbox>
          </template>
          <template v-else-if="st.type === 'sleep'">
            <el-tag size="small" type="info" effect="plain">{{ t('quickCmdUi.stepSleep') }}</el-tag>
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
          <template v-else-if="st.type === 'plugin-action'">
            <el-tag size="small" effect="plain">{{ t('quickCmdUi.stepPluginAction') }}</el-tag>
            <el-select :model-value="selectedPluginAction(st)" size="small" class="step-input" :placeholder="t('quickCmdUi.pickPluginAction')" @change="(value: string) => selectPluginAction(st, value)">
              <el-option v-if="selectedPluginAction(st) && !pluginActionAvailable(st)" :value="selectedPluginAction(st)" :label="(st.instanceId || '') + ' / ' + (st.actionId || '') + t('quickCmdUi.unavailableSuffix')" disabled />
              <el-option v-for="action in pluginActions" :key="pluginActionKey(action.instanceId, action.actionId)" :value="pluginActionKey(action.instanceId, action.actionId)" :label="action.instanceLabel + ' · ' + action.label" />
            </el-select>
            <el-button link type="primary" size="small" @click="emit('request-plugin-config')">{{ t('quickCmdUi.managePlugins') }}</el-button>
          </template>
          <template v-else-if="st.type === 'key'">
            <el-tag size="small" type="warning" effect="plain">{{ t('quickCmdUi.stepKey') }}</el-tag>
            <el-select v-model="st.key" size="small" filterable class="step-input">
              <el-option v-for="k in TERM_KEYS" :key="k.name" :value="k.seq" :label="k.name" />
            </el-select>
            <span class="hint">{{ keyName(st.key ?? '') }}</span>
          </template>
          <span v-else class="hint">{{ t('quickCmdUi.unsupportedStep') }}</span>
          <el-button link type="danger" size="small" @click="delStep(i)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
        <div v-if="pluginConfigError && cmdDraft.steps.some(step => step.type === 'plugin-action')" class="hint">{{ pluginConfigError }}</div>
        <div v-if="cmdDraft.steps.length === 0" class="hint" style="padding: 8px">
          {{ t('quickCmdUi.noStepsHint') }}
        </div>
      </div>
      <template #footer>
        <el-button @click="cmdDlg = false">{{ t('quickCmdUi.cancel') }}</el-button>
        <el-button type="primary" @click="onSaveCmd">{{ t('quickCmdUi.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 组件填满侧栏：标题固定，列表自己滚动，剩下的高度留给底部落区。
   这样侧栏再长也不会出现「上面一小块、下面一大片空白」 */
.quick-cmd { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }

.cmd-head { display:flex; align-items:center; justify-content:space-between; gap:4px; margin-bottom:6px; font-size:13px; font-weight:600; flex:none; }
.cmd-head-actions { display:flex; gap:2px; }
.cmd-head-actions :deep(.el-button) { margin:0; padding-inline:4px; }

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 列表吃掉侧栏剩余的全部高度：与下方落区共用 flex:1 时两者会被对半切开，
     命令少也把列表压成半屏、下半截空着 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 列表下方的落区：平时高度为 0（侧栏全部留给列表）；
   拖命令时才展开成虚线框接收「移出分组」 */
.cmd-tail { flex:0 0 auto; display:flex; align-items:center; justify-content:center; height:0; border-radius:7px; font-size:12px; color:var(--el-text-color-secondary); transition:height .12s ease; }
.cmd-tail.visible { height:44px; margin-top:6px; border:1px dashed var(--el-border-color); }
.cmd-tail.active { border:1px dashed var(--el-color-primary); background:var(--el-color-primary-light-9); }

.cmd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 9px;
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

.cmd-item.drop-before {
  box-shadow: inset 0 2px 0 var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.cmd-item.drop-after {
  box-shadow: inset 0 -2px 0 var(--el-color-primary);
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
  gap: 5px;
  padding: 6px 8px;
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
