import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { PluginDescriptor, PluginInstance, PluginLogEntry, PluginRuntimeStatus, PluginSource } from '../../../shared/plugins'

export const PLUGIN_CATALOG_PANEL = 'plugin-catalog'
const MAX_LOGS = 300
type Result<T> = { ok: boolean; error?: string } & T

export async function pluginRequest<T = object>(action: string, payload?: unknown, panelId = PLUGIN_CATALOG_PANEL): Promise<T> {
  const result = await window.api.invoke('plugins', action, panelId, payload) as Result<T>
  if (!result.ok) throw new Error(result.error || '插件操作失败')
  return result
}

export const useDevicePlugins = defineStore('device-plugins', () => {
  const hostVersion = ref('')
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
        hostVersion?: string
        plugins: PluginDescriptor[]
        instances: PluginInstance[]
        statuses: PluginRuntimeStatus[]
        logs: PluginLogEntry[]
      }>('snapshot')
      if (current !== revision) return
      if (result.hostVersion) hostVersion.value = result.hostVersion
      plugins.value = result.plugins
      instances.value = result.instances
      statuses.value = result.statuses
      logs.value = result.logs
      error.value = ''
    } catch (cause) {
      if (current === revision) error.value = String(cause instanceof Error ? cause.message : cause)
    }
  }

  /** Incremental status update without pulling full snapshot. */
  function applyStatus(next: PluginRuntimeStatus): void {
    const list = statuses.value.slice()
    const idx = list.findIndex((item) => item.instanceId === next.instanceId)
    if (idx >= 0) list[idx] = next
    else list.push(next)
    statuses.value = list
  }

  /** Incremental log append capped at MAX_LOGS entries. */
  function appendLog(entry: PluginLogEntry): void {
    const list = logs.value.concat(entry)
    logs.value = list.length > MAX_LOGS ? list.slice(list.length - MAX_LOGS) : list
  }

  async function sourceAction(action: string, payload?: unknown): Promise<void> {
    const res = await pluginRequest<{ sources: PluginSource[]; hostVersion?: string }>(action, payload)
    if (res.hostVersion) hostVersion.value = res.hostVersion
    sources.value = res.sources
  }

  return { hostVersion, plugins, instances, statuses, logs, sources, error, refresh, applyStatus, appendLog, sourceAction }
})
