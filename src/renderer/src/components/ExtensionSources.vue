<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { PluginSource, PluginSourceEntry } from '../../../shared/plugins'
import { satisfiesMinVersion } from '../../../../packages/plugin-sdk/src/manifest'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'

const open = defineModel<boolean>({ required: true })
const plugins = useDevicePlugins()
const name = ref('')
const url = ref('')
const busy = ref(false)
const error = ref('')

async function run(task: () => Promise<void>): Promise<void> {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try { await task() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}

function add(): void {
  void run(async () => {
    await plugins.sourceAction('sources:add', { name: name.value, url: url.value })
    name.value = ''
    url.value = ''
  })
}

function isCompatible(entry: PluginSourceEntry): boolean {
  if (!entry.minHostVersion || !plugins.hostVersion) return true
  return satisfiesMinVersion(plugins.hostVersion, entry.minHostVersion)
}

async function install(source: PluginSource, entry: PluginSourceEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `从「${source.name}」安装 ${entry.name} ${entry.version}（${new URL(entry.url).host}）。插件具有本机文件和网络访问能力，请确认你信任此代码。`,
      '确认安装插件', { type: 'warning', confirmButtonText: '安装', cancelButtonText: '取消' }
    )
  } catch { return }
  await run(async () => {
    await pluginRequest('sources:install', { sourceId: source.id, pluginId: entry.id, sha256: entry.sha256 })
    await plugins.refresh()
  })
}

watch(open, (visible) => {
  if (visible) void run(() => plugins.sourceAction('sources:list'))
})
</script>

<template>
  <el-dialog v-model="open" title="扩展源管理" width="min(700px, 94vw)" append-to-body>
    <p class="source-note">官方扩展源默认启用，也可添加自定义 HTTPS 安装索引。刷新后可浏览插件。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" role="alert" />
    <div v-if="!plugins.sources.length" class="source-empty">暂无已配置的扩展源</div>
    <section v-for="source in plugins.sources" :key="source.id" class="source-card" :data-source-kind="source.official ? 'official' : 'custom'">
      <div class="source-head">
        <strong>{{ source.name }}</strong>
        <el-tag v-if="source.official" size="small" effect="plain">官方</el-tag>
        <el-switch :model-value="source.enabled" :disabled="busy" :aria-label="'启用 ' + source.name"
          @change="(enabled: unknown) => run(() => plugins.sourceAction('sources:toggle', { id: source.id, enabled }))"
        />
        <el-button size="small" :disabled="busy || !source.enabled" @click="run(() => plugins.sourceAction('sources:refresh', { id: source.id }))">刷新</el-button>
        <el-button v-if="!source.official" size="small" text type="danger" :disabled="busy" @click="run(() => plugins.sourceAction('sources:remove', { id: source.id }))">移除</el-button>
      </div>
      <div class="source-note">{{ source.url }}</div>
      <div class="source-note">{{ source.refreshedAt ? `${source.entries.length} 个插件 · ${new Date(source.refreshedAt).toLocaleString()}` : '尚未刷新' }}</div>
      <div v-for="entry in source.enabled ? source.entries : []" :key="entry.id" class="source-entry">
        <span>
          {{ entry.name }} <small>{{ entry.version }}</small>
          <el-tag v-if="entry.yanked" size="small" type="danger" effect="plain">已撤回</el-tag>
          <el-tag v-else-if="entry.deprecated" size="small" type="warning" effect="plain" :title="entry.deprecated">已废弃</el-tag>
          <el-tag v-if="!isCompatible(entry)" size="small" type="info" effect="plain">需宿主 ≥ {{ entry.minHostVersion }}</el-tag>
        </span>
        <el-button size="small" :disabled="busy || entry.yanked || !isCompatible(entry)" @click="install(source, entry)">安装</el-button>
      </div>
    </section>

    <details class="source-add">
      <summary>添加自定义扩展源</summary>
      <el-form label-position="top" @submit.prevent="add">
        <el-form-item label="源名称" required><el-input v-model="name" maxlength="128" /></el-form-item>
        <el-form-item label="HTTPS 安装索引地址" required><el-input v-model="url" placeholder="https://example.org/devkit/index.json" /></el-form-item>
        <el-button native-type="submit" type="primary" :loading="busy" :disabled="!name.trim() || !url.trim()">添加扩展源</el-button>
      </el-form>
    </details>
    <template #footer><el-button type="primary" @click="open = false">完成</el-button></template>
  </el-dialog>
</template>

<style scoped>
.source-note, .source-empty { color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.source-card { padding: 10px 12px; margin-block: 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.source-head, .source-entry { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.source-head strong, .source-entry span { flex: 1; display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.source-head .el-button, .source-entry .el-button { margin: 0; }
.source-entry { margin-top: 7px; }
.source-entry small { color: var(--el-text-color-secondary); }
.source-add { border-top: 1px solid var(--el-border-color-lighter); padding-top: 10px; margin-top: 12px; }
.source-add summary { cursor: pointer; }
</style>
