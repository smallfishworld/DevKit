import { defineStore } from 'pinia'
import type { SshParams } from '../../../shared/ssh'
import type { SerialParams } from '../../../shared/serial'
import type { ToolDef } from '@renderer/tools/registry'
import { reorderTabIds } from '@renderer/components/workbench-navigation'

export interface TabItem {
  id: string
  toolId: string
  title: string
  connection?: 'connected' | 'connecting' | 'disconnected'
  serialParams?: SerialParams
  sshParams?: Omit<SshParams, 'password'>
  shell?: { profileId: string; cwd: string }
}

const sessionTools = ['serial', 'ssh', 'local-terminal']
const RECENT_STORAGE_KEY = 'devkit:recent-sessions:v1'
const PINNED_STORAGE_KEY = 'devkit:pinned-tools:v1'

export const connectionLabels = { connected: '已连接', connecting: '连接中', disconnected: '未连接' }

let seq = 0

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value))
    }
  } catch {
    // 忽略隐私模式或配额异常
  }
}

function sanitizeRecent(raw: unknown): TabItem[] {
  if (!Array.isArray(raw)) return []
  const result: TabItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Partial<TabItem>
    if (typeof rec.id !== 'string' || typeof rec.toolId !== 'string' || typeof rec.title !== 'string') continue
    if (!sessionTools.includes(rec.toolId)) continue
    result.push({
      id: rec.id,
      toolId: rec.toolId,
      title: rec.title,
      connection: 'disconnected',
      serialParams: rec.serialParams,
      sshParams: rec.sshParams,
      shell: rec.shell
    })
    if (result.length >= 8) break
  }
  return result
}

function sanitizePinned(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return Array.from(new Set(raw.filter((item): item is string => typeof item === 'string' && item.length > 0)))
}

function persistRecent(list: TabItem[]): void {
  const payload = list.slice(0, 8).map((item) => ({
    id: item.id,
    toolId: item.toolId,
    title: item.title,
    connection: 'disconnected' as const,
    serialParams: item.serialParams,
    sshParams: item.sshParams,
    shell: item.shell
  }))
  writeStorage(RECENT_STORAGE_KEY, payload)
}

export const useTabStore = defineStore('tabs', {
  state: () => ({
    tabs: [{ id: 'home', toolId: 'home', title: '工具箱' }] as TabItem[],
    activeId: 'home',
    recent: sanitizeRecent(readStorage(RECENT_STORAGE_KEY, [])),
    pinnedTools: sanitizePinned(readStorage(PINNED_STORAGE_KEY, []))
  }),
  getters: {
    active(state): TabItem | undefined {
      return state.tabs.find((t) => t.id === state.activeId)
    },
    /** 统计每个 toolId 当前已打开的实例数量 */
    openCountByTool(state): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const tab of state.tabs) {
        if (tab.toolId === 'home') continue
        counts[tab.toolId] = (counts[tab.toolId] ?? 0) + 1
      }
      return counts
    },
    /** 当前处于 connected 状态的会话列表 */
    connectedSessions(state): TabItem[] {
      return state.tabs.filter((t) => t.connection === 'connected')
    }
  },
  actions: {
    openTool(tool: ToolDef, previous?: TabItem): void {
      if (tool.singleton) {
        const existing = this.tabs.find((t) => t.toolId === tool.id)
        if (existing) {
          this.activeId = existing.id
          return
        }
      }
      seq += 1
      const id = `${tool.id}#${seq}`
      const tab: TabItem = {
        id,
        toolId: tool.id,
        title: previous?.title ?? tool.name,
        serialParams: previous?.serialParams,
        sshParams: previous?.sshParams,
        shell: previous?.shell
      }
      if (previous) this.recent = this.recent.filter((entry) => entry.id !== previous.id)
      this.tabs.push(tab)
      this.remember(tab)
      this.activeId = id
    },
    activate(id: string): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab) return
      this.activeId = id
      this.remember(tab)
    },
    remember(tab: TabItem): void {
      if (!sessionTools.includes(tab.toolId)) return
      this.recent = [{ ...tab }, ...this.recent.filter((entry) => entry.id !== tab.id)].slice(0, 8)
      persistRecent(this.recent)
    },
    removeRecent(id: string): void {
      this.recent = this.recent.filter((entry) => entry.id !== id)
      persistRecent(this.recent)
    },
    clearRecent(): void {
      this.recent = []
      persistRecent(this.recent)
    },
    togglePin(toolId: string): void {
      if (this.pinnedTools.includes(toolId)) {
        this.pinnedTools = this.pinnedTools.filter((id) => id !== toolId)
      } else {
        this.pinnedTools = [...this.pinnedTools, toolId]
      }
      writeStorage(PINNED_STORAGE_KEY, this.pinnedTools)
    },
    setConnection(
      id: string,
      connection: NonNullable<TabItem['connection']>,
      session?: Pick<TabItem, 'serialParams' | 'sshParams' | 'shell'>
    ): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab) return
      tab.connection = connection
      if (session) Object.assign(tab, session)
      const entry = this.recent.find((item) => item.id === id)
      if (entry) {
        Object.assign(entry, tab)
        persistRecent(this.recent)
      }
    },
    /** 拖拽排序：把 id 移动到 toId 的前/后位置（浏览器式换序）。home 恒为第一个，不可移入其前 */
    moveTab(id: string, toId: string, position: 'before' | 'after' = 'before'): void {
      const nextIds = reorderTabIds(this.tabs.map((t) => t.id), id, toId, position)
      const map = new Map(this.tabs.map((t) => [t.id, t]))
      this.tabs = nextIds.map((tabId) => map.get(tabId)!).filter(Boolean)
    },
    /** 面板重命名自身标签（如串口助手 → COM5@115200；SSH → root@10.0.0.1） */
    rename(id: string, title: string): void {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab || !title || tab.id === 'home') return
      tab.title = title
      const entry = this.recent.find((item) => item.id === id)
      if (entry) {
        entry.title = title
        persistRecent(this.recent)
      }
    },
    close(id: string): void {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx < 0 || id === 'home') return
      const [tab] = this.tabs.splice(idx, 1)
      if (tab.serialParams || tab.sshParams || tab.shell) {
        this.remember({ ...tab, connection: 'disconnected' })
      } else {
        this.recent = this.recent.filter((entry) => entry.id !== id)
        persistRecent(this.recent)
      }
      // 通知主进程清理该面板资源（停止钩子、关闭端口等）
      window.api?.invoke(tab.toolId, 'dispose', tab.id).catch(() => {})
      if (this.activeId === id) {
        this.activeId = this.tabs[Math.max(0, idx - 1)].id
      }
    },
    closeOthers(keepId: string): void {
      const targets = this.tabs.filter((t) => t.id !== 'home' && t.id !== keepId).map((t) => t.id)
      for (const id of targets) this.close(id)
      if (this.tabs.some((t) => t.id === keepId)) this.activeId = keepId
    },
    closeRight(anchorId: string): void {
      const idx = this.tabs.findIndex((t) => t.id === anchorId)
      if (idx < 0) return
      const targets = this.tabs.slice(idx + 1).map((t) => t.id)
      for (const id of targets) this.close(id)
    },
    closeAll(): void {
      const targets = this.tabs.filter((t) => t.id !== 'home').map((t) => t.id)
      for (const id of targets) this.close(id)
      this.activeId = 'home'
    },
    /** 恢复最近关闭的一个未打开会话（Ctrl+Shift+T） */
    reopenLastClosed(resolver: (toolId: string) => ToolDef | undefined): boolean {
      const openIds = new Set(this.tabs.map((t) => t.id))
      const candidate = this.recent.find((entry) => !openIds.has(entry.id))
      if (!candidate) return false
      const tool = resolver(candidate.toolId)
      if (!tool) return false
      this.openTool(tool, candidate)
      return true
    }
  }
})
