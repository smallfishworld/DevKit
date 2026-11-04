import type { Terminal } from '@xterm/xterm'
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'

/** Output requests share one deadline. Continued output must not postpone it. */
export class LiveSearchRefresh {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private refresh: () => void, private delay = 500) {}

  request(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refresh()
    }, this.delay)
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** Use public addon APIs to rebuild decorations without navigating or replacing
 * a user's selection. The addon's own output debounce can otherwise starve.
 */
export function refreshSearchHighlights(terminal: Terminal, addon: SearchAddon, keyword: string, options: ISearchOptions): void {
  if (!keyword) return
  const viewport = terminal.buffer.active.viewportY
  const select = terminal.select
  const clearSelection = terminal.clearSelection
  terminal.select = () => {}
  terminal.clearSelection = () => {}
  try {
    addon.clearDecorations()
    addon.findPrevious(keyword, { ...options, incremental: true })
  } finally {
    terminal.select = select
    terminal.clearSelection = clearSelection
    if (terminal.buffer.active.viewportY !== viewport) terminal.scrollToLine(viewport)
  }
}
