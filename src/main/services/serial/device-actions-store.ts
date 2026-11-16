import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEVICE_ACTIONS_CONFIG_FILE, parseDeviceActionsConfig } from './device-actions-config'
import type { DeviceActionsConfig } from './device-actions-config'

const MAX_CONFIG_BYTES = 65_536

export interface DeviceActionsFileInfo {
  path: string
  exists: boolean
  /** 原始文本：解析失败时供高级 JSON 页签直接修复 */
  text?: string
  config?: DeviceActionsConfig
  error?: string
}

export function deviceActionsFilePath(dir: string): string {
  return join(dir, DEVICE_ACTIONS_CONFIG_FILE)
}

/** 读取并校验配置；不存在不算错误，返回 exists=false。 */
export async function readDeviceActionsFile(dir: string): Promise<DeviceActionsFileInfo> {
  const path = deviceActionsFilePath(dir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false }
    return { path, exists: false, error: `无法读取设备动作配置：${(error as Error).message}` }
  }
  if (text.length > MAX_CONFIG_BYTES) {
    return { path, exists: true, text, error: 'device-actions.json 内容超限（最大 64 KB）' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { path, exists: true, text, error: 'device-actions.json 不是有效 JSON' }
  }
  try {
    return { path, exists: true, text, config: parseDeviceActionsConfig(value) }
  } catch (error) {
    return { path, exists: true, text, error: (error as Error).message }
  }
}

export type DeviceActionsWriteResult =
  | { ok: true; path: string; config: DeviceActionsConfig }
  | { ok: false; error: string }

/** 校验后原子写入规范化 JSON；校验失败时不改动原文件。 */
export async function writeDeviceActionsFile(value: unknown, dir: string): Promise<DeviceActionsWriteResult> {
  let config: DeviceActionsConfig
  try {
    config = parseDeviceActionsConfig(value)
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
  const path = deviceActionsFilePath(dir)
  const text = `${JSON.stringify(config, null, 2)}\n`
  try {
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
    return { ok: true, path, config }
  } catch (error) {
    return { ok: false, error: `无法写入设备动作配置：${(error as Error).message}` }
  }
}
