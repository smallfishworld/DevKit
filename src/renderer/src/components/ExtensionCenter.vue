<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coin, Download, TopRight } from '@element-plus/icons-vue'
import { usePanelMessageBox } from '@renderer/composables/panelOverlays'
import { useTabStore } from '@renderer/stores/tabs'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import { TOOLS } from '@renderer/tools/registry'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import DevicePluginEditor from './DevicePluginEditor.vue'
import ExtensionSources from './ExtensionSources.vue'

const ElMessageBox = usePanelMessageBox()
const { t } = useI18n()

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
  if (status?.state === 'error') return t('extCenter.stateError')
  if (!status?.bound) return instance.enabled ? t('extCenter.stateUnbound') : t('extCenter.stateDisabled')
  const stage = status.state === 'running' ? t('extCenter.stageRunning') : status.state === 'starting' ? t('extCenter.stageStarting') : instance.autoEnabled ? t('extCenter.stageListening') : t('extCenter.stageIdle')
  return t('extCenter.boundState', { title: binding(instance)?.title ?? t('extCenter.serialSession'), stage })
}

function edit(plugin: PluginDescriptor, instance?: PluginInstance): void {
  editingPlugin.value = plugin
  editing.value = instance
  editorOpen.value = true
}

async function removeInstance(plugin: PluginDescriptor, instance: PluginInstance): Promise<void> {
  try {
    await ElMessageBox.confirm(t('extCenter.deleteInstanceConfirm', { label: instance.label }), t('extCenter.deleteInstanceTitle'), {
      type: 'warning', confirmButtonText: t('extCenter.delete'), cancelButtonText: t('extCenter.cancel')
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
      t('extCenter.uninstallConfirm', { name: plugin.name, count: instanceCount(plugin.id) }),
      t('extCenter.uninstallTitle'), { type: 'warning', confirmButtonText: t('extCenter.uninstallBtn'), cancelButtonText: t('extCenter.cancel') }
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
    await ElMessageBox.confirm(t('extCenter.installFileConfirm'),
      t('extCenter.installFileTitle'), { type: 'warning', confirmButtonText: t('extCenter.chooseFile'), cancelButtonText: t('extCenter.cancel') })
  } catch { return }
  busy.value = true
  error.value = ''
  try {
    const { plugin } = await pluginRequest<{ plugin: PluginDescriptor }>('install:file')
    await plugins.refresh()
    kind.value = 'all'
    selected.value = 'plugin:' + plugin.id
  } catch (e) { if ((e as Error).name !== 'CANCELLED') error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <section class="extension-center converter-page panel">
    <header class="converter-head">
      <div><h1>{{ t('extCenter.title') }}</h1><p>{{ t('extCenter.subtitle') }}</p></div>
      <div class="converter-row">
        <el-button size="small" :icon="Coin" @click="sourcesOpen = true">{{ t('extCenter.manageSources') }}</el-button>
        <el-button size="small" type="primary" :icon="Download" :loading="busy" @click="install">{{ t('extCenter.installFromFile') }}</el-button>
      </div>
    </header>
    <el-alert v-if="error || plugins.error" :title="error || plugins.error" type="error" :closable="false" role="alert" />
    <div class="extension-layout">
      <aside class="panel-section">
        <el-radio-group v-model="kind" size="small" :aria-label="t('extCenter.typeAria')">
          <el-radio-button value="all">{{ t('extCenter.allCount', { count: total }) }}</el-radio-button>
          <el-radio-button value="plugin">{{ t('extCenter.devicePlugins') }}</el-radio-button>
          <el-radio-button value="builtin">{{ t('extCenter.builtinModules') }}</el-radio-button>
        </el-radio-group>
        <div class="extension-list">
          <button v-for="item in visibleTools" :key="item.key" type="button" :aria-pressed="item.key === detail?.key" @click="selected = item.key">
            <el-icon class="extension-icon"><component :is="item.icon" /></el-icon>
            <span><strong>{{ item.name }}</strong><small>{{ item.plugin ? t('extCenter.pluginSummary', { count: instanceCount(item.plugin.id) }) : t('extCenter.builtinSummary') }}</small></span>
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
                <el-tag size="small" type="info">{{ t('extCenter.sourceLabel', { name: detail.plugin?.installSource?.name ?? (detail.tool || detail.plugin?.builtin ? t('extCenter.officialBuiltin') : t('extCenter.unrecorded')) }) }}</el-tag>
              </div>
            </div>
          </div>
          <p>{{ detail.tool?.description || detail.plugin?.description }}</p>
          <div v-if="detail.tool" class="module-entry">
            <div><strong>{{ t('extCenter.builtinModuleTitle') }}</strong><p>{{ t('extCenter.builtinModuleDesc') }}</p></div>
            <el-button type="primary" size="small" :icon="TopRight" @click="tabs.openTool(detail.tool)">{{ t('extCenter.openToolTab') }}</el-button>
          </div>
          <template v-if="detail.plugin">
            <div class="module-entry">
              <strong>{{ t('extCenter.instancesTitle') }}</strong>
              <el-button size="small" @click="edit(detail.plugin)">{{ t('extCenter.newInstance') }}</el-button>
            </div>
            <div v-for="instance in instances" :key="instance.id" class="module-entry instance-row">
              <div><strong>{{ instance.label }}</strong><p>{{ instanceState(instance) }}</p></div>
              <div>
                <el-button size="small" @click="edit(detail.plugin, instance)">{{ t('extCenter.editInstance') }}</el-button>
                <el-button v-if="binding(instance)" size="small" :icon="TopRight" @click="tabs.activate(binding(instance)!.id)">{{ t('extCenter.goToSession') }}</el-button>
                <el-button size="small" type="danger" plain @click="removeInstance(detail.plugin, instance)">{{ t('extCenter.delete') }}</el-button>
              </div>
            </div>
            <h3>{{ t('extCenter.capabilitiesTitle') }}</h3>
            <div class="converter-row"><el-tag v-for="capability in detail.plugin.capabilities" :key="capability" size="small">{{ capability }}</el-tag></div>
            <p>{{ t('extCenter.bindHint') }}</p>
            <div class="converter-row">
              <el-button v-if="!detail.plugin.builtin" size="small" type="danger" plain :loading="busy" @click="uninstallPlugin(detail.plugin)">{{ t('extCenter.uninstallPlugin') }}</el-button>
            </div>
            <details v-if="!detail.plugin.builtin" class="extension-install-note">
              <summary>{{ t('extCenter.isolationSummary') }}</summary>
              <p>{{ t('extCenter.isolationDesc') }}</p>
            </details>
          </template>
        </template>
        <el-empty v-else :description="t('extCenter.emptyPlugins')" :image-size="64" />
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
