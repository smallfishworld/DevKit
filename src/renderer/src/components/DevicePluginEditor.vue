<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import PluginConfigForm from './PluginConfigForm.vue'
import { defaultPluginConfig, parseConfigJson } from './plugin-config-form'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ plugin: PluginDescriptor; instance?: PluginInstance }>()
const emit = defineEmits<{ saved: [PluginInstance] }>()
const plugins = useDevicePlugins()
const { t } = useI18n()
const label = ref('')
const enabled = ref(true)
const autoEnabled = ref(false)
const config = ref<Record<string, unknown>>({})
const valid = ref(true)
const busy = ref(false)
const error = ref('')
const editMode = ref<'form' | 'json'>('form')
const editorJson = ref('')
const editorError = ref('')

watch(open, (visible) => {
  if (!visible) return
  label.value = props.instance?.label ?? props.plugin.name
  enabled.value = props.instance?.enabled ?? true
  autoEnabled.value = props.instance?.autoEnabled ?? false
  config.value = props.instance ? JSON.parse(JSON.stringify(props.instance.config)) : defaultPluginConfig(props.plugin.configSchema)
  editorJson.value = JSON.stringify(config.value, null, 2)
  editMode.value = 'form'
  valid.value = true
  error.value = ''
  editorError.value = ''
}, { immediate: true })

/** Mirror of PluginManager.changeEditorMode: keep the two tab views in sync. */
function changeEditorMode(mode: 'form' | 'json', previous: 'form' | 'json'): boolean {
  if (mode === 'json') {
    if (!valid.value) {
      editorError.value = t('pluginEditor.fixJsonFirst')
      return false
    }
    editorJson.value = JSON.stringify(config.value, null, 2)
    editorError.value = ''
  } else if (previous === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (parsed.error || !parsed.config) {
      editorError.value = parsed.error || t('pluginEditor.invalidConfig')
      return false
    }
    config.value = parsed.config
    valid.value = true
    editorError.value = ''
  }
  return true
}

async function save(): Promise<void> {
  if (busy.value || !label.value.trim()) return
  let saved = config.value
  if (editMode.value === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (!parsed.config) { editorError.value = parsed.error || t('pluginEditor.invalidConfig'); return }
    saved = parsed.config
  } else if (!valid.value) {
    editorError.value = t('pluginEditor.fixJsonFirst')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const { instance } = await pluginRequest<{ instance: PluginInstance }>('instance:save', {
      instance: {
        id: props.instance?.id, pluginId: props.plugin.id, label: label.value,
        enabled: enabled.value, autoEnabled: autoEnabled.value, config: JSON.parse(JSON.stringify(saved))
      }
    })
    await plugins.refresh()
    open.value = false
    emit('saved', instance)
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>

<template>
  <el-dialog v-model="open" destroy-on-close :title="instance ? t('pluginEditor.editTitle') : t('pluginEditor.newTitle')" width="min(720px, 94vw)" append-to-body>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item :label="t('pluginEditor.configName')" required>
        <el-input v-model="label" maxlength="128" />
      </el-form-item>
      <el-checkbox v-model="enabled">{{ t('pluginEditor.enableConfig') }}</el-checkbox>
      <el-checkbox v-if="plugin.autoRespond" v-model="autoEnabled">{{ t('pluginEditor.autoListen') }}</el-checkbox>
    </el-form>
    <el-tabs v-model="editMode" :before-leave="changeEditorMode">
      <el-tab-pane :label="t('pluginEditor.tabForm')" name="form">
        <div class="editor-body">
          <PluginConfigForm v-model="config" :schema="plugin.configSchema" @validity="valid = $event" />
        </div>
      </el-tab-pane>
      <el-tab-pane :label="t('pluginEditor.tabJson')" name="json">
        <el-input v-model="editorJson" type="textarea" :rows="15" spellcheck="false" class="json-input" />
      </el-tab-pane>
    </el-tabs>
    <el-alert v-if="editorError || error" :title="editorError || error" type="error" :closable="false" role="alert" />
    <template #footer>
      <el-button @click="open = false">{{ t('pluginEditor.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="!label.trim()" @click="save">{{ t('pluginEditor.saveConfig') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.editor-body { max-height: 48vh; overflow: auto; padding-right: 8px; }
.json-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
</style>
