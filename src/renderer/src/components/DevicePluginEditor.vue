<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import PluginConfigForm from './PluginConfigForm.vue'
import { defaultPluginConfig, parseConfigJson } from './plugin-config-form'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ plugin: PluginDescriptor; instance?: PluginInstance }>()
const emit = defineEmits<{ saved: [PluginInstance] }>()
const plugins = useDevicePlugins()
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
      editorError.value = '请先修复表单中标出的 JSON 语法错误'
      return false
    }
    editorJson.value = JSON.stringify(config.value, null, 2)
    editorError.value = ''
  } else if (previous === 'json') {
    const parsed = parseConfigJson(editorJson.value)
    if (parsed.error || !parsed.config) {
      editorError.value = parsed.error || '配置无效'
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
    if (!parsed.config) { editorError.value = parsed.error || '配置无效'; return }
    saved = parsed.config
  } else if (!valid.value) {
    editorError.value = '请先修复表单中标出的 JSON 语法错误'
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
  <el-dialog v-model="open" destroy-on-close :title="instance ? '编辑插件配置' : '新建插件配置'" width="min(720px, 94vw)" append-to-body>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="配置名称" required>
        <el-input v-model="label" maxlength="128" />
      </el-form-item>
      <el-checkbox v-model="enabled">启用配置</el-checkbox>
      <el-checkbox v-if="plugin.autoRespond" v-model="autoEnabled">绑定后自动监听</el-checkbox>
    </el-form>
    <el-tabs v-model="editMode" :before-leave="changeEditorMode">
      <el-tab-pane label="配置表单" name="form">
        <div class="editor-body">
          <PluginConfigForm v-model="config" :schema="plugin.configSchema" @validity="valid = $event" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="完整 JSON" name="json">
        <el-input v-model="editorJson" type="textarea" :rows="15" spellcheck="false" class="json-input" />
      </el-tab-pane>
    </el-tabs>
    <el-alert v-if="editorError || error" :title="editorError || error" type="error" :closable="false" role="alert" />
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="busy" :disabled="!label.trim()" @click="save">保存配置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.editor-body { max-height: 48vh; overflow: auto; padding-right: 8px; }
.json-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
</style>
