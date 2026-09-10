/**
 * 文件夹对齐（Beyond Compare 双栏树）：扁平 FolderEntry[] → 树 → 可见行序列
 * 纯逻辑，无 IPC / DOM 依赖，可独立测试
 */
import type { FolderEntry, FolderStatus } from '../../../../shared/diff'

export interface FolderNode {
  /** rel 路径（目录含末尾斜杠风格见 buildTree；文件为原 rel） */
  key: string
  name: string
  depth: number
  isDir: boolean
  status: FolderStatus
  /** 文件行的原始条目（操作/路径解析用）；目录行为空 */
  entry?: FolderEntry
  children?: FolderNode[]
}

/** 构建 BC 风格树：目录在前（按名排序）、文件在后（按名排序），depth = 路径段数 */
export function buildTree(entries: FolderEntry[]): FolderNode[] {
  // 目录集：entries 中 isDir 条目，status 用其扫描结果
  const dirs = new Map<string, { status: FolderStatus }>()
  for (const e of entries) {
    if (e.isDir) dirs.set(e.rel, { status: e.status })
  }
  // 文件按 parent 分组
  const filesByParent = new Map<string, FolderEntry[]>()
  const dirParents = new Set<string>() // 隐含父目录（文件路径的前缀段）
  for (const e of entries) {
    if (e.isDir) continue
    const slash = e.rel.lastIndexOf('/')
    const parent = slash < 0 ? '' : e.rel.slice(0, slash)
    const list = filesByParent.get(parent) ?? []
    list.push(e)
    filesByParent.set(parent, list)
    // 补全隐含父目录链（两侧文件都在的目录即使没有 dir 条目也要出现）
    let p = parent
    while (p && !dirs.has(p)) {
      dirParents.add(p)
      const up = p.lastIndexOf('/')
      p = up < 0 ? '' : p.slice(0, up)
    }
  }
  // 合并目录集：显式 dir 条目 + 隐含父目录
  const allDirs = new Map<string, { status: FolderStatus }>(dirs)
  for (const p of dirParents) if (!allDirs.has(p)) allDirs.set(p, { status: 'dir' })

  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name)

  function children(parent: string, depth: number): FolderNode[] {
    const prefix = parent ? `${parent}/` : ''
    // 直接子目录
    const subDirs: FolderNode[] = []
    for (const [rel, d] of allDirs) {
      if (!rel.startsWith(prefix)) continue
      const rest = rel.slice(prefix.length)
      if (rest.includes('/')) continue // 非直接子级
      subDirs.push({
        key: rel,
        name: rest,
        depth,
        isDir: true,
        status: d.status,
        children: children(rel, depth + 1)
      })
    }
    subDirs.sort((a, b) => byName(a, b))
    // 直接文件
    const files = (filesByParent.get(parent) ?? []).map((e) => ({
      key: e.rel,
      name: e.rel.slice(prefix.length),
      depth,
      isDir: false,
      status: e.status,
      entry: e
    }))
    files.sort((a, b) => byName(a, b))
    return [...subDirs, ...files]
  }

  return children('', 0)
}

/**
 * 展平为可见行序列。
 * onlyDiff=true 时：只保留「自身或子树含差异（differ/only-left/only-right）」的路径，
 * 且差异子树强制展开（保留祖先用于定位）。
 */
export function flattenTree(
  roots: FolderNode[],
  collapsed: Set<string>,
  onlyDiff: boolean
): FolderNode[] {
  const out: FolderNode[] = []

  function subtreeHasDiff(n: FolderNode): boolean {
    if (!n.isDir) return n.status === 'differ' || n.status === 'only-left' || n.status === 'only-right'
    return (n.children ?? []).some(subtreeHasDiff)
  }

  function walk(list: FolderNode[], forceExpand: boolean): void {
    for (const n of list) {
      if (onlyDiff && !subtreeHasDiff(n)) continue
      out.push(n)
      if (n.isDir) {
        // onlyDiff 下含差异的子树强制展开；普通下尊重折叠
        const expand = forceExpand || !collapsed.has(n.key)
        if (expand) walk(n.children ?? [], onlyDiff)
      }
    }
  }
  walk(roots, false)
  return out
}

/** 折叠目录的可见子孙数（用于折叠行 +N 徽标） */
export function countDescendants(n: FolderNode): number {
  if (!n.isDir) return 0
  let c = 0
  for (const ch of n.children ?? []) {
    c += 1 + countDescendants(ch)
  }
  return c
}