<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelMessageBox } from '@renderer/composables/panelOverlays'
import type { PluginSource, PluginSourceEntry } from '../../../shared/plugins'
import { satisfiesMinVersion } from '../../../../packages/plugin-sdk/src/manifest'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'

const ElMessageBox = usePanelMessageBox()
const { t } = useI18n()

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
      t('extSources.installConfirm', { source: source.name, name: entry.name, version: entry.version, host: new URL(entry.url).host }),
      t('extSources.installConfirmTitle'), { type: 'warning', confirmButtonText: t('extSources.install'), cancelButtonText: t('extCenter.cancel') }
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
  <el-dialog v-model="open" :title="t('extSources.title')" width="min(700px, 94vw)" append-to-body>
    <p class="source-note">{{ t('extSources.note') }}</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" role="alert" />
    <div v-if="!plugins.sources.length" class="source-empty">{{ t('extSources.empty') }}</div>
    <section v-for="source in plugins.sources" :key="source.id" class="source-card" :data-source-kind="source.official ? 'official' : 'custom'">
      <div class="source-head">
        <strong>{{ source.name }}</strong>
        <el-tag v-if="source.official" size="small" effect="plain">{{ t('extSources.official') }}</el-tag>
        <el-switch :model-value="source.enabled" :disabled="busy" :aria-label="t('extSources.enableAria', { name: source.name })"
          @change="(enabled: unknown) => run(() => plugins.sourceAction('sources:toggle', { id: source.id, enabled }))"
        />
        <el-button size="small" :disabled="busy || !source.enabled" @click="run(() => plugins.sourceAction('sources:refresh', { id: source.id }))">{{ t('extSources.refresh') }}</el-button>
        <el-button v-if="!source.official" size="small" text type="danger" :disabled="busy" @click="run(() => plugins.sourceAction('sources:remove', { id: source.id }))">{{ t('extSources.remove') }}</el-button>
      </div>
      <div class="source-note">{{ source.url }}</div>
      <div class="source-note">{{ source.refreshedAt ? t('extSources.refreshedSummary', { count: source.entries.length, time: new Date(source.refreshedAt).toLocaleString() }) : t('extSources.notRefreshed') }}</div>
      <div v-for="entry in source.enabled ? source.entries : []" :key="entry.id" class="source-entry">
        <span>
          {{ entry.name }} <small>{{ entry.version }}</small>
          <el-tag v-if="entry.yanked" size="small" type="danger" effect="plain">{{ t('extSources.yanked') }}</el-tag>
          <el-tag v-else-if="entry.deprecated" size="small" type="warning" effect="plain" :title="entry.deprecated">{{ t('extSources.deprecated') }}</el-tag>
          <el-tag v-if="!isCompatible(entry)" size="small" type="info" effect="plain">{{ t('extSources.minHost', { version: entry.minHostVersion }) }}</el-tag>
        </span>
        <el-button size="small" :disabled="busy || entry.yanked || !isCompatible(entry)" @click="install(source, entry)">{{ t('extSources.install') }}</el-button>
      </div>
    </section>

    <details class="source-add">
      <summary>{{ t('extSources.addCustom') }}</summary>
      <el-form label-position="top" @submit.prevent="add">
        <el-form-item :label="t('extSources.sourceName')" required><el-input v-model="name" maxlength="128" /></el-form-item>
        <el-form-item :label="t('extSources.indexUrl')" required><el-input v-model="url" placeholder="https://example.org/devkit/index.json" /></el-form-item>
        <el-button native-type="submit" type="primary" :loading="busy" :disabled="!name.trim() || !url.trim()">{{ t('extSources.addBtn') }}</el-button>
      </el-form>
    </details>
    <template #footer><el-button type="primary" @click="open = false">{{ t('extSources.done') }}</el-button></template>
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
