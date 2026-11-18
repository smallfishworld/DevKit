<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PluginDescriptor, PluginInstance } from '../../../shared/plugins'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import PluginConfigForm from './PluginConfigForm.vue'
import { defaultPluginConfig } from './plugin-config-form'

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

watch(open, (visible) => {
  if (!visible) return
  label.value = props.instance?.label ?? props.plugin.name
  enabled.value = props.instance?.enabled ?? true
  autoEnabled.value = props.instance?.autoEnabled ?? false
  config.value = props.instance ? JSON.parse(JSON.stringify(props.instance.config)) : defaultPluginConfig(props.plugin.configSchema)
  valid.value = true
  error.value = ''
}, { immediate: true })

async function save(): Promise<void> {
  if (busy.value || !valid.value || !label.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const { instance } = await pluginRequest<{ instance: PluginInstance }>('instance:save', {
      instance: {
        id: props.instance?.id, pluginId: props.plugin.id, label: label.value,
        enabled: enabled.value, autoEnabled: autoEnabled.value, config: JSON.parse(JSON.stringify(config.value))
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
  <el-dialog v-model="open" destroy-on-close :title="instance ? '编辑插件配置' : '新建插件配置'" width="min(580px, 94vw)" append-to-body>
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="配置名称" required>
        <el-input v-model="label" maxlength="128" />
      </el-form-item>
      <el-checkbox v-model="enabled">启用配置</el-checkbox>
      <el-checkbox v-if="plugin.autoRespond" v-model="autoEnabled">绑定后自动监听</el-checkbox>
    </el-form>
    <PluginConfigForm v-model="config" :schema="plugin.configSchema" @validity="valid = $event" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" role="alert" />
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="busy" :disabled="!label.trim() || !valid" @click="save">保存配置</el-button>
    </template>
  </el-dialog>
</template>
