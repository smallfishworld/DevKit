/**
 * 合并分屏标签纯逻辑（供 tabs store / TabBar / ToolLauncher / tests 共用）。
 *
 * 模型：分屏 = 一个 `kind: 'split'` 的标签内嵌两个成员面板（TabItem[]），
 * 标签条上只显示一个条目（标题 "A | B"、单个关闭按钮），内容区左右并排渲染成员。
 * 拆分 = 把成员还原为独立标签。
 */
import { reorderTabIds } from './workbench-navigation'

export interface SplitMemberLike {
  id: string
  title: string
  connection?: string
}

/** 合并标签标题："COM1 | COM2" */
export function splitTabTitle(members: SplitMemberLike[]): string {
  return members.map((m) => m.title).join(' | ')
}

/** 该条目覆盖的会话标签 id：分屏 → 成员 ids；普通标签 → 自身 */
export function memberTabIds(tab: { id: string; kind?: string; members?: SplitMemberLike[] }): string[] {
  return tab.kind === 'split' ? (tab.members ?? []).map((m) => m.id) : [tab.id]
}

export interface MergePlan {
  /** 分屏标签插入位置（两成员扁平序较小者） */
  index: number
  /** 成员按原扁平顺序排列：first 在前 */
  firstId: string
  secondId: string
}

/**
 * 合并两个普通标签为一个分屏标签的位置计划。
 * home 不可合并；任一不存在返回 null（成员是否为分屏标签由调用方校验）。
 */
export function planMerge(ids: string[], anchorId: string, joinerId: string): MergePlan | null {
  if (anchorId === joinerId || anchorId === 'home' || joinerId === 'home') return null
  const a = ids.indexOf(anchorId)
  const b = ids.indexOf(joinerId)
  if (a < 0 || b < 0) return null
  return a < b
    ? { index: a, firstId: anchorId, secondId: joinerId }
    : { index: b, firstId: joinerId, secondId: anchorId }
}

/**
 * 拖拽重排（条目可为普通标签或分屏标签，整体移动）。
 * 返回新 id 扁平顺序；home 保护由 reorderTabIds 承担。
 */
export function reorderWorkTabIds(ids: string[], draggedId: string, targetId: string, position: 'before' | 'after'): string[] {
  return reorderTabIds(ids, draggedId, targetId, position)
}

// ---------- 内容区落位 ----------

interface HostEntryLike {
  id: string
  kind?: string
  toolId?: string
  members?: HostEntryLike[]
}

/** 自带终端、能执行快捷命令的面板 */
export const TERMINAL_TOOLS = ['serial', 'ssh', 'local-terminal']

export function isTerminalTool(toolId: string | undefined): boolean {
  return TERMINAL_TOOLS.includes(toolId ?? '')
}

/**
 * 两个成员都是终端的分屏共用一条快捷命令栏：命令库本来全局只有一份（useTermMacros），
 * 每个终端各渲染一份只是重复——只留一条，命令发给当前选中的终端。
 */
export function hostSharesQuickCmds(host: HostEntryLike | undefined): boolean {
  const members = host?.members
  return host?.kind === 'split' && members?.length === 2 && members.every((m) => isTerminalTool(m.toolId))
}

/** 面板在内容区的落位：所在条目未激活 → hidden；分屏成员 → left/right；普通条目 → full */
export type HostSlot = 'hidden' | 'full' | 'left' | 'right'

/**
 * 某面板在内容区的落位（App.vue 写进 data-slot，由 CSS 决定显隐与所在列）。
 * 面板常驻组件树，合并/拆分只改变落位而不重建实例。
 */
export function hostSlot(entries: HostEntryLike[], activeId: string, panelId: string): HostSlot {
  const host = entries.find((entry) => entry.id === panelId || entry.members?.some((m) => m.id === panelId))
  if (!host || host.id !== activeId) return 'hidden'
  const index = host.members?.findIndex((m) => m.id === panelId) ?? -1
  return index < 0 ? 'full' : index === 0 ? 'left' : 'right'
}

// ---------- 分屏宽度（分隔条比例） ----------

/** 左成员占比（%）的默认值与可拖拽范围 */
export const SPLIT_DEFAULT_PCT = 50
export const SPLIT_MIN_PCT = 20
export const SPLIT_MAX_PCT = 80
/** 分隔条在布局中占用的宽度；成员比例按扣除它之后的可用宽度分配 */
export const SPLIT_DIVIDER_WIDTH = 4

/**
 * 比例存储键。v1 的值全部出自错位的分隔条（它掉在窗口底边，只能被误拖），
 * 不可信：读取时顺手清掉，让升级后的首次分屏回到均分。
 */
export const SPLIT_WIDTH_KEY = 'devkit:split-width:v2'
const LEGACY_SPLIT_WIDTH_KEYS = ['devkit:split-width:v1']

export function clampSplitPct(value: number): number {
  return Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, value))
}

/** 持久化的比例 → 左成员占比；缺失、非数值或越界都视为没有记忆值 */
export function parseSplitPct(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= SPLIT_MIN_PCT && value <= SPLIT_MAX_PCT ? value : null
}

/** 读取记忆的分屏比例（没有、无效或存储不可用 → 默认均分） */
export function readStoredSplitPct(getStorage: () => Storage | undefined = () => localStorage): number {
  try {
    const storage = getStorage()
    for (const key of LEGACY_SPLIT_WIDTH_KEYS) storage?.removeItem(key)
    return parseSplitPct(storage?.getItem(SPLIT_WIDTH_KEY) ?? null) ?? SPLIT_DEFAULT_PCT
  } catch {
    return SPLIT_DEFAULT_PCT
  }
}

export function writeStoredSplitPct(pct: number, getStorage: () => Storage | undefined = () => localStorage): void {
  try {
    getStorage()?.setItem(SPLIT_WIDTH_KEY, String(pct))
  } catch {
    /* 隐私模式等忽略 */
  }
}

/**
 * 内容区网格列：共享快捷命令栏 | 左成员 | 分隔条 | 右成员。
 * 共享栏那列是 auto——没有共享栏时不占宽度。两成员按比例分配扣除分隔条后的宽度，
 * 因此 50% 即严格均分（若按整宽取百分比，左成员恒比右成员宽一条分隔条）。
 */
export function splitGridColumns(pct: number): string {
  const left = clampSplitPct(pct)
  return `auto minmax(0, ${left}fr) ${SPLIT_DIVIDER_WIDTH}px minmax(0, ${100 - left}fr)`
}

/**
 * 指针相对内容区左边缘的位置 → 左成员占比（分隔条中心线跟随指针，保留一位小数）。
 * leadingWidth 是共享快捷命令栏占去的宽度，不参与两成员的比例分配。
 */
export function splitPctAtPointer(offsetX: number, viewWidth: number, leadingWidth = 0): number {
  const usable = viewWidth - leadingWidth - SPLIT_DIVIDER_WIDTH
  if (!(usable > 0)) return SPLIT_DEFAULT_PCT
  return clampSplitPct(Math.round(((offsetX - leadingWidth - SPLIT_DIVIDER_WIDTH / 2) / usable) * 1000) / 10)
}

// ---------- 分屏共享快捷命令栏的宽度与折叠 ----------

export const SPLIT_CMDS_KEY = 'devkit:split-quickcmds:v1'
/** 与各终端自带快捷命令栏相同的默认宽度 */
export const SPLIT_CMDS_DEFAULT_WIDTH = 210

export interface SplitCmdsPrefs {
  width: number
  hidden: boolean
}

/** 持久化的共享栏设置 → 有效字段；缺失或非法的字段不返回，由调用方取默认值 */
export function parseSplitCmdsPrefs(raw: string | null): Partial<SplitCmdsPrefs> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Partial<SplitCmdsPrefs> | null
    if (!value || typeof value !== 'object') return {}
    return {
      ...(typeof value.width === 'number' && Number.isFinite(value.width) ? { width: value.width } : {}),
      ...(typeof value.hidden === 'boolean' ? { hidden: value.hidden } : {})
    }
  } catch {
    return {}
  }
}

export function readSplitCmdsPrefs(getStorage: () => Storage | undefined = () => localStorage): Partial<SplitCmdsPrefs> {
  try {
    return parseSplitCmdsPrefs(getStorage()?.getItem(SPLIT_CMDS_KEY) ?? null)
  } catch {
    return {}
  }
}

export function writeSplitCmdsPrefs(prefs: SplitCmdsPrefs, getStorage: () => Storage | undefined = () => localStorage): void {
  try {
    getStorage()?.setItem(SPLIT_CMDS_KEY, JSON.stringify(prefs))
  } catch {
    /* 隐私模式等忽略 */
  }
}
