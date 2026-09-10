/**
 * 全局热键管理：Electron globalShortcut 封装
 * 支持解析 accelerator -> {vk, 修饰键}，用于录制时识别/过滤自身热键（MR-07）
 */
import { globalShortcut } from 'electron'
import type { KeyEventData } from '../../../shared/types'

export interface HotkeyBinding {
  id: string
  accelerator: string
  vk: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

const FKEY_VK = (n: number): number => 0x70 + n - 1

/** 解析 accelerator 的主键为 VK 码 */
function keyToVk(key: string): number | null {
  const k = key.toUpperCase()
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return FKEY_VK(parseInt(k.slice(1), 10))
  if (/^[A-Z]$/.test(k)) return 0x41 + k.charCodeAt(0) - 65
  if (/^[0-9]$/.test(k)) return 0x30 + parseInt(k, 10)
  const named: Record<string, number> = {
    Space: 0x20,
    Tab: 0x09,
    Enter: 0x0d,
    Return: 0x0d,
    Backspace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
    Esc: 0x1b,
    Escape: 0x1b,
    PrintScreen: 0x2c
  }
  return named[k] ?? null
}

export function parseAccelerator(acc: string): HotkeyBinding | null {
  if (!acc || !acc.trim()) return null
  const parts = acc.split('+').map((p) => p.trim())
  const main = parts[parts.length - 1]
  const vk = keyToVk(main)
  if (vk === null) return null
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase())
  const has = (name: string): boolean => mods.includes(name)
  return {
    id: acc,
    accelerator: acc,
    vk,
    ctrl: has('control') || has('ctrl') || has('commandorcontrol'),
    alt: has('alt'),
    shift: has('shift'),
    meta: has('super') || has('meta') || has('commandorcontrol')
  }
}

export interface HotkeyEntry {
  id: string
  accelerator: string
  handler: () => void
}

/** 当前已注册的热键（含主热键与宏热键），录制过滤与冲突检测都查这里 */
const registered = new Map<string, HotkeyEntry>()

export interface RegisterResult {
  ok: boolean
  reason?: string
}

export function registerHotkey(id: string, accelerator: string, handler: () => void): RegisterResult {
  if (!accelerator) return { ok: true }
  // 冲突检测：同一 accelerator 只允许一个用途
  for (const entry of registered.values()) {
    if (entry.accelerator === accelerator && entry.id !== id) {
      return { ok: false, reason: `热键 ${accelerator} 已被「${entry.id}」占用` }
    }
  }
  const ok = globalShortcut.register(accelerator, handler)
  if (!ok) return { ok: false, reason: `热键 ${accelerator} 注册失败（可能被其他程序占用）` }
  registered.set(id, { id, accelerator, handler })
  return { ok: true }
}

export function unregisterHotkey(id: string): void {
  const entry = registered.get(id)
  if (entry) {
    globalShortcut.unregister(entry.accelerator)
    registered.delete(id)
  }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  registered.clear()
}

export function getRegistered(): HotkeyEntry[] {
  return [...registered.values()]
}

/** 判断键盘事件是否命中任一已注册热键（录制时用于过滤自身热键） */
export function matchesAnyHotkey(e: KeyEventData): boolean {
  for (const entry of registered.values()) {
    const binding = parseAccelerator(entry.accelerator)
    if (!binding) continue
    if (binding.vk === e.vk && binding.ctrl === e.ctrl && binding.alt === e.alt && binding.shift === e.shift && binding.meta === e.meta) {
      return true
    }
  }
  return false
}
