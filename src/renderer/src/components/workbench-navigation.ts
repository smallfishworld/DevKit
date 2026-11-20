export function launcherIndex(index: number, direction: 1 | -1, count: number): number {
  return count ? (index + direction + count) % count : 0
}

export function matchesTool(query: string, ...fields: string[]): boolean {
  return query.trim().toLowerCase().split(/\s+/).every((term) =>
    fields.some((field) => field.toLowerCase().includes(term))
  )
}
