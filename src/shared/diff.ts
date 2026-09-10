/**
 * 文本/文件夹/十六进制对比：主进程 diff 服务与渲染端共用的 IPC 契约
 * 全部为可序列化纯对象（IPC 结构化克隆），hex 用空格分隔大写字符串
 */

export type DiffEncoding =
  | 'auto'
  | 'utf8'
  | 'utf16le'
  | 'utf16be'
  | 'gbk'
  | 'gb18030'
  | 'latin1'

export type BinDetect = 'text' | 'binary'

/** read action */
export interface FileReadReq {
  path: string
  encoding?: DiffEncoding
}
export interface FileReadRes {
  ok: boolean
  path: string
  /** 文本或二进制判定结果 */
  kind: BinDetect
  /** 解析后采用的编码（BOM 嗅探后 / 显式指定） */
  encoding: string
  size: number
  /** kind==='text' 时返回解码后的文本 */
  text?: string
  /** 全量字节的 hex（"AA BB"），文本与二进制都返回 */
  hex?: string
  /** 超过文本读取上限被截断 */
  tooLarge?: boolean
  error?: string
}

/** 文本 diff 引擎选项 */
export interface DiffOpts {
  ignoreSpace: boolean
  ignoreCase: boolean
}

/** 行内片段：changed=true 的片段在行内高亮 */
export interface InlineSeg {
  text: string
  changed: boolean
}

/** 一侧的对齐单元格：真实行号 + 行内片段 */
export interface SideCell {
  /** 1-based 真实行号 */
  no: number
  segs: InlineSeg[]
}

export type AlignOp = 'same' | 'changed' | 'minor' | 'only-left' | 'only-right'

/**
 * 对齐行：same=两侧同；changed=成对修改行；minor=次要差异行（仅空白/大小写不同）；
 * only-left/only-right=单侧独有行
 */
export interface AlignRow {
  op: AlignOp
  /** 所属变更块编号（导航/概览用），same 行为 null */
  block: number | null
  left?: SideCell
  right?: SideCell
}

export interface TextDiffPayload {
  a: string[]
  b: string[]
  opts: DiffOpts
}
export interface TextDiffRes {
  /** 双栏对齐行序列 */
  rows: AlignRow[]
  /** 变更块数（上一处/下一处导航上限） */
  blocks: number
  add: number
  del: number
  same: number
  /** 次要差异行数（仅空白/大小写不同的变更行） */
  minor: number
  identical: boolean
}

/** 十六进制对比：16 字节对齐行，缺侧字节以 '--' 表示 */
export type HexRowType = 'same' | 'lt' | 'rt' | 'left' | 'right'
export interface HexRow {
  offset: number
  /** 左侧 16 字节 hex（不够补 '--'） */
  left: string
  /** 右侧 16 字节 hex（不够补 '--'） */
  right: string
  leftBytes: number[]
  rightBytes: number[]
  /** same=两侧相同；lt=左侧独有；rt=右侧独有；left/right=长度错位侧 */
  type: HexRowType
}
export interface HexDiffReq {
  leftHex: string
  rightHex: string
}
export interface HexDiffRes {
  rows: HexRow[]
  leftSize: number
  rightSize: number
  diffCount: number
  identical: boolean
}

/** 文件夹对比 */
export type FolderStatus =
  | 'identical'
  | 'only-left'
  | 'only-right'
  | 'differ'
  | 'dir'
  | 'ignored'
export interface FolderEntry {
  /** 相对路径（正斜杠），空串表示根 */
  rel: string
  isDir: boolean
  status: FolderStatus
  left?: { size: number; mtimeMs: number }
  right?: { size: number; mtimeMs: number }
}
export interface FolderFilter {
  /** 忽略的扩展名（不含点，小写） */
  extIgnore: string[]
  ignoreCase: boolean
  ignoreWhitespace: boolean
}
export interface FolderScanReq {
  left: string
  right: string
  filter: FolderFilter
}
export interface FolderScanRes {
  ok: boolean
  leftRoot: string
  rightRoot: string
  entries: FolderEntry[]
  counts: Record<FolderStatus, number>
  error?: string
}

/** 文件夹同步 */
export type SyncDir = 'left-to-right' | 'right-to-left'
export interface FolderSyncReq {
  dir: SyncDir
  /** 相对路径（正斜杠） */
  rel: string
  /** 'copy' = 从一侧复制到对侧；'delete' = 从对侧删除该条目 */
  op: 'copy' | 'delete'
  left: string
  right: string
}
export interface FolderSyncRes {
  ok: boolean
  op: 'copy' | 'delete'
  error?: string
}

/** 文本写回（比对中复制到对侧后的保存） */
export interface FileWriteReq {
  path: string
  content: string
  /** 写回编码：读入时探测/指定的编码原样回写，避免 GBK 文件写坏 */
  encoding: string
}
export interface FileWriteRes {
  ok: boolean
  error?: string
}