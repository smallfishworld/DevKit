/**
 * 终端快捷命令（宏）配置服务：串口助手 / SSH 终端共用一份宏库
 * 首次读取时自动从旧版 serial.quickCmds 迁移
 * 导入：支持 DevKit 导出的 JSON 与 MobaXterm 宏文件（.mxtmacros / ini，GBK 编码）
 */
import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import iconv from 'iconv-lite'
import type { ToolService } from '../../ipc'
import { QuickCmdsConfig, DEFAULT_QUICKCMDS_CONFIG, QuickCmd, migrateQuickCmd, parseMobaMacros } from '../../../shared/term-macro'
import { getSection, setSection } from '../macro/configStore'

/** 旧版 serial 节内的 quickCmds 结构（任意旧格式） */
interface LegacySerialSection {
  quickCmds?: unknown[]
}

const LEGACY_SERIAL_DEFAULT: LegacySerialSection = { quickCmds: [] }

class QuickCmdsService implements ToolService {
  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> {
    switch (action) {
      case 'config:get':
        return this.getConfig()
      case 'config:set':
        return setSection('quickCmds', payload).then(() => ({ ok: true }))
      case 'export':
        return this.exportConfig(payload as { list?: QuickCmd[] })
      case 'import':
        return this.importConfig()
      default:
        throw new Error(`quickcmds 服务未知操作: ${action}`)
    }
  }

  private async getConfig(): Promise<QuickCmdsConfig> {
    const cfg = await getSection<QuickCmdsConfig>('quickCmds', DEFAULT_QUICKCMDS_CONFIG)
    cfg.list = (cfg.list ?? []).map((c) => migrateQuickCmd(c as QuickCmd))
    if (cfg.list.length === 0) {
      // 迁移：旧版宏存在 serial 节内，搬到独立节后全局共享
      const legacy = await getSection<LegacySerialSection>('serial', LEGACY_SERIAL_DEFAULT)
      if (legacy.quickCmds?.length) {
        cfg.list = legacy.quickCmds.map((c) => migrateQuickCmd(c as QuickCmd))
        await setSection('quickCmds', cfg)
      }
    }
    return cfg
  }

  /** 导出宏库为 DevKit JSON（列表为空时导出当前库） */
  private async exportConfig(p: { list?: QuickCmd[] }): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> {
    let list = p.list
    if (!list || list.length === 0) {
      const cfg = await this.getConfig()
      list = cfg.list
    }
    if (list.length === 0) return { ok: false, error: '宏库为空，无可导出内容' }
    const stamp = new Date()
    const p2 = (n: number, w = 2): string => n.toString().padStart(w, '0')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出快捷命令配置',
      defaultPath: `devkit-quickcmds-${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}.json`,
      filters: [{ name: 'DevKit 快捷命令', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false, error: '已取消' }
    try {
      await fs.writeFile(filePath, JSON.stringify({ list }, null, 2), 'utf8')
      return { ok: true, path: filePath, count: list.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 导入：文件选择框 → 自动识别 DevKit JSON / MobaXterm 宏文件，返回解析后的列表 */
  private async importConfig(): Promise<{ ok: boolean; list?: QuickCmd[]; source?: string; error?: string }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入快捷命令（支持 DevKit JSON / MobaXterm 宏文件）',
      properties: ['openFile'],
      filters: [
        { name: '快捷命令与宏', extensions: ['json', 'mxtmacros', 'ini', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths[0]) return { ok: false, error: '已取消' }
    try {
      const buf = await fs.readFile(filePaths[0])
      // 先按 UTF-8 试 JSON（DevKit 导出）；失败则按 GBK 解码走 MobaXterm 宏解析
      const asUtf8 = buf.toString('utf8')
      const trimmed = asUtf8.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed) as QuickCmdsConfig | QuickCmd[] | Record<string, QuickCmd[]>
          let list: QuickCmd[] | undefined
          if (Array.isArray(parsed)) list = parsed
          else if (Array.isArray((parsed as QuickCmdsConfig).list)) list = (parsed as QuickCmdsConfig).list
          else {
            // 兼容任意「节名 -> 列表」结构（如手写的 { serial: [...] }）
            const firstArr = Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v))
            if (firstArr) list = firstArr as QuickCmd[]
          }
          if (list) {
            return { ok: true, source: 'devkit', list: list.map((c) => migrateQuickCmd(c)) }
          }
        } catch {
          // JSON 结构不符，继续按 MobaXterm 宏尝试
        }
      }
      // MobaXterm 宏文件为本地 ANSI（GBK）编码
      const raw = iconv.decode(buf, 'gbk')
      const list = parseMobaMacros(raw)
      if (list.length === 0) return { ok: false, error: '未识别出有效的快捷命令（不支持的文件格式）' }
      return { ok: true, source: 'mobaxterm', list }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const quickCmdsService = new QuickCmdsService()