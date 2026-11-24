interface Point { x: number; y: number }
interface StripBounds { left: number; right: number; top: number; bottom: number }
interface TabBounds { id: string; left: number; right: number }

const START_DISTANCE = 6
const DETACH_DISTANCE = 24

export function tabDragStarted(start: Point, point: Point): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= START_DISTANCE
}

export function insideTabStrip(point: Point, strip: StripBounds, margin = 0): boolean {
  return point.x >= strip.left - margin && point.x <= strip.right + margin &&
    point.y >= strip.top - margin && point.y <= strip.bottom + margin
}

export function tabDragDestination(point: Point, strip: StripBounds): 'reorder' | 'detach' {
  return insideTabStrip(point, strip, DETACH_DISTANCE) ? 'reorder' : 'detach'
}

export function tabInsertion(tabs: TabBounds[], x: number): { id: string; side: 'before' | 'after' } | undefined {
  const candidates = tabs.filter((tab) => tab.id !== 'home')
  const before = candidates.find((tab) => x < (tab.left + tab.right) / 2)
  if (before) return { id: before.id, side: 'before' }
  const last = candidates.at(-1)
  if (last) return { id: last.id, side: 'after' }
  return undefined
}
