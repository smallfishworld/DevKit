/** 宏库文件存取：userData/macros/*.json */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { MacroFile } from '../../../shared/macro'

function macroDir(): string {
  return join(app.getPath('userData'), 'macros')
}

function fileNameOf(name: string): string {
  // 文件名安全化：仅保留常见字符
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
  return `${safe}.json`
}

export async function ensureDir(): Promise<void> {
  await fs.mkdir(macroDir(), { recursive: true })
}

export async function listMacros(): Promise<{ filename: string; macro: MacroFile }[]> {
  await ensureDir()
  const files = await fs.readdir(macroDir())
  const out: { filename: string; macro: MacroFile }[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(macroDir(), f), 'utf-8')
      const macro = JSON.parse(raw) as MacroFile
      if (macro && macro.meta && Array.isArray(macro.steps)) {
        out.push({ filename: f, macro })
      }
    } catch {
      /* 跳过损坏文件 */
    }
  }
  out.sort((a, b) => b.macro.meta.updatedAt - a.macro.meta.updatedAt)
  return out
}

export async function saveMacro(macro: MacroFile, originalName?: string): Promise<string> {
  await ensureDir()
  const filename = fileNameOf(macro.meta.name)
  if (originalName && originalName !== filename) {
    await fs.rm(join(macroDir(), originalName), { force: true })
  }
  await fs.writeFile(join(macroDir(), filename), JSON.stringify(macro, null, 2), 'utf-8')
  return filename
}

export async function deleteMacro(filename: string): Promise<void> {
  await fs.rm(join(macroDir(), filename), { force: true })
}

export function macroPathOf(filename: string): string {
  return join(macroDir(), filename)
}
