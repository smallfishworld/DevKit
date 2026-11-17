<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import type {
  PluginDescriptor, PluginInstance, PluginLogEntry, PluginRuntimeStatus, PluginSourceInfo, PluginSourceItem
} from '../../../shared/plugins'
import PluginConfigForm from './PluginConfigForm.vue'
import { defaultPluginConfig, parseConfigJson, canStopPlugin } from './plugin-config-form'

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
const sourceInfo = ref<PluginSourceInfo>({ items: [] })
const sourceUrlInput = ref('')
const sourceBusy = ref('')
const sourceError = ref('')
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
const sourceUpdates = computed(() => sourceInfo.value.items.filter(item => item.installedVersion && item.updateAvailable).length)
const stateLabels: Record<string, string> = {
  idle: '待运行', starting: '启动中', ready: '已就绪', running: '运行中', stopped: '已停止', error: '异常'
}
let refreshTimer: ReturnType<typeof setInterval> | undefined
let unsubscribers: Array<() => void> = []
let loadSequence = 0

type Reply<T> = T & { ok: boolean; error?: string }
async function api<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.api.invoke('plugins', action, props.panelId, payload) as Reply<T>
  if (!result.ok) throw new Error(result.error || '插件操作失败')
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
  if (!status) return '未绑定'
  if (status.bound && status.panelId !== props.panelId) return '已绑定其他串口'
  return stateLabels[status.state] || status.state
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
    error.value = '插件未安装，现有配置已保留；重新安装后可以继续编辑。'
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
      editorError.value = '请先修复表单中标出的 JSON 语法错误'
      return false
    }
    editorJson.value = JSON.stringify(draft.config, null, 2)
    editorError.value = ''
  } else if (previous === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (parsed.error || !parsed.config) {
      editorError.value = parsed.error || '配置无效'
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
  if (!draft.label.trim()) { editorError.value = '请填写配置名称'; return }
  let config = draft.config
  if (editMode.value === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (!parsed.config) { editorError.value = parsed.error || '配置无效'; return }
    config = parsed.config
  } else if (!formValid.value) {
    editorError.value = '请先修复表单中标出的 JSON 语法错误'
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
    ElMessage.success('插件配置已保存')
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
    await ElMessageBox.confirm(`删除“${instance.label}”后，引用该配置的宏将无法运行。`, '删除插件配置', { type: 'warning' })
  } catch { return }
  await operate('delete', () => api('instance:delete', { instanceId: instance.id }))
}
async function removePlugin(plugin: PluginDescriptor): Promise<void> {
  try {
    await ElMessageBox.confirm(`卸载“${plugin.name}”？配置和宏引用将保留，重新安装后可以继续使用。`, '卸载插件', { type: 'warning' })
  } catch { return }
  await operate('remove', () => api('remove', { pluginId: plugin.id }))
}
async function install(browse: boolean): Promise<void> {
  const path = installPath.value.trim()
  if (!browse && !path) { error.value = '请输入插件目录或 JSON 插件包路径'; return }
  try {
    await ElMessageBox.confirm(
      '外部插件是可信本地代码，不是安全沙箱：插件可能访问本机文件、网络和环境变量。manifest 的串口权限声明不限制 Node.js 权限。仅安装已核实来源的插件。是否继续？',
      '确认执行外部插件代码', { type: 'warning', confirmButtonText: '信任来源并安装', cancelButtonText: '取消' }
    )
  } catch { return }
  await operate('install', async () => {
    await api('install', browse ? undefined : { path })
    installPath.value = ''
    ElMessage.success('插件已安装，可以创建配置实例')
  })
}
async function loadSource(auto: boolean): Promise<void> {
  try {
    const reply = await api<{ source: PluginSourceInfo }>('source:get')
    sourceInfo.value = reply.source
    sourceUrlInput.value = reply.source.url || 'smallfishworld/DevKit-Plugins'
    sourceError.value = ''
    if (auto && reply.source.url && (!reply.source.checkedAt || Date.now() - reply.source.checkedAt > 5 * 60_000)) {
      await refreshSource(true)
    }
  } catch (failure) {
    sourceError.value = failure instanceof Error ? failure.message : String(failure)
  }
}
async function refreshSource(silent = false): Promise<void> {
  if (sourceBusy.value || pending.value) return
  sourceBusy.value = 'refresh'
  if (!silent) sourceError.value = ''
  try {
    const reply = await api<{ source: PluginSourceInfo }>('source:refresh')
    sourceInfo.value = reply.source
    sourceUrlInput.value = reply.source.url || sourceUrlInput.value
  } catch (failure) {
    sourceError.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    sourceBusy.value = ''
  }
}
async function saveSource(): Promise<void> {
  if (sourceBusy.value || pending.value) return
  sourceBusy.value = 'save'
  sourceError.value = ''
  try {
    const reply = await api<{ source: PluginSourceInfo }>('source:save', { url: sourceUrlInput.value.trim() })
    sourceInfo.value = reply.source
    sourceUrlInput.value = reply.source.url || ''
    ElMessage.success(`插件源已绑定，目录中有 ${reply.source.items.length} 个插件`)
  } catch (failure) {
    sourceError.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    sourceBusy.value = ''
  }
}
async function clearSource(): Promise<void> {
  if (sourceBusy.value || pending.value) return
  try {
    await ElMessageBox.confirm('解绑后已安装的插件和配置都会保留，仅停止检查更新。', '解绑插件源', { type: 'warning' })
  } catch { return }
  sourceBusy.value = 'clear'
  sourceError.value = ''
  try {
    const reply = await api<{ source: PluginSourceInfo }>('source:clear')
    sourceInfo.value = reply.source
    sourceUrlInput.value = ''
    ElMessage.success('已解绑插件源')
  } catch (failure) {
    sourceError.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    sourceBusy.value = ''
  }
}
async function installSource(item: PluginSourceItem): Promise<void> {
  const updating = !!item.installedVersion
  const action = updating ? '更新' : '安装'
  try {
    await ElMessageBox.confirm(
      `${action}“${item.name}” ${item.version}（${item.id}）？\n\n将从插件源下载插件包，并按 SHA-256 校验。外部插件仍是可信代码，可访问本机文件、网络和环境变量；请确认插件源可信。`,
      `确认${action}外部插件`, { type: 'warning', confirmButtonText: `信任来源并${action}`, cancelButtonText: '取消' }
    )
  } catch { return }
  await operate('source:' + item.id, async () => {
    const reply = await api<{ source: PluginSourceInfo }>('source:install', { pluginId: item.id, version: item.version })
    sourceInfo.value = reply.source
    ElMessage.success(`插件已${action}`)
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
    if (!isBoundHere(instance.id)) throw new Error('请先将此配置绑定到当前串口')
    await api('run', { instanceId: instance.id, actionId })
    ElMessage.success('插件动作执行完成')
  })
}
function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}
watch(() => props.visible, (value) => {
  if (value) {
    error.value = ''
    sourceError.value = ''
    void load()
    void loadSource(true)
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
  <el-dialog v-model="visible" title="串口插件" width="min(1080px, 94vw)" top="4vh" append-to-body :close-on-click-modal="false">
    <div class="manager-head">
      <p class="hint">安装插件、创建配置，再绑定到当前串口。每个配置可独立启停。</p>
      <el-button size="small" :icon="Refresh" :loading="loading" :disabled="!!pending" @click="load()">刷新</el-button>
    </div>
    <el-alert v-if="error" type="error" :title="error" :closable="false" class="error" />
    <el-tabs v-model="tab">
      <el-tab-pane label="配置与当前串口" name="instances">
        <div class="instance-toolbar">
          <el-select placeholder="选择插件，新建配置" :model-value="''" :disabled="!!pending" @change="(id: string) => edit(undefined, plugins.find(plugin => plugin.id === id))">
            <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id" />
          </el-select>
          <el-tag :type="connected ? 'success' : 'info'">{{ connected ? '当前串口已连接' : '连接串口后可绑定和运行' }}</el-tag>
        </div>
        <el-empty v-if="!instances.length" description="还没有配置，选择一个插件来创建" :image-size="65" />
        <div class="instance-list">
          <article v-for="instance in instances" :key="instance.id" class="instance-card">
            <div class="instance-heading">
              <div>
                <strong>{{ instance.label }}</strong>
                <div class="hint">{{ pluginFor(instance)?.name || instance.pluginId }} · {{ instance.id }}</div>
              </div>
              <el-tag size="small" :type="statusType(instance.id)">{{ statusLabel(instance.id) }}</el-tag>
              <el-switch :model-value="instance.enabled" :disabled="!!pending || !pluginFor(instance)" active-text="启用" @update:model-value="(value: string | number | boolean) => toggleInstance(instance, value === true)" />
            </div>
            <el-alert v-if="!pluginFor(instance)" title="插件未安装，配置已保留" type="warning" :closable="false" />
            <el-alert v-if="statusFor(instance.id)?.error" :title="statusFor(instance.id)?.error" type="error" :closable="false" class="runtime-error" />
            <div class="instance-controls">
              <el-button size="small" :disabled="!!pending || !pluginFor(instance)" @click="edit(instance)">编辑配置</el-button>
              <el-button v-if="!isBoundHere(instance.id)" size="small" type="primary" plain :disabled="!connected || !instance.enabled || !pluginFor(instance) || !!pending || !!statusFor(instance.id)?.bound" @click="bind(instance)">
                {{ statusFor(instance.id)?.bound ? '请先解除其他绑定' : '绑定到本串口' }}
              </el-button>
              <el-button v-else size="small" :disabled="!!pending" @click="unbind(instance)">解除绑定</el-button>
              <el-button v-if="isBoundHere(instance.id)" size="small" :loading="stopping === instance.id" :disabled="!canStopPlugin(isBoundHere(instance.id), pending, !!stopping)" @click="stop(instance)">停止</el-button>
              <el-switch v-if="pluginFor(instance)?.autoRespond" :model-value="instance.autoEnabled" :disabled="!!pending" active-text="自动监听" @update:model-value="(value: string | number | boolean) => toggleAuto(instance, value === true)" />
              <el-button size="small" text type="danger" :icon="Delete" :disabled="!!pending" @click="removeInstance(instance)">删除配置</el-button>
            </div>
            <div v-if="pluginFor(instance)?.actions.length" class="action-row">
              <span class="hint">手动动作</span>
              <el-button v-for="action in pluginFor(instance)?.actions" :key="action.id" size="small" :title="action.description" :disabled="!connected || !instance.enabled || !isBoundHere(instance.id) || !!pending" @click="run(instance, action.id)">{{ action.label }}</el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>
      <el-tab-pane label="已安装插件" name="packages">
        <div class="install-row">
          <el-input v-model="installPath" placeholder="插件目录或 JSON 插件包路径" clearable :disabled="!!pending" />
          <el-button :icon="Upload" :loading="pending === 'install'" :disabled="!!pending" @click="install(false)">安装</el-button>
          <el-button :disabled="!!pending" @click="install(true)">选择目录</el-button>
        </div>
        <el-alert title="仅安装可信插件：外部 JavaScript 可访问本机文件、网络和环境变量；utilityProcess 不是安全沙箱，串口能力声明不限制 Node.js 权限。" type="warning" :closable="false" />
        <p class="hint">插件包格式为 JSON bundle；安装后从“配置与当前串口”创建实例。</p>
        <div class="package-list">
          <article v-for="plugin in plugins" :key="plugin.id" class="package-card">
            <div class="package-heading">
              <strong>{{ plugin.name }}</strong><span class="hint">v{{ plugin.version }}</span>
              <el-tag v-if="plugin.builtin" size="small" effect="plain">内置</el-tag>
              <el-tag v-if="plugin.autoRespond" size="small" effect="plain">自动应答</el-tag>
            </div>
            <p v-if="plugin.description" class="description">{{ plugin.description }}</p>
            <div class="hint">{{ plugin.id }}</div>
            <div class="capabilities"><el-tag v-for="capability in plugin.capabilities" :key="capability" size="small" type="info" effect="plain">{{ capability }}</el-tag></div>
            <div class="package-actions">
              <el-button size="small" :icon="Plus" :disabled="!!pending" @click="edit(undefined, plugin)">新建配置</el-button>
              <el-button v-if="!plugin.builtin" size="small" text type="danger" :disabled="!!pending" @click="removePlugin(plugin)">卸载</el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>
      <el-tab-pane name="source">
        <template #label>
          <span>插件源</span>
          <el-badge v-if="sourceUpdates" :value="sourceUpdates" class="tab-badge" />
        </template>
        <div class="install-row">
          <el-input v-model="sourceUrlInput" placeholder="GitHub 仓库 owner/repo，或 catalog.json 的 HTTPS 地址" clearable :disabled="!!sourceBusy || !!pending" @keyup.enter="saveSource" />
          <el-button :loading="sourceBusy === 'save'" :disabled="!!sourceBusy || !!pending" @click="saveSource">保存并检查</el-button>
          <el-button :icon="Refresh" :loading="sourceBusy === 'refresh'" :disabled="!sourceInfo.url || !!sourceBusy || !!pending" @click="refreshSource()">检查更新</el-button>
          <el-button v-if="sourceInfo.url" text :disabled="!!sourceBusy || !!pending" @click="clearSource">解绑</el-button>
        </div>
        <el-alert title="插件源提供版本列表与 SHA-256 校验；外部插件仍是可信代码，安装或更新前请确认仓库来源。" type="warning" :closable="false" />
        <p class="hint">仓库根目录需提供 catalog.json；安装包优先取同版本 Release 资产（标签 &lt;slug&gt;/v&lt;version&gt;），否则按 packagePath 下载，并读取同目录 SHA256SUMS。GitHub 仓库链接会自动转换为 raw 地址。</p>
        <p v-if="sourceInfo.checkedAt" class="hint">上次检查：{{ new Date(sourceInfo.checkedAt).toLocaleString() }}</p>
        <el-alert v-if="sourceError" type="error" :title="sourceError" :closable="false" class="error" />
        <el-empty v-if="!sourceInfo.items.length" description="尚未获取插件列表" :image-size="65" />
        <div v-else class="source-list">
          <article v-for="item in sourceInfo.items" :key="item.id" class="package-card">
            <div class="package-heading">
              <strong>{{ item.name }}</strong><span class="hint">v{{ item.version }}</span>
              <el-tag v-if="item.installedVersion" size="small" effect="plain" :type="item.updateAvailable ? 'warning' : 'success'">
                {{ item.updateAvailable ? `可更新（已安装 ${item.installedVersion}）` : '已是最新' }}
              </el-tag>
            </div>
            <p v-if="item.description" class="description">{{ item.description }}</p>
            <div class="hint">{{ item.id }}</div>
            <div class="package-actions">
              <el-button size="small" type="primary" :loading="pending === 'source:' + item.id" :disabled="!!pending || !!sourceBusy || (!!item.installedVersion && !item.updateAvailable)" @click="installSource(item)">
                {{ item.installedVersion ? (item.updateAvailable ? '更新' : '已是最新') : '安装' }}
              </el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>
      <el-tab-pane label="运行诊断" name="logs">
        <p class="hint">当前串口最近 {{ sessionLogs.length }} 条插件日志。停止或断开后可在配置列表重新绑定。</p>
        <el-empty v-if="!sessionLogs.length" description="暂无插件日志" :image-size="65" />
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
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>

  <el-dialog v-model="editVisible" :title="draft.id ? '编辑插件配置' : '新建插件配置'" width="min(720px, 92vw)" top="6vh" append-to-body :close-on-click-modal="false">
    <el-alert v-if="editorError" type="error" :title="editorError" :closable="false" class="error" />
    <el-form label-position="top" size="small" @submit.prevent>
      <el-form-item label="配置名称" required><el-input v-model="draft.label" placeholder="如：COM3 调试设备" /></el-form-item>
      <div class="editor-toggles">
        <el-switch v-model="draft.enabled" active-text="启用配置" />
        <el-switch v-if="editingPlugin?.autoRespond" v-model="draft.autoEnabled" active-text="绑定后自动监听" />
      </div>
    </el-form>
    <el-tabs v-model="editMode" :before-leave="changeEditorMode">
      <el-tab-pane label="配置表单" name="form">
        <div class="editor-body">
          <PluginConfigForm :key="editorKey" v-model="draft.config" :schema="editingPlugin?.configSchema" @validity="(value: boolean) => formValid = value" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="完整 JSON" name="json">
        <el-input v-model="editorJson" type="textarea" :rows="15" spellcheck="false" class="json-input" />
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <el-button :disabled="pending === 'save'" @click="editVisible = false">取消</el-button>
      <el-button type="primary" :loading="pending === 'save'" :disabled="!!pending" @click="saveInstance">保存配置</el-button>
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
.instance-list, .package-list, .source-list { max-height: 55vh; overflow: auto; }
.tab-badge { margin-left: 6px; }
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