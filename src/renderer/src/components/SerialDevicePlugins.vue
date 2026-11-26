<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Box, RefreshRight, VideoPause } from '@element-plus/icons-vue'
import { pluginRequest, useDevicePlugins } from '@renderer/stores/devicePlugins'
import type { PluginInstance, StreamTransport } from '../../../shared/plugins'

const props = withDefaults(defineProps<{
  panelId: string
  connected: boolean
  transport?: StreamTransport
}>(), {
  transport: 'serial'
})

const { t } = useI18n()
const plugins = useDevicePlugins()
const picked = ref('')
const error = ref('')
const pending = ref('')
const stopping = ref<string[]>([])

const transportLabel = computed(() => ({
  serial: t('sessionPlugins.transportSerial'),
  ssh: t('sessionPlugins.transportSsh'),
  net: t('sessionPlugins.transportNet'),
  pty: t('sessionPlugins.transportPty')
})[props.transport])
const bound = computed(() => plugins.statuses.filter((status) => status.panelId === props.panelId && status.bound))
const errored = computed(() => plugins.statuses.find((status) => status.panelId === props.panelId && status.state === 'error'))
const lastError = computed(() => errored.value?.error)
const available = computed(() => plugins.instances.filter((instance) => {
  if (!instance.enabled) return false
  const descriptor = plugins.plugins.find((plugin) => plugin.id === instance.pluginId)
  if (!descriptor || !descriptor.transports.includes(props.transport)) return false
  return !plugins.statuses.some((status) => status.bound && status.instanceId === instance.id)
}))
const instanceFor = (id: string): PluginInstance | undefined => plugins.instances.find((instance) => instance.id === id)
const actionsFor = (id: string) => plugins.plugins.find((plugin) => plugin.id === instanceFor(id)?.pluginId)?.actions ?? []
const statusLabel = computed(() => bound.value.some((item) => item.state === 'running')
  ? t('sessionPlugins.statusRunning')
  : bound.value.some((item) => item.state === 'starting')
    ? t('sessionPlugins.statusStarting')
    : bound.value.some((item) => instanceFor(item.instanceId)?.autoEnabled) ? t('sessionPlugins.statusListening') : bound.value.length ? t('sessionPlugins.statusBound') : '')
const recentLog = computed(() => plugins.logs.filter((log) => log.panelId === props.panelId).at(-1))

async function operate(action: 'bind' | 'run', instanceId: string, actionId?: string): Promise<void> {
  if (pending.value || !instanceId) return
  pending.value = action
  error.value = ''
  try {
    const payload = action === 'bind'
      ? { instanceId, transport: props.transport }
      : { instanceId, actionId }
    await pluginRequest(action, payload, props.panelId)
    if (action === 'bind') picked.value = ''
  } catch (e) { error.value = (e as Error).message }
  finally { pending.value = ''; await plugins.refresh() }
}

async function stop(instanceId: string): Promise<void> {
  if (stopping.value.includes(instanceId)) return
  stopping.value = [...stopping.value, instanceId]
  error.value = ''
  try { await pluginRequest('stop', { instanceId }, props.panelId) }
  catch (e) { error.value = (e as Error).message }
  finally {
    stopping.value = stopping.value.filter((id) => id !== instanceId)
    await plugins.refresh()
  }
}
</script>

<template>
  <div class="session-plugin-entry">
    <el-popover placement="bottom-end" :width="340" trigger="click" @show="plugins.refresh()">
      <template #reference>
        <el-button size="small" text :icon="Box" :aria-label="t('sessionPlugins.ariaEntry')">{{ t('sessionPlugins.buttonLabel') }}<span v-if="statusLabel" class="plugin-active"> · {{ statusLabel }}</span></el-button>
      </template>
      <h3 class="plugin-title">{{ t('sessionPlugins.panelTitle', { transport: transportLabel }) }}</h3>
      <div v-if="error || lastError" class="error-row">
        <el-alert :title="error || lastError" type="error" :closable="false" role="alert" />
        <el-button
          v-if="errored && connected"
          size="small"
          type="warning"
          plain
          :icon="RefreshRight"
          :disabled="!!pending"
          @click="operate('bind', errored.instanceId)"
        >
          {{ t('sessionPlugins.retryBind') }}
        </el-button>
      </div>
      <p v-if="!connected" class="plugin-note">{{ t('sessionPlugins.connectFirst', { transport: transportLabel }) }}</p>
      <div v-for="status in bound" :key="status.instanceId" class="bound-instance">
        <strong>{{ instanceFor(status.instanceId)?.label }}</strong>
        <div class="plugin-actions">
          <el-button size="small" v-for="action in actionsFor(status.instanceId)" :key="action.id"
            :disabled="status.state !== 'ready' || !!pending" @click="operate('run', status.instanceId, action.id)">{{ action.label }}</el-button>
          <el-button size="small" :loading="stopping.includes(status.instanceId)" @click="stop(status.instanceId)">{{ t('sessionPlugins.stopPlugin') }}</el-button>
        </div>
      </div>
      <div v-if="available.length" class="plugin-actions">
        <el-select v-model="picked" size="small" :placeholder="t('sessionPlugins.pickInstance')" :aria-label="t('sessionPlugins.pickInstance')" :disabled="!connected || !!pending">
          <el-option v-for="instance in available" :key="instance.id" :label="instance.label" :value="instance.id" />
        </el-select>
        <el-button size="small" type="primary" :disabled="!picked || !connected || !!pending" @click="operate('bind', picked)">{{ t('sessionPlugins.bindToCurrent', { transport: transportLabel }) }}</el-button>
      </div>
      <p v-else-if="!bound.length && connected" class="plugin-note">{{ t('sessionPlugins.emptyHint', { transport }) }}</p>
      <p v-if="recentLog" class="plugin-note">{{ recentLog.message }}</p>
    </el-popover>
    <el-button v-if="bound.length === 1" size="small" text :icon="VideoPause" :loading="stopping.includes(bound[0].instanceId)"
      :aria-label="t('sessionPlugins.stopAria')" @click="stop(bound[0].instanceId)" />
  </div>
</template>

<style scoped>
.session-plugin-entry { display:inline-flex; align-items:center; border-inline-start:1px solid var(--el-border-color-lighter); }
.session-plugin-entry .el-button { margin:0; }
.plugin-active { color:var(--el-color-success); }
.plugin-title { margin:0 0 8px; font-size:14px; }
.plugin-note { color:var(--el-text-color-secondary); font-size:12px; overflow-wrap:anywhere; }
.plugin-actions { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-block:7px; }
.plugin-actions .el-select { flex:1; min-width:130px; }
.plugin-actions .el-button { margin:0; }
.bound-instance { border-bottom:1px solid var(--el-border-color-lighter); margin-block:8px; }
.error-row { display:flex; flex-direction:column; gap:6px; margin-bottom:8px; }
</style>
