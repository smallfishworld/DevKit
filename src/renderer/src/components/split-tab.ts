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
