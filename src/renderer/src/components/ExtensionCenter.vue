<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useTabStore } from '@renderer/stores/tabs'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import { TOOLS } from '@renderer/tools/registry'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import DevicePluginEditor from './DevicePluginEditor.vue'
import ExtensionSources from './ExtensionSources.vue'

const tabs = useTabStore()
const plugins = useDevicePlugins()
const kind = ref<'all' | 'builtin' | 'plugin'>('all')
const selected = ref('builtin:serial')
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
const detail = computed(() => visibleTools.value.find((item) => item.key === selected.value) ?? visibleTools.value[0])
const instances = computed(() => plugins.instances.filter((instance) => instance.pluginId === detail.value?.plugin?.id))

function boundTab(instance: PluginInstance): string | undefined {
  const status = plugins.statuses.find((row) => row.bound && row.instanceId === instance.id)
  return status && tabs.tabs.find((tab) => tab.id === status.panelId)?.id
}

function edit(plugin: PluginDescriptor, instance?: PluginInstance): void {
  editingPlugin.value = plugin
  editing.value = instance
  editorOpen.value = true
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
      <div><h1>扩展中心</h1><p>管理设备插件及内置工具模块</p></div>
      <div class="converter-row">
        <el-button size="small" @click="sourcesOpen = true">扩展源管理</el-button>
        <el-button size="small" type="primary" :loading="busy" @click="install">从文件安装…</el-button>
      </div>
    </header>
    <el-alert v-if="error || plugins.error" :title="error || plugins.error" type="error" :closable="false" role="alert" />
    <div class="extension-layout">
      <aside class="panel-section">
        <el-radio-group v-model="kind" size="small" aria-label="扩展类型">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="plugin">设备插件</el-radio-button>
          <el-radio-button value="builtin">内置模块</el-radio-button>
        </el-radio-group>
        <div class="extension-list">
          <button v-for="item in visibleTools" :key="item.key" type="button" :aria-pressed="item.key === detail?.key" @click="selected = item.key">
            <el-icon><component :is="item.icon" /></el-icon>
            <span><strong>{{ item.name }}</strong><small>{{ item.plugin ? '设备插件 · ' + item.plugin.version : '内置模块' }}</small></span>
          </button>
        </div>
      </aside>
      <article class="panel-section">
        <template v-if="detail">
          <h2><el-icon><component :is="detail.icon" /></el-icon>{{ detail.name }}</h2>
          <p>{{ detail.tool?.description || detail.plugin?.description }}</p>
          <div v-if="detail.tool" class="module-entry">
            <span>随 DevKit 提供</span>
            <el-button type="primary" size="small" @click="tabs.openTool(detail.tool)">打开工具标签</el-button>
          </div>
          <template v-if="detail.plugin">
            <div class="module-entry">
              <strong>配置实例</strong>
              <el-button size="small" @click="edit(detail.plugin)">新建配置</el-button>
            </div>
            <div v-for="instance in instances" :key="instance.id" class="module-entry instance-row">
              <div><strong>{{ instance.label }}</strong><p>{{ boundTab(instance) ? '已绑定' : instance.enabled ? '未绑定' : '已停用' }}</p></div>
              <div>
                <el-button size="small" @click="edit(detail.plugin, instance)">编辑配置</el-button>
                <el-button v-if="boundTab(instance)" size="small" @click="tabs.activate(boundTab(instance)!)">前往会话</el-button>
              </div>
            </div>
            <h3>串口能力</h3>
            <div class="converter-row"><el-tag v-for="capability in detail.plugin.capabilities" :key="capability" size="small">{{ capability }}</el-tag></div>
            <p>在已连接的串口会话中绑定配置实例后，插件才会运行。</p>
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
.extension-layout { display:grid; grid-template-columns:minmax(220px,1fr) minmax(0,2.6fr); gap:12px; align-items:start; }
.extension-list { display:grid; gap:3px; margin-block-start:10px; }
.extension-list button { display:flex; align-items:center; gap:8px; padding:7px; border:1px solid transparent; border-radius:7px; background:transparent; text-align:start; color:inherit; cursor:pointer; }
.extension-list button:hover { background:var(--el-fill-color-light); }
.extension-list button[aria-pressed="true"] { background:var(--el-color-primary-light-9); color:var(--el-color-primary); }
.extension-list button > span { display:grid; gap:3px; }
.extension-list small, article p { color:var(--el-text-color-secondary); }
.extension-center h2 { display:flex; align-items:center; gap:8px; margin:0; font-size:17px; }
.module-entry { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:10px; border:1px solid var(--el-border-color-lighter); border-radius:8px; }
@container (max-width:560px) {
  .extension-layout { grid-template-columns:minmax(0,1fr); }
}
.instance-row { margin-block:8px; }
.instance-row p { margin:3px 0 0; }
</style>
