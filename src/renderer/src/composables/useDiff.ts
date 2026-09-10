/**
 * diff 服务渲染端封装：文本/十六进制/文件夹对比 + 同步
 * 全部经 window.api.invoke('diff', action, panelId, payload)
 */
import type {
  DiffEncoding,
  FileReadReq,
  FileReadRes,
  FileWriteReq,
  FileWriteRes,
  FolderScanReq,
  FolderScanRes,
  FolderSyncReq,
  FolderSyncRes,
  HexDiffReq,
  HexDiffRes,
  TextDiffPayload,
  TextDiffRes
} from '../../../shared/diff'

const PANEL = '__diff__'

function call<T>(action: string, payload: unknown): Promise<T> {
  return window.api.invoke('diff', action, PANEL, payload) as Promise<T>
}

export function useDiff() {
  const pickFile = (title?: string): Promise<{ ok: boolean; path?: string }> =>
    call('pick:file', { title })
  const pickDir = (title?: string): Promise<{ ok: boolean; path?: string }> =>
    call('pick:dir', { title })
  const readFile = (req: FileReadReq): Promise<FileReadRes> => call('read', req)
  const writeFile = (req: FileWriteReq): Promise<FileWriteRes> => call('write', req)
  /** 拖放后判文件/目录 */
  const statPath = (path: string): Promise<{ ok: boolean; isDir?: boolean; error?: string }> =>
    call('stat', { path })
  const diffText = (p: TextDiffPayload): Promise<TextDiffRes> => call('diff:text', p)
  const diffHex = (p: HexDiffReq): Promise<HexDiffRes> => call('diff:hex', p)
  const scanFolder = (p: FolderScanReq): Promise<FolderScanRes> => call('folder:scan', p)
  const syncFolder = (p: FolderSyncReq): Promise<FolderSyncRes> => call('folder:sync', p)

  return { pickFile, pickDir, readFile, writeFile, statPath, diffText, diffHex, scanFolder, syncFolder }
}

export const ENCODINGS: { value: DiffEncoding; label: string }[] = [
  { value: 'auto', label: '自动（BOM/内容嗅探）' },
  { value: 'utf8', label: 'UTF-8' },
  { value: 'utf16le', label: 'UTF-16 LE' },
  { value: 'utf16be', label: 'UTF-16 BE' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'latin1', label: 'Latin-1' }
]