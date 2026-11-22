export function launcherIndex(index: number, direction: 1 | -1, count: number): number {
  return count ? (index + direction + count) % count : 0
}

export function matchesTool(query: string, ...fields: string[]): boolean {
  return query.trim().toLowerCase().split(/\s+/).every((term) =>
    fields.some((field) => field.toLowerCase().includes(term))
  )
}

/**
 * 浏览器式拖拽换序：将 fromId 移动到 toId 的前/后位置。
 * 'home' 恒固定在首位，不可被拖动，也不可将其他标签插入其前。
 */
export function reorderTabIds(
  ids: readonly string[],
  fromId: string,
  toId: string,
  position: 'before' | 'after' = 'before'
): string[] {
  if (fromId === toId || fromId === 'home' || toId === 'home') return [...ids]
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0) return [...ids]

  const next = [...ids]
  const [moved] = next.splice(from, 1)
  const targetIdx = next.indexOf(toId)
  if (targetIdx < 0) return [...ids]

  const insertAt = position === 'after' ? targetIdx + 1 : Math.max(1, targetIdx)
  next.splice(insertAt, 0, moved)
  return next
}

/** Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签 */
export function cycleTabId(ids: readonly string[], activeId: string, direction: 1 | -1): string | undefined {
  if (!ids.length) return undefined
  const idx = ids.indexOf(activeId)
  if (idx < 0) return ids[0]
  return ids[(idx + direction + ids.length) % ids.length]
}

/** Ctrl+1~9 快捷键跳转：1~8 对应前 8 个标签，9 对应最后一个标签 */
export function tabIdByDigit(ids: readonly string[], digit: number): string | undefined {
  if (!ids.length || !Number.isInteger(digit) || digit < 1 || digit > 9) return undefined
  if (digit === 9) return ids[ids.length - 1]
  return ids[digit - 1]
}
