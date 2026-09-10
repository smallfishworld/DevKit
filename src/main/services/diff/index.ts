/**
 * diff 服务：文本/十六进制/文件夹对比 + 文件夹同步
 * Action 路由（invoke(panelId, action, payload)），无状态，无需 dispose
 */
import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import type { ToolService } from '../../ipc'
import type {
  FileReadReq,
  FileWriteReq,
  FolderScanReq,
  FolderSyncReq,
  HexDiffReq,
  HexDiffRes,
  TextDiffPayload,
  TextDiffRes
} from '../../../shared/diff'
import { readFileRes, writeFileRes } from './io'
import { textDiff } from './textdiff'
import { hexDiff } from './hexdiff'
import { scanFolder, syncFolderItem } from './folder'

class DiffService implements ToolService {
  private async pick(mode: 'file' | 'dir', title: string): Promise<{ ok: boolean; path?: string }> {
    const opts: Electron.OpenDialogOptions = {
      title,
      properties: mode === 'file' ? ['openFile'] : ['openDirectory']
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(opts)
    if (canceled || !filePaths[0]) return { ok: false }
    return { ok: true, path: filePaths[0] }
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'pick:file':
        return this.pick('file', '选择左侧 / 右侧文件')
      case 'pick:dir':
        return this.pick('dir', '选择左侧 / 右侧目录')
      case 'read':
        return readFileRes(payload as FileReadReq)
      case 'write':
        return writeFileRes(payload as FileWriteReq)
      case 'stat':
        // 拖放后判文件/目录（渲染端 File 对象无路径外元数据，stat 走主进程）
        return this.statPath((payload as { path: string }).path)
      case 'diff:text':
        return this.diffText(payload as TextDiffPayload)
      case 'diff:hex':
        return hexDiff(payload as HexDiffReq)
      case 'folder:scan':
        return scanFolder(payload as FolderScanReq)
      case 'folder:sync':
        return syncFolderItem(payload as FolderSyncReq)
      default:
        throw new Error(`diff 服务未知操作: ${action}`)
    }
  }

  private async diffText(p: TextDiffPayload): Promise<TextDiffRes> {
    return textDiff(p.a.join('\n'), p.b.join('\n'), p.opts)
  }

  /** 拖放后判文件/目录 */
  private async statPath(path: string): Promise<{ ok: boolean; isDir?: boolean; error?: string }> {
    try {
      const st = await fs.stat(path)
      return { ok: true, isDir: st.isDirectory() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const diffService = new DiffService()