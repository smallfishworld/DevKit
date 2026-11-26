<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelMessage, usePanelMessageBox } from '@renderer/composables/panelOverlays'
import { Delete, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import type { PluginDescriptor, PluginInstance, PluginLogEntry, PluginRuntimeStatus } from '../../../shared/plugins'
import PluginConfigForm from './PluginConfigForm.vue'
import { defaultPluginConfig, parseConfigJson, canStopPlugin } from './plugin-config-form'

const ElMessage = usePanelMessage()
const ElMessageBox = usePanelMessageBox()
const { t } = useI18n()

const props = defineProps<{ visible: boolean; panelId: string; connected: boolean }>()
const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  (event: 'changed'): void
}>()
const visible = computed({ get: () => props.visible, set: (value: boolean) => emit('update:visible', value) })
const tab = ref('instances')
const plugins = ref<PluginDescriptor[]>([])
const instances = ref<PluginInstance[]>([])
const statuses = ref<PluginRuntimeStatus[]>([])
const logs = ref<PluginLogEntry[]>([])
const loading = ref(false)
const pending = ref('')
const stopping = ref('')
const error = ref('')
const installPath = ref('')
const editVisible = ref(false)
const editMode = ref('form')
const formValid = ref(true)
const editorError = ref('')
const editorJson = ref('')
const editorKey = ref(0)
const draft = reactive({
  id: '', pluginId: '', label: '', config: {} as Record<string, unknown>, enabled: true, autoEnabled: false
})
const editingPlugin = computed(() => plugins.value.find(plugin => plugin.id === draft.pluginId))
const sessionLogs = computed(() => logs.value.filter(entry => entry.panelId === props.panelId))
function stateLabel(state: string): string {
  const map: Record<string, string> = {
    idle: t('pluginMgr.stateIdle'), starting: t('pluginMgr.stateStarting'), ready: t('pluginMgr.stateReady'),
    running: t('pluginMgr.stateRunning'), stopped: t('pluginMgr.stateStopped'), error: t('pluginMgr.stateError')
  }
  return map[state] || state
}
let refreshTimer: ReturnType<typeof setInterval> | undefined
let unsubscribers: Array<() => void> = []
let loadSequence = 0

type Reply<T> = T & { ok: boolean; error?: string }
async function api<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.api.invoke('plugins', action, props.panelId, payload) as Reply<T>
  if (!result.ok) throw new Error(result.error || t('pluginMgr.opFailed'))
  return result
}
function pluginFor(instance: PluginInstance): PluginDescriptor | undefined {
  return plugins.value.find(plugin => plugin.id === instance.pluginId)
}
function statusFor(instanceId: string): PluginRuntimeStatus | undefined {
  return statuses.value.find(status => status.instanceId === instanceId)
}
function isBoundHere(instanceId: string): boolean {
  const status = statusFor(instanceId)
  return !!status?.bound && status.panelId === props.panelId
}
function statusLabel(instanceId: string): string {
  const status = statusFor(instanceId)
  if (!status) return t('pluginMgr.unbound')
  if (status.bound && status.panelId !== props.panelId) return t('pluginMgr.boundOther')
  return stateLabel(status.state)
}
function statusType(instanceId: string): 'success' | 'danger' | 'info' | 'warning' {
  const status = statusFor(instanceId)
  if (status?.state === 'error') return 'danger'
  if (status?.bound && status.panelId === props.panelId) return 'success'
  return status?.bound ? 'warning' : 'info'
}
async function load(showLoading = true): Promise<void> {
  const sequence = ++loadSequence
  if (showLoading) loading.value = true
  try {
    const results = await Promise.allSettled([
      api<{ plugins: PluginDescriptor[] }>('list'),
      api<{ instances: PluginInstance[] }>('instance:list'),
      api<{ statuses: PluginRuntimeStatus[]; logs: PluginLogEntry[] }>('status')
    ])
    if (sequence !== loadSequence) return
    if (results[0].status === 'fulfilled') plugins.value = results[0].value.plugins
    if (results[1].status === 'fulfilled') instances.value = results[1].value.instances
    if (results[2].status === 'fulfilled') {
      statuses.value = results[2].value.statuses
      logs.value = results[2].value.logs.slice(-200)
    }
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) error.value = failures.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)).join('\n')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
async function operate(name: string, action: () => Promise<unknown>): Promise<void> {
  if (pending.value) return
  pending.value = name
  error.value = ''
  try {
    await action()
    await load(false)
    emit('changed')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    pending.value = ''
  }
}
function edit(instance?: PluginInstance, plugin?: PluginDescriptor): void {
  const selected = plugin || (instance ? pluginFor(instance) : undefined)
  if (!selected) {
    error.value = t('pluginMgr.notInstalledEdit')
    return
  }
  draft.id = instance?.id || ''
  draft.pluginId = selected.id
  draft.label = instance?.label || selected.name
  draft.config = instance ? JSON.parse(JSON.stringify(instance.config)) : defaultPluginConfig(selected.configSchema)
  draft.enabled = instance?.enabled ?? true
  draft.autoEnabled = instance?.autoEnabled ?? false
  editorJson.value = JSON.stringify(draft.config, null, 2)
  editMode.value = 'form'
  formValid.value = true
  editorError.value = ''
  editorKey.value++
  editVisible.value = true
}
function changeEditorMode(mode: string | number, previous: string | number): boolean {
  if (mode === 'json') {
    if (!formValid.value) {
      editorError.value = t('pluginEditor.fixJsonFirst')
      return false
    }
    editorJson.value = JSON.stringify(draft.config, null, 2)
    editorError.value = ''
  } else if (previous === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (parsed.error || !parsed.config) {
      editorError.value = parsed.error || t('pluginEditor.invalidConfig')
      return false
    }
    draft.config = parsed.config
    formValid.value = true
    editorError.value = ''
    editorKey.value++
  }
  return true
}
async function saveInstance(): Promise<void> {
  if (pending.value) return
  editorError.value = ''
  if (!draft.label.trim()) { editorError.value = t('pluginMgr.labelRequired'); return }
  let config = draft.config
  if (editMode.value === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (!parsed.config) { editorError.value = parsed.error || t('pluginEditor.invalidConfig'); return }
    config = parsed.config
  } else if (!formValid.value) {
    editorError.value = t('pluginEditor.fixJsonFirst')
    return
  }
  pending.value = 'save'
  try {
    await api('instance:save', { instance: {
      ...(draft.id ? { id: draft.id } : {}),
      pluginId: draft.pluginId, label: draft.label.trim(),
      config: JSON.parse(JSON.stringify(config)), enabled: draft.enabled,
      autoEnabled: draft.autoEnabled, configVersion: 1
    } })
    editVisible.value = false
    await load(false)
    emit('changed')
    ElMessage.success(t('pluginMgr.saved'))
  } catch (failure) {
    editorError.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    pending.value = ''
  }
}
async function toggleInstance(instance: PluginInstance, enabled: boolean): Promise<void> {
  await operate('toggle', () => api('instance:save', { instance: { ...JSON.parse(JSON.stringify(instance)), enabled } }))
}
async function toggleAuto(instance: PluginInstance, autoEnabled: boolean): Promise<void> {
  await operate('auto', () => api('instance:save', { instance: { ...JSON.parse(JSON.stringify(instance)), autoEnabled } }))
}
async function removeInstance(instance: PluginInstance): Promise<void> {
  try {
    await ElMessageBox.confirm(t('pluginMgr.deleteInstanceConfirm', { label: instance.label }), t('extCenter.deleteInstanceTitle'), { type: 'warning' })
  } catch { return }
  await operate('delete', () => api('instance:delete', { instanceId: instance.id }))
}
async function removePlugin(plugin: PluginDescriptor): Promise<void> {
  try {
    await ElMessageBox.confirm(t('pluginMgr.uninstallConfirm', { name: plugin.name }), t('extCenter.uninstallTitle'), { type: 'warning' })
  } catch { return }
  await operate('remove', () => api('remove', { pluginId: plugin.id }))
}
async function install(browse: boolean): Promise<void> {
  const path = installPath.value.trim()
  if (!browse && !path) { error.value = t('pluginMgr.pathRequired'); return }
  try {
    await ElMessageBox.confirm(
      t('pluginMgr.trustConfirm'),
      t('pluginMgr.trustConfirmTitle'), { type: 'warning', confirmButtonText: t('pluginMgr.trustConfirmBtn'), cancelButtonText: t('extCenter.cancel') }
    )
  } catch { return }
  await operate('install', async () => {
    await api('install', browse ? undefined : { path })
    installPath.value = ''
    ElMessage.success(t('pluginMgr.installedSuccess'))
  })
}
async function bind(instance: PluginInstance): Promise<void> {
  await operate('bind', () => api('bind', { instanceId: instance.id }))
}
async function unbind(instance: PluginInstance): Promise<void> {
  await operate('unbind', () => api('unbind', { instanceId: instance.id }))
}
async function stop(instance: PluginInstance): Promise<void> {
  // Cancellation must remain available while run is awaiting the plugin.
  if (!canStopPlugin(isBoundHere(instance.id), pending.value, !!stopping.value)) return
  stopping.value = instance.id
  try {
    await api('stop', { instanceId: instance.id })
    await load(false)
    emit('changed')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    stopping.value = ''
  }
}
async function run(instance: PluginInstance, actionId: string): Promise<void> {
  await operate('run', async () => {
    if (!isBoundHere(instance.id)) throw new Error(t('pluginMgr.bindHereFirst'))
    await api('run', { instanceId: instance.id, actionId })
    ElMessage.success(t('pluginMgr.actionDone'))
  })
}
function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}
watch(() => props.visible, (value) => {
  if (value) {
    error.value = ''
    void load()
    refreshTimer = setInterval(() => { if (!pending.value) void load(false) }, 2000)
  } else {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}, { immediate: true })
onMounted(() => {
  unsubscribers = [
    window.api.on('plugins', props.panelId, 'changed', () => { if (props.visible) void load(false); emit('changed') }),
    window.api.on('plugins', props.panelId, 'status', (value) => {
      const status = value as PluginRuntimeStatus
      statuses.value = [...statuses.value.filter(item => item.instanceId !== status.instanceId), status]
    }),
    window.api.on('plugins', props.panelId, 'log', (value) => {
      logs.value = [...logs.value, value as PluginLogEntry].slice(-200)
    })
  ]
})
onUnmounted(() => {
  loadSequence++
  if (refreshTimer) clearInterval(refreshTimer)
  unsubscribers.forEach(unsubscribe => unsubscribe())
})
</script>

<template>
  <el-dialog v-model="visible" :title="t('pluginMgr.title')" width="min(1080px, 94vw)" top="4vh" append-to-body :close-on-click-modal="false">
    <div class="manager-head">
      <p class="hint">{{ t('pluginMgr.hint') }}</p>
      <el-button size="small" :icon="Refresh" :loading="loading" :disabled="!!pending" @click="load()">{{ t('pluginMgr.refresh') }}</el-button>
    </div>
    <el-alert v-if="error" type="error" :title="error" :closable="false" class="error" />
    <el-tabs v-model="tab">
      <el-tab-pane :label="t('pluginMgr.tabInstances')" name="instances">
        <div class="instance-toolbar">
          <el-select :placeholder="t('pluginMgr.pickPluginNew')" :model-value="''" :disabled="!!pending" @change="(id: string) => edit(undefined, plugins.find(plugin => plugin.id === id))">
            <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id" />
          </el-select>
          <el-tag :type="connected ? 'success' : 'info'">{{ connected ? t('pluginMgr.serialConnected') : t('pluginMgr.serialDisconnectedHint') }}</el-tag>
        </div>
        <el-empty v-if="!instances.length" :description="t('pluginMgr.emptyInstances')" :image-size="65" />
        <div class="instance-list">
          <article v-for="instance in instances" :key="instance.id" class="instance-card">
            <div class="instance-heading">
              <div>
                <strong>{{ instance.label }}</strong>
                <div class="hint">{{ pluginFor(instance)?.name || instance.pluginId }} · {{ instance.id }}</div>
              </div>
              <el-tag size="small" :type="statusType(instance.id)">{{ statusLabel(instance.id) }}</el-tag>
              <el-switch :model-value="instance.enabled" :disabled="!!pending || !pluginFor(instance)" :active-text="t('pluginMgr.enable')" @update:model-value="(value: string | number | boolean) => toggleInstance(instance, value === true)" />
            </div>
            <el-alert v-if="!pluginFor(instance)" :title="t('pluginMgr.notInstalledWarning')" type="warning" :closable="false" />
            <el-alert v-if="statusFor(instance.id)?.error" :title="statusFor(instance.id)?.error" type="error" :closable="false" class="runtime-error" />
            <div class="instance-controls">
              <el-button size="small" :disabled="!!pending || !pluginFor(instance)" @click="edit(instance)">{{ t('pluginMgr.editConfig') }}</el-button>
              <el-button v-if="!isBoundHere(instance.id)" size="small" type="primary" plain :disabled="!connected || !instance.enabled || !pluginFor(instance) || !!pending || !!statusFor(instance.id)?.bound" @click="bind(instance)">
                {{ statusFor(instance.id)?.bound ? t('pluginMgr.unbindOtherFirst') : t('pluginMgr.bindHere') }}
              </el-button>
              <el-button v-else size="small" :disabled="!!pending" @click="unbind(instance)">{{ t('pluginMgr.unbind') }}</el-button>
              <el-button v-if="isBoundHere(instance.id)" size="small" :loading="stopping === instance.id" :disabled="!canStopPlugin(isBoundHere(instance.id), pending, !!stopping)" @click="stop(instance)">{{ t('pluginMgr.stop') }}</el-button>
              <el-switch v-if="pluginFor(instance)?.autoRespond" :model-value="instance.autoEnabled" :disabled="!!pending" :active-text="t('pluginMgr.autoListen')" @update:model-value="(value: string | number | boolean) => toggleAuto(instance, value === true)" />
              <el-button size="small" text type="danger" :icon="Delete" :disabled="!!pending" @click="removeInstance(instance)">{{ t('pluginMgr.deleteConfig') }}</el-button>
            </div>
            <div v-if="pluginFor(instance)?.actions.length" class="action-row">
              <span class="hint">{{ t('pluginMgr.manualActions') }}</span>
              <el-button v-for="action in pluginFor(instance)?.actions" :key="action.id" size="small" :title="action.description" :disabled="!connected || !instance.enabled || !isBoundHere(instance.id) || !!pending" @click="run(instance, action.id)">{{ action.label }}</el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>
      <el-tab-pane :label="t('pluginMgr.tabPackages')" name="packages">
        <div class="install-row">
          <el-input v-model="installPath" :placeholder="t('pluginMgr.installPathPlaceholder')" clearable :disabled="!!pending" />
          <el-button :icon="Upload" :loading="pending === 'install'" :disabled="!!pending" @click="install(false)">{{ t('pluginMgr.install') }}</el-button>
          <el-button :disabled="!!pending" @click="install(true)">{{ t('pluginMgr.chooseFolder') }}</el-button>
        </div>
        <el-alert :title="t('pluginMgr.trustWarning')" type="warning" :closable="false" />
        <p class="hint">{{ t('pluginMgr.bundleHint') }}</p>
        <div class="package-list">
          <article v-for="plugin in plugins" :key="plugin.id" class="package-card">
            <div class="package-heading">
              <strong>{{ plugin.name }}</strong><span class="hint">v{{ plugin.version }}</span>
              <el-tag v-if="plugin.builtin" size="small" effect="plain">{{ t('pluginMgr.builtin') }}</el-tag>
              <el-tag v-if="plugin.autoRespond" size="small" effect="plain">{{ t('pluginMgr.autoRespond') }}</el-tag>
            </div>
            <p v-if="plugin.description" class="description">{{ plugin.description }}</p>
            <div class="hint">{{ plugin.id }}</div>
            <div class="capabilities"><el-tag v-for="capability in plugin.capabilities" :key="capability" size="small" type="info" effect="plain">{{ capability }}</el-tag></div>
            <div class="package-actions">
              <el-button size="small" :icon="Plus" :disabled="!!pending" @click="edit(undefined, plugin)">{{ t('pluginMgr.newConfig') }}</el-button>
              <el-button v-if="!plugin.builtin" size="small" text type="danger" :disabled="!!pending" @click="removePlugin(plugin)">{{ t('pluginMgr.uninstall') }}</el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>
      <el-tab-pane :label="t('pluginMgr.tabLogs')" name="logs">
        <p class="hint">{{ t('pluginMgr.logsHint', { count: sessionLogs.length }) }}</p>
        <el-empty v-if="!sessionLogs.length" :description="t('pluginMgr.emptyLogs')" :image-size="65" />
        <div v-else class="log-list">
          <div v-for="(entry, index) in sessionLogs" :key="index" class="log-entry" :class="'level-' + entry.level">
            <time>{{ timeLabel(entry.timestamp) }}</time>
            <span>{{ entry.instanceId }}</span>
            <strong>{{ entry.level }}</strong>
            <span class="log-message">{{ entry.message }}</span>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
    <template #footer><el-button @click="visible = false">{{ t('pluginMgr.close') }}</el-button></template>
  </el-dialog>

  <el-dialog v-model="editVisible" :title="draft.id ? t('pluginEditor.editTitle') : t('pluginEditor.newTitle')" width="min(720px, 92vw)" top="6vh" append-to-body :close-on-click-modal="false">
    <el-alert v-if="editorError" type="error" :title="editorError" :closable="false" class="error" />
    <el-form label-position="top" size="small" @submit.prevent>
      <el-form-item :label="t('pluginEditor.configName')" required><el-input v-model="draft.label" :placeholder="t('pluginMgr.labelPlaceholder')" /></el-form-item>
      <div class="editor-toggles">
        <el-switch v-model="draft.enabled" :active-text="t('pluginEditor.enableConfig')" />
        <el-switch v-if="editingPlugin?.autoRespond" v-model="draft.autoEnabled" :active-text="t('pluginEditor.autoListen')" />
      </div>
    </el-form>
    <el-tabs v-model="editMode" :before-leave="changeEditorMode">
      <el-tab-pane :label="t('pluginEditor.tabForm')" name="form">
        <div class="editor-body">
          <PluginConfigForm :key="editorKey" v-model="draft.config" :schema="editingPlugin?.configSchema" @validity="(value: boolean) => formValid = value" />
        </div>
      </el-tab-pane>
      <el-tab-pane :label="t('pluginEditor.tabJson')" name="json">
        <el-input v-model="editorJson" type="textarea" :rows="15" spellcheck="false" class="json-input" />
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <el-button :disabled="pending === 'save'" @click="editVisible = false">{{ t('pluginEditor.cancel') }}</el-button>
      <el-button type="primary" :loading="pending === 'save'" :disabled="!!pending" @click="saveInstance">{{ t('pluginEditor.saveConfig') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.manager-head, .instance-toolbar, .instance-heading, .instance-controls, .action-row, .install-row, .package-heading, .capabilities, .package-actions, .editor-toggles { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.manager-head { justify-content: space-between; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.error { margin-bottom: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.instance-toolbar { margin-bottom: 14px; }
.instance-toolbar .el-select { width: 240px; }
.instance-list, .package-list { max-height: 55vh; overflow: auto; }
.instance-card, .package-card { border: 1px solid var(--el-border-color); border-radius: 7px; padding: 14px; margin-bottom: 12px; }
.instance-heading > div:first-child { flex: 1; min-width: 200px; }
.instance-controls, .action-row, .capabilities, .package-actions { margin-top: 12px; }
.runtime-error { margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.install-row .el-input { flex: 1; min-width: 250px; }
.description { margin: 8px 0 4px; color: var(--el-text-color-regular); font-size: 13px; }
.editor-toggles { margin-bottom: 12px; }
.editor-body { max-height: 48vh; overflow: auto; padding-right: 8px; }
.json-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
.log-list { max-height: 55vh; overflow: auto; font-family: var(--font-mono); font-size: 12px; }
.log-entry { display: grid; grid-template-columns: 80px 150px 50px minmax(100px, 1fr); gap: 10px; padding: 7px 2px; border-bottom: 1px solid var(--el-border-color-lighter); }
.log-entry > span, .log-message { overflow-wrap: anywhere; white-space: pre-wrap; }
.level-error { color: var(--el-color-danger); }
.level-warn { color: var(--el-color-warning); }
@media (max-width: 700px) { .log-entry { grid-template-columns: 70px 1fr; } .instance-heading > div:first-child { min-width: 150px; } }
</style>