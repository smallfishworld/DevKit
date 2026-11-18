import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { PluginDescriptor, PluginInstance, PluginLogEntry, PluginRuntimeStatus, PluginSource } from '../../../shared/plugins'

export const PLUGIN_CATALOG_PANEL = 'plugin-catalog'
type Result<T> = { ok: boolean; error?: string } & T

export async function pluginRequest<T = object>(action: string, payload?: unknown, panelId = PLUGIN_CATALOG_PANEL): Promise<T> {
  const result = await window.api.invoke('plugins', action, panelId, payload) as Result<T>
  if (!result.ok) throw new Error(result.error || '插件操作失败')
  return result
}

export const useDevicePlugins = defineStore('device-plugins', () => {
  const plugins = shallowRef<PluginDescriptor[]>([])
  const instances = shallowRef<PluginInstance[]>([])
  const statuses = shallowRef<PluginRuntimeStatus[]>([])
  const logs = shallowRef<PluginLogEntry[]>([])
  const sources = shallowRef<PluginSource[]>([])
  const error = ref('')
  let revision = 0

  async function refresh(): Promise<void> {
    const current = ++revision
    try {
      const result = await pluginRequest<{
        plugins: PluginDescriptor[]; instances: PluginInstance[]; statuses: PluginRuntimeStatus[]; logs: PluginLogEntry[]
      }>('snapshot')
      if (current !== revision) return
      plugins.value = result.plugins
      instances.value = result.instances
      statuses.value = result.statuses
      logs.value = result.logs
      error.value = ''
    } catch (cause) {
      if (current === revision) error.value = String(cause instanceof Error ? cause.message : cause)
    }
  }

  async function sourceAction(action: string, payload?: unknown): Promise<void> {
    sources.value = (await pluginRequest<{ sources: PluginSource[] }>(action, payload)).sources
  }

  return { plugins, instances, statuses, logs, sources, error, refresh, sourceAction }
})
