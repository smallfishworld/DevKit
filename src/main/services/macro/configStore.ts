/** 简易 JSON 配置存取（userData/config.json），M3 起使用，M4 扩展为全局配置 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MACRO_SETTINGS, type MacroSettings } from '../../../shared/macro'

const CONFIG_FILE = () => join(app.getPath('userData'), 'config.json')

let cache: Record<string, unknown> | null = null

export async function loadConfig(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(CONFIG_FILE(), 'utf-8')
    cache = JSON.parse(raw) as Record<string, unknown>
  } catch {
    cache = {}
  }
  return cache
}

export async function saveConfig(data: Record<string, unknown>): Promise<void> {
  cache = { ...data }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(CONFIG_FILE(), JSON.stringify(data, null, 2), 'utf-8')
}

export async function loadMacroSettings(): Promise<MacroSettings> {
  const cfg = await loadConfig()
  return { ...DEFAULT_MACRO_SETTINGS, ...((cfg.macro as Partial<MacroSettings>) ?? {}) }
}

export async function saveMacroSettings(settings: MacroSettings): Promise<void> {
  const cfg = await loadConfig()
  cfg.macro = settings
  await saveConfig(cfg)
}

/** 通用配置段读取（M4：serial / net 等各工具持久化） */
export async function getSection<T>(key: string, defaults: T): Promise<T> {
  const cfg = await loadConfig()
  return { ...defaults, ...((cfg[key] as Partial<T>) ?? {}) }
}

export async function setSection<T>(key: string, value: T): Promise<void> {
  const cfg = await loadConfig()
  cfg[key] = value
  await saveConfig(cfg)
}
