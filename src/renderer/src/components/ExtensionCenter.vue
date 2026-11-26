<script setup lang="ts">
import { computed, ref } from 'vue'
import { Coin, Download, TopRight } from '@element-plus/icons-vue'
import { usePanelMessageBox } from '@renderer/composables/panelOverlays'
import { useTabStore } from '@renderer/stores/tabs'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import { TOOLS } from '@renderer/tools/registry'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import DevicePluginEditor from './DevicePluginEditor.vue'
import ExtensionSources from './ExtensionSources.vue'

const ElMessageBox = usePanelMessageBox()

const tabs = useTabStore()
const plugins = useDevicePlugins()
const kind = ref<'all' | 'builtin' | 'plugin'>('all')
const selected = ref('')
const sourcesOpen = ref(false)
const busy = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editing = ref<PluginInstance>()
const editingPlugin = ref<PluginDescriptor>()
const builtins = TOOLS.filter((tool) => tool.ready && !tool.devOnly)
const visibleTools = computed(() => [
  ...(kind.value === 'builtin' ? [] : plugins.plugins.map((plugin) => ({
    key: 'plugin:' + plugin.id, name: plugin.name, icon: 'Box', plugin, tool: undefined
  }))),
  ...(kind.value === 'plugin' ? [] : builtins.map((tool) => ({
    key: 'builtin:' + tool.id, name: tool.name, icon: tool.icon, plugin: undefined, tool
  })))
])
const total = computed(() => plugins.plugins.length + builtins.length)
const instanceCount = (pluginId: string): number => plugins.instances.filter((item) => item.pluginId === pluginId).length
const detail = computed(() => visibleTools.value.find((item) => item.key === selected.value) ?? visibleTools.value[0])
const instances = computed(() => plugins.instances.filter((instance) => instance.pluginId === detail.value?.plugin?.id))

function binding(instance: PluginInstance) {
  const status = plugins.statuses.find((row) => row.bound && row.instanceId === instance.id)
  return status && tabs.sessionById(status.panelId)
}

function instanceState(instance: PluginInstance): string {
  const status = plugins.statuses.find((row) => row.instanceId === instance.id)
  if (status?.state === 'error') return '运行异常'
  if (!status?.bound) return instance.enabled ? '未绑定' : '已停用'
  const stage = status.state === 'running' ? '执行中' : status.state === 'starting' ? '启动中' : instance.autoEnabled ? '监听中' : '待执行'
  return '已绑定 ' + (binding(instance)?.title ?? '串口会话') + ' · ' + stage
}

function edit(plugin: PluginDescriptor, instance?: PluginInstance): void {
  editingPlugin.value = plugin
  editing.value = instance
  editorOpen.value = true
}

async function removeInstance(plugin: PluginDescriptor, instance: PluginInstance): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除配置「${instance.label}」？正在运行的实例会先停止；操作不可撤销。`, '删除插件配置', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch { return }
  busy.value = true
  error.value = ''
  try {
    await pluginRequest('instance:delete', { instanceId: instance.id })
    await plugins.refresh()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}

async function uninstallPlugin(plugin: PluginDescriptor): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `卸载插件「${plugin.name}」？其 ${instanceCount(plugin.id)} 份配置实例与安装文件将一并删除，操作不可撤销。`,
      '卸载插件', { type: 'warning', confirmButtonText: '卸载', cancelButtonText: '取消' }
    )
  } catch { return }
  busy.value = true
  error.value = ''
  try {
    await pluginRequest('remove', { pluginId: plugin.id })
    await plugins.refresh()
    if (selected.value === 'plugin:' + plugin.id) selected.value = ''
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}

async function install(): Promise<void> {
  try {
    await ElMessageBox.confirm('外部插件在独立进程中运行，并具有本机文件和网络访问能力。请只选择你信任的 JSON 插件包。',
      '从文件安装', { type: 'warning', confirmButtonText: '选择文件', cancelButtonText: '取消' })
  } catch { return }
  busy.value = true
  error.value = ''
  try {
    const { plugin } = await pluginRequest<{ plugin: PluginDescriptor }>('install:file')
    await plugins.refresh()
    kind.value = 'all'
    selected.value = 'plugin:' + plugin.id
  } catch (e) { if ((e as Error).message !== '已取消安装') error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <section class="extension-center converter-page panel">
    <header class="converter-head">
      <div><h1>扩展中心</h1><p>统一管理内置模块与设备插件，安装后可按会话绑定。</p></div>
      <div class="converter-row">
        <el-button size="small" :icon="Coin" @click="sourcesOpen = true">扩展源管理</el-button>
        <el-button size="small" type="primary" :icon="Download" :loading="busy" @click="install">从文件安装…</el-button>
      </div>
    </header>
    <el-alert v-if="error || plugins.error" :title="error || plugins.error" type="error" :closable="false" role="alert" />
    <div class="extension-layout">
      <aside class="panel-section">
        <el-radio-group v-model="kind" size="small" aria-label="扩展类型">
          <el-radio-button value="all">全部 ({{ total }})</el-radio-button>
          <el-radio-button value="plugin">设备插件</el-radio-button>
          <el-radio-button value="builtin">内置模块</el-radio-button>
        </el-radio-group>
        <div class="extension-list">
          <button v-for="item in visibleTools" :key="item.key" type="button" :aria-pressed="item.key === detail?.key" @click="selected = item.key">
            <el-icon class="extension-icon"><component :is="item.icon" /></el-icon>
            <span><strong>{{ item.name }}</strong><small>{{ item.plugin ? '设备插件 · ' + instanceCount(item.plugin.id) + ' 份配置' : '官方内置 · 随 DevKit 更新' }}</small></span>
          </button>
        </div>
      </aside>
      <article class="panel-section">
        <template v-if="detail">
          <div class="extension-summary">
            <el-icon class="extension-icon"><component :is="detail.icon" /></el-icon>
            <div>
              <h2>{{ detail.name }}</h2>
              <div class="extension-facts">
                <el-tag v-if="detail.plugin" size="small" type="info">v{{ detail.plugin.version }}</el-tag>
                <el-tag size="small" type="info">来源 · {{ detail.plugin?.installSource?.name ?? (detail.tool || detail.plugin?.builtin ? '官方内置' : '未记录') }}</el-tag>
              </div>
            </div>
          </div>
          <p>{{ detail.tool?.description || detail.plugin?.description }}</p>
          <div v-if="detail.tool" class="module-entry">
            <div><strong>官方内置工作台模块</strong><p>随 DevKit 提供，可直接打开工具标签。</p></div>
            <el-button type="primary" size="small" :icon="TopRight" @click="tabs.openTool(detail.tool)">打开工具标签</el-button>
          </div>
          <template v-if="detail.plugin">
            <div class="module-entry">
              <strong>配置实例</strong>
              <el-button size="small" @click="edit(detail.plugin)">新建配置</el-button>
            </div>
            <div v-for="instance in instances" :key="instance.id" class="module-entry instance-row">
              <div><strong>{{ instance.label }}</strong><p>{{ instanceState(instance) }}</p></div>
              <div>
                <el-button size="small" @click="edit(detail.plugin, instance)">编辑配置</el-button>
                <el-button v-if="binding(instance)" size="small" :icon="TopRight" @click="tabs.activate(binding(instance)!.id)">前往会话</el-button>
                <el-button size="small" type="danger" plain @click="removeInstance(detail.plugin, instance)">删除</el-button>
              </div>
            </div>
            <h3>能力边界与生命周期</h3>
            <div class="converter-row"><el-tag v-for="capability in detail.plugin.capabilities" :key="capability" size="small">{{ capability }}</el-tag></div>
            <p>在已连接的串口会话中绑定配置实例后，插件才会运行。</p>
            <div class="converter-row">
              <el-button v-if="!detail.plugin.builtin" size="small" type="danger" plain :loading="busy" @click="uninstallPlugin(detail.plugin)">卸载插件</el-button>
            </div>
            <details v-if="!detail.plugin.builtin" class="extension-install-note">
              <summary>进程隔离与安装说明</summary>
              <p>插件在独立进程中运行，仍具有本机文件和网络访问能力。请只安装信任的代码。</p>
            </details>
          </template>
        </template>
        <el-empty v-else description="暂无已安装的设备插件" :image-size="64" />
      </article>
    </div>
    <ExtensionSources v-model="sourcesOpen" />
    <DevicePluginEditor v-if="editingPlugin" v-model="editorOpen" :plugin="editingPlugin" :instance="editing" />
  </section>
</template>

<style scoped>
.extension-layout { display:grid; grid-template-columns:minmax(220px, 1fr) minmax(0, 2.25fr); gap:24px; align-items:start; }
.extension-layout > .panel-section { padding:0; border:0; border-radius:0; background:transparent; }
.extension-layout > article.panel-section { padding-inline-start:24px; border-inline-start:1px solid var(--el-border-color); }
.extension-summary { display:flex; align-items:center; gap:12px; }
.extension-facts { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.extension-icon { width:36px; height:36px; flex:none; border-radius:8px; color:var(--el-color-primary); background:var(--el-color-primary-light-9); }
.extension-install-note { margin-top:16px; font-size:12px; }
.extension-install-note summary { cursor:pointer; }
.extension-list { display:grid; gap:4px; margin-block-start:12px; }
.extension-list button { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-bg-color-page); text-align:start; color:inherit; cursor:pointer; }
.extension-list button:hover { background:var(--el-fill-color-light); }
.extension-list button[aria-pressed="true"] { background:var(--el-color-primary-light-9); color:var(--el-color-primary); }
.extension-list button > span { display:grid; gap:4px; }
.extension-list strong { font-size:13px; }
.extension-list small, article p { font-size:12px; color:var(--el-text-color-secondary); }
.extension-center h2 { display:flex; align-items:center; gap:8px; margin:0; font-size:16px; font-weight:600; }
.module-entry { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:12px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-bg-color-page); }
@container (max-width:560px) {
  .extension-layout { grid-template-columns:minmax(0,1fr); }
  .extension-layout > article.panel-section { padding-inline-start:0; border-inline-start:0; }
}
.instance-row { margin-block:8px; }
.instance-row p { margin:3px 0 0; }
</style>
