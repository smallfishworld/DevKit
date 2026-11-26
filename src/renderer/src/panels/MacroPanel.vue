<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelMessage, usePanelMessageBox } from '@renderer/composables/panelOverlays'
import type { CheckboxValueType } from 'element-plus'
import {
  Aim,
  DocumentAdd,
  Download,
  Microphone,
  Plus,
  Refresh,
  Setting,
  SwitchButton,
  Upload,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import type {
  MacroFile,
  MacroSettings,
  MacroStep,
  StepType,
  WaitColorSpec
} from '../../../shared/macro'
import type { InputEventData, KeyEventData, MouseEventData, WheelEventData } from '../../../shared/types'
import { vkName } from '../../../shared/keynames'

const ElMessage = usePanelMessage()
const ElMessageBox = usePanelMessageBox()
const { t } = useI18n()

const props = defineProps<{ panelId: string }>()

interface LibItem {
  filename: string
  macro: MacroFile
}

interface PlayResultShape {
  completed: boolean
  stopped: boolean
  error: string | null
  elapsedMs: number
}

interface PlayEvt {
  running: boolean
  loop: number
  loops: number
  index: number
  total: number
  result?: PlayResultShape
}

const settings = ref<MacroSettings | null>(null)
const macros = ref<LibItem[]>([])
const current = ref<MacroFile | null>(null)
const currentFilename = ref<string | null>(null)
const recording = ref(false)
const recordCount = ref(0)
const playing = ref(false)
const progress = ref<PlayEvt | null>(null)
const speed = ref(1)
const loops = ref(1)

const steps = computed(() => current.value?.steps ?? [])

const segments = computed(() => [...new Set(steps.value.map((s) => s.segment))])

const playPercent = computed(() =>
  progress.value && progress.value.total > 0
    ? Math.round((progress.value.index / progress.value.total) * 100)
    : 0
)

function typeLabel(type: StepType): string {
  const map: Record<StepType, string> = {
    input: t('macro.typeInput'),
    delay: t('macro.typeDelay'),
    text: t('macro.typeText'),
    'wait-color': t('macro.typeWaitColor')
  }
  return map[type]
}

const TYPE_TAG: Record<StepType, 'primary' | 'success' | 'warning' | 'info'> = {
  input: 'primary',
  delay: 'info',
  text: 'warning',
  'wait-color': 'success'
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

let idSeq = 0
const genId = (): string => `e${Date.now().toString(36)}-${idSeq++}`

// ---------- 描述步骤（表格内容列） ----------

function modsOf(d: KeyEventData): string {
  return `${d.ctrl ? 'Ctrl+' : ''}${d.alt ? 'Alt+' : ''}${d.shift ? 'Shift+' : ''}${d.meta ? 'Win+' : ''}`
}

function btnName(b: MouseEventData['button']): string {
  return b === 'left' ? t('macro.btnLeft') : b === 'right' ? t('macro.btnRight') : t('macro.btnMiddle')
}

function describeData(d: InputEventData): string {
  if (d.kind === 'key') return `${d.down ? t('macro.keyDown') : t('macro.keyUp')} ${modsOf(d)}${vkName(d.vk)}`
  if (d.kind === 'mouse') {
    if (d.action === 'move') return t('macro.moveTo', { x: d.x, y: d.y })
    return t('macro.mouseAction', { button: btnName(d.button), action: d.action === 'down' ? t('macro.keyDown') : t('macro.keyUp'), x: d.x, y: d.y })
  }
  const w = d as WheelEventData
  return t('macro.wheelAction', { dir: w.delta > 0 ? t('macro.wheelUp') : t('macro.wheelDown'), steps: Math.abs(w.delta) / 120, x: w.x, y: w.y })
}

function describeStep(s: MacroStep): string {
  if (s.type === 'delay') return t('macro.delayStep', { ms: s.delayMs })
  if (s.type === 'text') return t('macro.textStep', { text: (s.text ?? '').slice(0, 40) })
  if (s.type === 'wait-color') {
    const w = s.wait
    if (!w) return t('macro.waitColorUnconfigured')
    return t('macro.waitColorStep', { mode: w.mode === 'appear' ? t('macro.waitAppear') : t('macro.waitDisappear'), color: w.color, x: w.x, y: w.y, tolerance: w.tolerance, timeout: w.timeoutMs })
  }
  return s.data ? describeData(s.data) : t('macro.emptyInputStep')
}

// ---------- 事件订阅与初始化 ----------

let unsubs: Array<() => void> = []

function onRecordEvent(payload: unknown): void {
  const p = payload as { recording: boolean; count: number; macro?: MacroFile }
  recording.value = p.recording
  if (p.recording) {
    recordCount.value = p.count
  } else {
    recordCount.value = 0
    if (p.count > 0 && p.macro) {
      current.value = clone(p.macro)
      currentFilename.value = null
      ElMessage.success(t('macro.recordDone', { count: p.count }))
    } else {
      ElMessage.warning(t('macro.recordEmpty'))
    }
  }
}

function onPlayEvent(payload: unknown): void {
  const p = payload as PlayEvt
  playing.value = p.running
  if (p.running) {
    progress.value = p
  } else {
    progress.value = null
    const r = p.result
    if (!r) return
    if (r.error) ElMessage.error(t('macro.playFailed', { error: r.error }))
    else if (r.completed) ElMessage.success(t('macro.playDone', { seconds: (r.elapsedMs / 1000).toFixed(1) }))
    else ElMessage.info(t('macro.playStopped'))
  }
}

onMounted(async () => {
  unsubs.push(
    window.api.on('macro', props.panelId, 'record', onRecordEvent),
    window.api.on('macro', props.panelId, 'play', onPlayEvent)
  )
  const res = (await window.api.invoke('macro', 'attach', props.panelId)) as {
    settings: MacroSettings | null
  }
  if (res.settings) {
    settings.value = res.settings
    speed.value = res.settings.speed
    loops.value = res.settings.loops
  }
  const rs = (await window.api.invoke('macro', 'record:status', props.panelId)) as {
    recording: boolean
  }
  recording.value = rs.recording
  const ps = (await window.api.invoke('macro', 'play:status', props.panelId)) as {
    playing: boolean
  }
  playing.value = ps.playing
  await refreshList()
})

onUnmounted(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  window.api.invoke('macro', 'dispose', props.panelId).catch(() => {})
})

// ---------- 录制 / 回放 ----------

async function startRecord(): Promise<void> {
  const res = (await window.api.invoke('macro', 'record:start', props.panelId)) as {
    recording: boolean
  }
  recording.value = res.recording
  if (!res.recording) ElMessage.warning(t('macro.startRecordFailed'))
}

function stopRecord(): void {
  void window.api.invoke('macro', 'record:stop', props.panelId)
}

function playMacro(macro: MacroFile): void {
  if (!macro.steps.length) {
    ElMessage.warning(t('macro.noStepsToPlay'))
    return
  }
  window.api
    .invoke('macro', 'play:start', props.panelId, {
      macro: clone(macro),
      speed: speed.value,
      loops: loops.value
    })
    .then((res) => {
      const err = (res as { error?: string }).error
      if (err) ElMessage.warning(err)
    })
    .catch(() => {})
}

function playEditor(): void {
  if (current.value) playMacro(current.value)
}

function stopPlay(): void {
  void window.api.invoke('macro', 'play:stop', props.panelId)
}

// ---------- 宏库 ----------

async function refreshList(): Promise<void> {
  macros.value = (await window.api.invoke('macro', 'macro:list', props.panelId)) as LibItem[]
}

function newMacro(): void {
  current.value = {
    version: 1,
    meta: { name: '', hotkey: '', createdAt: Date.now(), updatedAt: Date.now() },
    steps: []
  }
  currentFilename.value = null
}

function loadFile(item: LibItem): void {
  current.value = clone(item.macro)
  currentFilename.value = item.filename
}

async function deleteFile(item: LibItem): Promise<void> {
  try {
    await ElMessageBox.confirm(t('macro.deleteConfirm', { name: item.macro.meta.name }), t('macro.deleteTitle'), {
      type: 'warning'
    })
  } catch {
    return
  }
  await window.api.invoke('macro', 'macro:delete', props.panelId, { filename: item.filename })
  if (currentFilename.value === item.filename) currentFilename.value = null
  ElMessage.success(t('macro.deleted'))
  await refreshList()
}

function exportFile(item: LibItem): void {
  void window.api
    .invoke('macro', 'macro:export', props.panelId, { macro: item.macro })
    .then((res) => {
      if ((res as { ok: boolean }).ok) ElMessage.success(t('macro.exported'))
    })
}

function exportCurrent(): void {
  if (!current.value || !current.value.steps.length) {
    ElMessage.warning(t('macro.noMacroToExport'))
    return
  }
  void window.api
    .invoke('macro', 'macro:export', props.panelId, { macro: clone(current.value) })
    .then((res) => {
      if ((res as { ok: boolean }).ok) ElMessage.success(t('macro.exported'))
    })
}

async function importMacro(): Promise<void> {
  const res = (await window.api.invoke('macro', 'macro:import', props.panelId)) as {
    ok: boolean
    macro?: MacroFile
  }
  if (res.ok && res.macro) {
    current.value = clone(res.macro)
    currentFilename.value = null
    ElMessage.success(t('macro.imported', { name: res.macro.meta.name }))
    await refreshList()
  }
}

async function saveCurrent(): Promise<void> {
  if (!current.value) return
  if (!current.value.steps.length) {
    ElMessage.warning(t('macro.noStepsToSave'))
    return
  }
  if (!current.value.meta.name.trim()) {
    current.value.meta.name = t('macro.defaultName', { time: new Date().toLocaleString() })
  }
  const res = (await window.api.invoke('macro', 'macro:save', props.panelId, {
    macro: clone(current.value),
    originalFilename: currentFilename.value ?? undefined // 重命名时主进程据此删旧文件/注销旧热键
  })) as {
    ok: boolean
    filename?: string
    error?: string
    hotkey?: { ok: boolean; reason?: string }
  }
  if (!res.ok) {
    ElMessage.error(t('macro.saveFailed', { error: res.error ?? '' }))
    return
  }
  currentFilename.value = res.filename ?? null
  ElMessage.success(t('macro.savedToLib'))
  if (res.hotkey && !res.hotkey.ok) {
    ElMessage.warning(t('macro.hotkeyFailed', { reason: res.hotkey.reason ?? t('macro.hotkeyTaken') }))
  }
  await refreshList()
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------- 步骤编辑 ----------

interface StepDialog {
  visible: boolean
  id: string
  type: StepType
  segment: string
  enabled: boolean
  delayMs: number
  text: string
  key: KeyEventData
  mouse: MouseEventData
  wheel: WheelEventData
  wait: WaitColorSpec
}

const dlgKind = ref<'key' | 'mouse' | 'wheel'>('key')

const dlg = reactive<StepDialog>({
  visible: false,
  id: '',
  type: 'delay',
  segment: t('macro.manualSegment'),
  enabled: true,
  delayMs: 0,
  text: '',
  key: { kind: 'key', vk: 0x0d, down: true, ctrl: false, alt: false, shift: false, meta: false },
  mouse: { kind: 'mouse', action: 'down', button: 'left', x: 0, y: 0 },
  wheel: { kind: 'wheel', x: 0, y: 0, delta: -120 },
  wait: { x: 0, y: 0, color: '#FF0000', tolerance: 10, mode: 'appear', timeoutMs: 10000 }
})

const dlgTitle = computed(() => t('macro.editStepTitle', { type: typeLabel(dlg.type) }))

function openStepDialog(step: MacroStep): void {
  dlg.id = step.id
  dlg.type = step.type
  dlg.segment = step.segment
  dlg.enabled = step.enabled
  dlg.delayMs = step.delayMs
  dlg.text = step.text ?? ''
  if (step.data?.kind === 'key') {
    dlgKind.value = 'key'
    Object.assign(dlg.key, step.data)
  } else if (step.data?.kind === 'mouse') {
    dlgKind.value = 'mouse'
    Object.assign(dlg.mouse, step.data)
  } else if (step.data?.kind === 'wheel') {
    dlgKind.value = 'wheel'
    Object.assign(dlg.wheel, step.data)
  }
  if (step.wait) Object.assign(dlg.wait, step.wait)
  dlg.visible = true
}

function editStepAt(index: number): void {
  const step = steps.value[index]
  if (step) openStepDialog(step)
}

function saveStep(): void {
  const target = current.value?.steps.find((s) => s.id === dlg.id)
  if (!target) {
    dlg.visible = false
    return
  }
  target.segment = dlg.segment.trim() || t('macro.defaultSegment')
  target.enabled = dlg.enabled
  target.delayMs = Math.max(0, Math.round(dlg.delayMs))
  if (dlg.type === 'text') target.text = dlg.text
  if (dlg.type === 'wait-color') target.wait = { ...dlg.wait }
  if (dlg.type === 'input') {
    target.data =
      dlgKind.value === 'key'
        ? { ...dlg.key }
        : dlgKind.value === 'mouse'
          ? { ...dlg.mouse }
          : { ...dlg.wheel }
  }
  dlg.visible = false
}

function removeStep(index: number): void {
  current.value?.steps.splice(index, 1)
}

function moveStep(index: number, dir: -1 | 1): void {
  const arr = current.value?.steps
  if (!arr) return
  const j = index + dir
  if (j < 0 || j >= arr.length) return
  const [item] = arr.splice(index, 1)
  arr.splice(j, 0, item)
}

function insertStep(type: StepType): void {
  if (!current.value) newMacro()
  const macro = current.value as MacroFile
  const step: MacroStep = {
    id: genId(),
    segment: t('macro.manualSegment'),
    enabled: true,
    type,
    delayMs: type === 'delay' ? 500 : 0
  }
  if (type === 'text') step.text = ''
  if (type === 'wait-color') {
    step.wait = { x: 0, y: 0, color: '#FF0000', tolerance: 10, mode: 'appear', timeoutMs: 10000 }
  }
  if (type === 'input') {
    step.data = { kind: 'key', vk: 0x0d, down: true, ctrl: false, alt: false, shift: false, meta: false }
  }
  macro.steps.push(step)
  openStepDialog(step)
}

async function pickForWait(): Promise<void> {
  const res = (await window.api.invoke('macro', 'macro:pick-point', props.panelId)) as {
    x: number
    y: number
    color: string
  } | null
  if (res) {
    dlg.wait.x = res.x
    dlg.wait.y = res.y
    dlg.wait.color = res.color
  }
}

// ---------- 段开关 ----------

function segmentAllEnabled(seg: string): boolean {
  return steps.value.filter((s) => s.segment === seg).every((s) => s.enabled)
}

function toggleSegment(seg: string, v: CheckboxValueType): void {
  for (const s of steps.value) {
    if (s.segment === seg) s.enabled = Boolean(v)
  }
}

// ---------- 设置 ----------

type HotkeyField = 'hotkeyRecord' | 'hotkeyPlay' | 'hotkeyStop'

const settingsDlg = ref(false)
const draft = reactive<MacroSettings>({
  hotkeyRecord: 'F9',
  hotkeyPlay: 'F10',
  hotkeyStop: 'F11',
  ignoreMoves: true,
  suppressOwnHotkeys: true,
  speed: 1,
  loops: 1,
  escStop: false
})

function openSettings(): void {
  Object.assign(draft, clone(settings.value ?? draft))
  settingsDlg.value = true
}

function capKey(e: KeyboardEvent, field: HotkeyField): void {
  e.preventDefault()
  e.stopPropagation()
  const key = e.key
  // 修饰键单独按下时等待主键
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  let main: string | null = key
  if (/^[a-z]$/i.test(key)) main = key.toUpperCase()
  else if (/^[0-9]$/.test(key) || /^F\d{1,2}$/.test(key)) main = key
  else
    main = (
      {
        ' ': 'Space',
        Escape: 'Esc',
        Enter: 'Enter',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Delete: 'Delete',
        Tab: 'Tab'
      } as Record<string, string>
    )[key] ?? null
  if (!main) return
  draft[field] = [...parts, main].join('+')
}

async function saveSettings(): Promise<void> {
  const res = (await window.api.invoke('macro', 'settings:set', props.panelId, {
    settings: clone(draft)
  })) as {
    ok: boolean
    results?: { id: string; accelerator: string; ok: boolean; reason?: string }[]
  }
  if (!res.ok) {
    ElMessage.error(t('macro.settingsSaveFailed'))
    return
  }
  settings.value = clone(draft)
  settingsDlg.value = false
  ElMessage.success(t('macro.settingsSaved'))
  for (const r of res.results ?? []) {
    if (!r.ok) ElMessage.warning(t('macro.hotkeyRegFailed', { acc: r.accelerator, reason: r.reason ?? t('macro.hotkeyTaken') }))
  }
}
</script>

<template>
  <div class="panel macro-panel">
    <!-- 顶部操作条 -->
    <div class="panel-section">
      <div class="toolbar">
        <el-button
          v-if="!recording"
          size="small"
          type="danger"
          :icon="Microphone"
          :disabled="playing"
          @click="startRecord"
        >
          {{ t('macro.startRecord', { key: settings?.hotkeyRecord ?? 'F9' }) }}
        </el-button>
        <el-button v-else size="small" type="warning" :icon="SwitchButton" @click="stopRecord">
          {{ t('macro.stopRecord', { count: recordCount }) }}
        </el-button>
        <el-button
          size="small"
          type="primary"
          :icon="VideoPlay"
          :disabled="recording || playing || !current || current.steps.length === 0"
          @click="playEditor"
        >
          {{ t('macro.playCurrent', { key: settings?.hotkeyPlay ?? 'F10' }) }}
        </el-button>
        <el-button size="small" :icon="VideoPause" :disabled="!playing" @click="stopPlay">
          {{ t('macro.stopPlay', { key: settings?.hotkeyStop ?? 'F11' }) }}
        </el-button>
        <el-divider direction="vertical" />
        <span class="lbl">{{ t('macro.speed') }}</span>
        <el-input-number
          v-model="speed"
          :min="0.1"
          :max="10"
          :step="0.1"
          size="small"
          :disabled="playing"
          style="width: 104px"
        />
        <span class="lbl">{{ t('macro.loops') }}</span>
        <el-input-number
          v-model="loops"
          :min="0"
          :step="1"
          size="small"
          :disabled="playing"
          style="width: 90px"
        />
        <el-tag v-if="loops === 0" size="small" type="info">{{ t('macro.infinite') }}</el-tag>
        <el-divider direction="vertical" />
        <el-button size="small" :icon="Setting" :disabled="recording || playing" @click="openSettings">
          {{ t('macro.settings') }}
        </el-button>
        <el-tag v-if="recording" size="small" type="danger" effect="dark">{{ t('macro.statusRecording') }}</el-tag>
        <el-tag v-else-if="playing" size="small" type="success" effect="dark">{{ t('macro.statusPlaying') }}</el-tag>
        <el-tag v-else size="small" type="info">{{ t('macro.statusIdle') }}</el-tag>
      </div>
      <el-progress
        v-if="playing && progress"
        :percentage="playPercent"
        :stroke-width="8"
        :show-text="false"
        style="margin-top: 8px"
      />
    </div>

    <div class="columns">
      <!-- 宏库 -->
      <div class="panel-section col-lib">
        <h3>
          {{ t('macro.library') }}
          <el-button size="small" text :icon="Refresh" @click="refreshList" />
        </h3>
        <div class="lib-ops">
          <el-button size="small" :icon="DocumentAdd" :disabled="recording || playing" @click="newMacro">
            {{ t('macro.newMacro') }}
          </el-button>
          <el-button size="small" :icon="Upload" :disabled="recording || playing" @click="importMacro">
            {{ t('macro.import') }}
          </el-button>
        </div>
        <el-table :data="macros" size="small" height="430" style="width: 100%">
          <el-table-column :label="t('macro.colName')" min-width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ (row as LibItem).macro.meta.name }}</template>
          </el-table-column>
          <el-table-column :label="t('macro.colHotkey')" width="92">
            <template #default="{ row }">
              <el-tag v-if="(row as LibItem).macro.meta.hotkey" size="small">
                {{ (row as LibItem).macro.meta.hotkey }}
              </el-tag>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('macro.colSteps')" width="56">
            <template #default="{ row }">{{ (row as LibItem).macro.steps.length }}</template>
          </el-table-column>
          <el-table-column :label="t('macro.colUpdated')" width="92">
            <template #default="{ row }">{{ fmtTime((row as LibItem).macro.meta.updatedAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('macro.colActions')" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="loadFile(row as LibItem)">
                {{ t('macro.load') }}
              </el-button>
              <el-button
                link
                type="success"
                size="small"
                :disabled="recording || playing"
                @click="playMacro((row as LibItem).macro)"
              >
                {{ t('macro.play') }}
              </el-button>
              <el-button link size="small" @click="exportFile(row as LibItem)">{{ t('macro.export') }}</el-button>
              <el-button link type="danger" size="small" @click="deleteFile(row as LibItem)">
                {{ t('macro.delete') }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>{{ t('macro.emptyLib') }}</template>
        </el-table>
      </div>

      <!-- 编辑器 -->
      <div class="panel-section col-edit">
        <template v-if="current">
          <div class="edit-head">
            <el-input
              v-model="current.meta.name"
              :placeholder="t('macro.macroNamePlaceholder')"
              size="small"
              style="width: 170px"
            />
            <el-input
              v-model="current.meta.hotkey"
              :placeholder="t('macro.hotkeyPlaceholder')"
              size="small"
              style="width: 160px"
            />
            <el-button
              size="small"
              type="primary"
              :disabled="recording || playing"
              @click="saveCurrent"
            >
              {{ t('macro.save') }}
            </el-button>
            <el-button size="small" :icon="Download" :disabled="recording || playing" @click="exportCurrent">
              {{ t('macro.export') }}
            </el-button>
            <span class="hint">{{ currentFilename ? t('macro.fileLabel', { name: currentFilename }) : t('macro.unsaved') }}</span>
          </div>

          <div class="seg-row" v-if="segments.length">
            <span class="lbl">{{ t('macro.segmentSwitch') }}</span>
            <el-checkbox
              v-for="seg in segments"
              :key="seg"
              :model-value="segmentAllEnabled(seg)"
              size="small"
              @change="(v: CheckboxValueType) => toggleSegment(seg, v)"
            >
              {{ seg }}（{{ steps.filter((s) => s.segment === seg).length }}）
            </el-checkbox>
          </div>

          <div class="edit-ops">
            <el-button size="small" :icon="Plus" :disabled="recording || playing" @click="insertStep('delay')">
              {{ t('macro.insertDelay') }}
            </el-button>
            <el-button size="small" :icon="Plus" :disabled="recording || playing" @click="insertStep('text')">
              {{ t('macro.insertText') }}
            </el-button>
            <el-button
              size="small"
              :icon="Aim"
              :disabled="recording || playing"
              @click="insertStep('wait-color')"
            >
              {{ t('macro.insertWaitColor') }}
            </el-button>
            <span class="hint">{{ t('macro.playHotkeyHint') }}</span>
          </div>

          <el-table :data="steps" size="small" height="380" style="width: 100%">
            <el-table-column type="index" label="#" width="48" />
            <el-table-column :label="t('macro.colSegment')" width="82">
              <template #default="{ row }">
                <el-tag size="small" type="info">{{ (row as MacroStep).segment }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('macro.colEnabled')" width="54">
              <template #default="{ row }">
                <el-checkbox v-model="(row as MacroStep).enabled" />
              </template>
            </el-table-column>
            <el-table-column :label="t('macro.colType')" width="82">
              <template #default="{ row }">
                <el-tag size="small" :type="TYPE_TAG[(row as MacroStep).type]">
                  {{ typeLabel((row as MacroStep).type) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('macro.colContent')" min-width="230" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="mono">{{ describeStep(row as MacroStep) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('macro.colDelayMs')" width="136">
              <template #default="{ row }">
                <el-input-number
                  v-model="(row as MacroStep).delayMs"
                  :min="0"
                  :step="50"
                  size="small"
                  style="width: 118px"
                />
              </template>
            </el-table-column>
            <el-table-column :label="t('macro.colActions')" width="168" fixed="right">
              <template #default="{ $index }">
                <el-button link size="small" :disabled="$index === 0" @click="moveStep($index, -1)">
                  ↑
                </el-button>
                <el-button
                  link
                  size="small"
                  :disabled="$index === steps.length - 1"
                  @click="moveStep($index, 1)"
                >
                  ↓
                </el-button>
                <el-button link type="primary" size="small" @click="editStepAt($index)">{{ t('macro.edit') }}</el-button>
                <el-button link type="danger" size="small" @click="removeStep($index)">{{ t('macro.delete') }}</el-button>
              </template>
            </el-table-column>
            <template #empty>{{ t('macro.emptySteps') }}</template>
          </el-table>
        </template>
        <el-empty v-else :description="t('macro.emptyEditor')" />
      </div>
    </div>

    <!-- 步骤编辑对话框 -->
    <el-dialog v-model="dlg.visible" :title="dlgTitle" width="500px" :close-on-click-modal="false">
      <el-form label-width="84px" size="small">
        <el-form-item :label="t('macro.fieldSegment')">
          <el-input v-model="dlg.segment" style="width: 180px" />
        </el-form-item>
        <el-form-item :label="t('macro.fieldEnabled')">
          <el-checkbox v-model="dlg.enabled" />
        </el-form-item>
        <el-form-item :label="t('macro.fieldPreDelay')">
          <el-input-number v-model="dlg.delayMs" :min="0" :step="50" />
          <span class="hint" style="margin-left: 8px">{{ t('macro.preDelayHint') }}</span>
        </el-form-item>

        <template v-if="dlg.type === 'input' && dlgKind === 'key'">
          <el-form-item :label="t('macro.fieldKeyName')">
            <el-input :model-value="vkName(dlg.key.vk)" disabled style="width: 140px" />
            <span style="margin-left: 8px">VK</span>
            <el-input-number v-model="dlg.key.vk" :min="0" :max="255" style="margin-left: 8px" />
          </el-form-item>
          <el-form-item :label="t('macro.fieldAction')">
            <el-radio-group v-model="dlg.key.down">
              <el-radio-button :value="true">{{ t('macro.keyDown') }}</el-radio-button>
              <el-radio-button :value="false">{{ t('macro.keyUp') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('macro.fieldModifiers')">
            <el-checkbox v-model="dlg.key.ctrl">Ctrl</el-checkbox>
            <el-checkbox v-model="dlg.key.alt">Alt</el-checkbox>
            <el-checkbox v-model="dlg.key.shift">Shift</el-checkbox>
            <el-checkbox v-model="dlg.key.meta">Win</el-checkbox>
          </el-form-item>
        </template>

        <template v-else-if="dlg.type === 'input' && dlgKind === 'mouse'">
          <el-form-item :label="t('macro.fieldAction')">
            <el-radio-group v-model="dlg.mouse.action">
              <el-radio-button value="move">{{ t('macro.mouseMove') }}</el-radio-button>
              <el-radio-button value="down">{{ t('macro.keyDown') }}</el-radio-button>
              <el-radio-button value="up">{{ t('macro.keyUp') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('macro.fieldButton')">
            <el-radio-group v-model="dlg.mouse.button">
              <el-radio-button value="left">{{ t('macro.btnLeft') }}</el-radio-button>
              <el-radio-button value="right">{{ t('macro.btnRight') }}</el-radio-button>
              <el-radio-button value="middle">{{ t('macro.btnMiddle') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('macro.fieldCoords')">
            <el-input-number v-model="dlg.mouse.x" :step="1" style="width: 130px" />
            <el-input-number v-model="dlg.mouse.y" :step="1" style="width: 130px; margin-left: 8px" />
          </el-form-item>
        </template>

        <template v-else-if="dlg.type === 'input' && dlgKind === 'wheel'">
          <el-form-item :label="t('macro.fieldWheelDelta')">
            <el-input-number v-model="dlg.wheel.delta" :step="120" />
            <span class="hint" style="margin-left: 8px">{{ t('macro.wheelDeltaHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('macro.fieldCoords')">
            <el-input-number v-model="dlg.wheel.x" style="width: 130px" />
            <el-input-number v-model="dlg.wheel.y" style="width: 130px; margin-left: 8px" />
          </el-form-item>
        </template>

        <el-form-item v-else-if="dlg.type === 'text'" :label="t('macro.typeText')">
          <el-input
            v-model="dlg.text"
            type="textarea"
            :rows="3"
            :placeholder="t('macro.textPlaceholder')"
          />
        </el-form-item>

        <template v-else-if="dlg.type === 'wait-color'">
          <el-form-item :label="t('macro.fieldCoords')">
            <el-input-number v-model="dlg.wait.x" :step="1" style="width: 130px" />
            <el-input-number v-model="dlg.wait.y" :step="1" style="width: 130px; margin-left: 8px" />
            <el-button :icon="Aim" style="margin-left: 8px" @click="pickForWait">{{ t('macro.pickPoint') }}</el-button>
          </el-form-item>
          <el-form-item :label="t('macro.fieldColor')">
            <el-color-picker v-model="dlg.wait.color" />
            <span class="mono" style="margin-left: 8px">{{ dlg.wait.color }}</span>
          </el-form-item>
          <el-form-item :label="t('macro.fieldTolerance')">
            <el-input-number v-model="dlg.wait.tolerance" :min="0" :max="255" />
            <span class="hint" style="margin-left: 8px">{{ t('macro.toleranceHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('macro.fieldMode')">
            <el-radio-group v-model="dlg.wait.mode">
              <el-radio-button value="appear">{{ t('macro.waitAppear') }}</el-radio-button>
              <el-radio-button value="disappear">{{ t('macro.waitDisappear') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('macro.fieldTimeout')">
            <el-input-number v-model="dlg.wait.timeoutMs" :min="500" :step="500" />
            <span class="hint" style="margin-left: 8px">{{ t('macro.timeoutHint') }}</span>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">{{ t('macro.cancel') }}</el-button>
        <el-button type="primary" @click="saveStep">{{ t('macro.confirm') }}</el-button>
      </template>
    </el-dialog>

    <!-- 设置对话框 -->
    <el-dialog v-model="settingsDlg" :title="t('macro.settingsTitle')" width="540px" :close-on-click-modal="false">
      <el-form label-width="170px" size="small">
        <el-form-item :label="t('macro.hotkeyRecordLabel')">
          <el-input
            :model-value="draft.hotkeyRecord"
            class="hk-input"
            :placeholder="t('macro.pressHotkeyPlaceholder')"
            @keydown.capture.prevent="capKey($event, 'hotkeyRecord')"
          />
        </el-form-item>
        <el-form-item :label="t('macro.hotkeyPlayLabel')">
          <el-input
            :model-value="draft.hotkeyPlay"
            class="hk-input"
            :placeholder="t('macro.pressHotkeyPlaceholder')"
            @keydown.capture.prevent="capKey($event, 'hotkeyPlay')"
          />
        </el-form-item>
        <el-form-item :label="t('macro.hotkeyStopLabel')">
          <el-input
            :model-value="draft.hotkeyStop"
            class="hk-input"
            :placeholder="t('macro.pressHotkeyPlaceholder')"
            @keydown.capture.prevent="capKey($event, 'hotkeyStop')"
          />
        </el-form-item>
        <el-form-item :label="t('macro.ignoreMovesLabel')">
          <el-switch v-model="draft.ignoreMoves" />
        </el-form-item>
        <el-form-item :label="t('macro.suppressOwnLabel')">
          <el-switch v-model="draft.suppressOwnHotkeys" />
          <span class="hint" style="margin-left: 8px">{{ t('macro.suppressOwnHint') }}</span>
        </el-form-item>
        <el-form-item :label="t('macro.escStopLabel')">
          <el-switch v-model="draft.escStop" />
        </el-form-item>
        <el-form-item :label="t('macro.defaultSpeedLabel')">
          <el-input-number v-model="draft.speed" :min="0.1" :max="10" :step="0.1" />
        </el-form-item>
        <el-form-item :label="t('macro.defaultLoopsLabel')">
          <el-input-number v-model="draft.loops" :min="0" :step="1" />
          <span class="hint" style="margin-left: 8px">{{ t('macro.infiniteLoopsHint') }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="settingsDlg = false">{{ t('macro.cancel') }}</el-button>
        <el-button type="primary" @click="saveSettings">{{ t('macro.saveSettings') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.macro-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 1480px;
  margin-inline: auto;
  overflow: auto;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.mono {
  font-family: var(--font-mono);
}

.columns {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.col-lib {
  flex: 0 0 460px;
}

.col-edit {
  flex: 1;
  min-width: 0;
}

.lib-ops {
  display: flex;
  gap: 8px;
  margin: 6px 0;
}

.edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.seg-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.edit-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.hk-input {
  width: 220px;
}
</style>
