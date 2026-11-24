import { defineStore } from 'pinia'
import type { SshParams } from '../../../shared/ssh'
import type { SerialParams } from '../../../shared/serial'
import type { ToolDef } from '@renderer/tools/registry'
import { dedupeRecent, sessionIdentity } from '@renderer/components/session-identity'
import { hostSharesQuickCmds, planMerge, readStoredSplitPct, splitTabTitle, type MergePlan } from '@renderer/components/split-tab'
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

/** 合并分屏标签：两个成员面板并排显示在同一个标签内（标题合并、单 X） */
export interface SplitTab {
  id: string
  kind: 'split'
  members: TabItem[]
  splitPct: number
}

/** 标签条条目：普通工具标签 或 合并分屏标签 */
export type WorkTab = TabItem | SplitTab

export function tabIsSplit(tab: WorkTab): tab is SplitTab {
  return (tab as { kind?: string }).kind === 'split'
}

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
    if (rec.toolId === 'home') continue
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
  // 历史数据可能因旧版按 tab id 去重而含重复身份（如同名 COM1），按身份去重清洗
  return dedupeRecent(result)
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

/** 按标签 id 查找条目：命中宿主（普通标签或分屏标签）或分屏成员，返回宿主与成员（分屏宿主自身无成员） */
function findEntry(tabs: WorkTab[], id: string): { host: WorkTab; member?: TabItem } | undefined {
  for (const tab of tabs) {
    if (tab.id === id) return { host: tab, member: tabIsSplit(tab) ? undefined : tab }
    if (tabIsSplit(tab)) {
      const member = tab.members.find((m) => m.id === id)
      if (member) return { host: tab, member }
    }
  }
  return undefined
}

export const useTabStore = defineStore('tabs', {
  state: () => ({
    tabs: [{ id: 'home', toolId: 'home', title: '工具箱' }] as WorkTab[],
    detachedIds: [] as string[],
    activeId: 'home',
    recent: sanitizeRecent(readStorage(RECENT_STORAGE_KEY, [])),
    pinnedTools: sanitizePinned(readStorage(PINNED_STORAGE_KEY, []))
  }),
  getters: {
    workbenchTabs(state): WorkTab[] {
      return state.tabs.filter((tab) => !state.detachedIds.includes(tab.id))
    },
    hostId(state): (id: string) => string | undefined {
      return (id: string) => findEntry(state.tabs, id)?.host.id
    },
    active(state): WorkTab | undefined {
      return state.tabs.find((t) => t.id === state.activeId)
    },
    /** 状态栏标题：合并分屏标签显示 "A | B" */
    activeTitle(state): string {
      const tab = state.tabs.find((t) => t.id === state.activeId)
      if (!tab) return 'DevKit'
      return tabIsSplit(tab) ? splitTabTitle(tab.members) : tab.title
    },
    /** 焦点条目的 toolId（分屏条目无单一 toolId，返回 undefined） */
    activeToolId(state): string | undefined {
      const tab = state.tabs.find((t) => t.id === state.activeId)
      return tab && !tabIsSplit(tab) ? tab.toolId : undefined
    },
    /** 按 id 查会话标签（普通标签或分屏成员），供面板读取自身参数 */
    sessionById(state): (id: string) => TabItem | undefined {
      return (id: string) => findEntry(state.tabs, id)?.member
    },
    /** 该会话当前是否显示在内容区：自身条目激活，或所在分屏条目激活 */
    sessionVisible(state): (id: string) => boolean {
      return (id: string) => {
        const host = findEntry(state.tabs, id)?.host.id
        return !!host && (host === state.activeId || state.detachedIds.includes(host))
      }
    },
    /** 该面板是否处在「两个终端共用一条快捷命令栏」的分屏里（是则不再显示自带的命令栏） */
    sharesQuickCmds(state): (id: string) => boolean {
      return (id: string) => hostSharesQuickCmds(findEntry(state.tabs, id)?.host)
    },
    /**
     * 内容区常驻的面板（home 也在内），分屏条目展开为成员。
     * 合并/拆分只是把这些面板重新排列（成员相邻落位），集合不变；
     * 内容区按面板 id 复用，实例不重建（面板一卸载就会 dispose 掉连接）。
     */
    panelHosts(state): TabItem[] {
      return state.tabs.flatMap((t) => (tabIsSplit(t) ? t.members : [t]))
    },
    /** 全部会话标签（含分屏成员），供启动器/统计使用 */
    flatSessions(): TabItem[] {
      return this.panelHosts.filter((t) => t.id !== 'home')
    },
    /** 统计每个 toolId 当前已打开的实例数量 */
    openCountByTool(state): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const tab of this.flatSessions) {
        counts[tab.toolId] = (counts[tab.toolId] ?? 0) + 1
      }
      return counts
    },
    /** 当前处于 connected 状态的会话列表 */
    connectedSessions(state): TabItem[] {
      return this.flatSessions.filter((t) => t.connection === 'connected')
    }
  },
  actions: {
    markDetached(id: string): boolean {
      const index = this.workbenchTabs.findIndex((tab) => tab.id === id)
      if (id === 'home' || index < 0) return false
      const next = this.workbenchTabs[index - 1] ?? this.workbenchTabs[index + 1]
      this.detachedIds.push(id)
      if (this.activeId === id) this.activeId = next?.id ?? 'home'
      return true
    },
    markAttached(id: string): void {
      this.detachedIds = this.detachedIds.filter((item) => item !== id)
    },
    openTool(tool: ToolDef, previous?: TabItem): void {
      if (tool.singleton) {
        // 单例只此一份：已开实例即使正待在分屏里也复用（激活其所在条目）
        const existing = this.flatSessions.find((t) => t.toolId === tool.id)
        if (existing) {
          this.activate(existing.id)
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
    /**
     * 合并分屏：把 anchor 与 joiner（已有会话标签或新开工具）合并成一个分屏标签。
     * entry.tabId 指定已有会话；entry.tool 指定新开工具（单例复用已有实例）。
     */
    mergeIntoSplit(anchorId: string, entry: { tool?: ToolDef; tabId?: string }): boolean {
      const anchor = this.workbenchTabs.find((t) => t.id === anchorId)
      if (!anchor || tabIsSplit(anchor) || anchor.id === 'home') return false
      let joiner: TabItem | undefined
      if (entry.tabId) {
        // 已开会话：独立标签或别的分屏里的成员都行（分屏条目自身不可并入）
        joiner = findEntry(this.workbenchTabs, entry.tabId)?.member
        if (!joiner || joiner.id === 'home') return false
      } else if (entry.tool) {
        const tool = entry.tool
        // 单例工具只此一份：已开实例（哪怕是别的分屏的成员）挪用，没有才新开
        const existing = tool.singleton ? this.flatSessions.find((t) => t.toolId === tool.id) : undefined
        if (existing) joiner = existing
        else {
          seq += 1
          joiner = { id: `${tool.id}#${seq}`, toolId: tool.id, title: tool.name }
        }
      } else {
        return false
      }
      if (!joiner || joiner.id === anchorId) return false
      const hostId = this.hostId(joiner.id)
      if (hostId && this.detachedIds.includes(hostId)) {
        this.activate(joiner.id)
        return false
      }
      if (!this.tabs.some((t) => t.id === joiner!.id)) {
        // 目标还不是独立标签：新开实例插到锚点之后；别的分屏里的成员则从原分屏摘出，
        // 原分屏剩下的成员顶替它留在原位。两步之后才能走统一的合并计划
        const host = this.tabs.find((t) => tabIsSplit(t) && t.members.some((m) => m.id === joiner!.id))
        if (host && tabIsSplit(host)) {
          this.tabs.splice(
            this.tabs.indexOf(host),
            1,
            ...host.members.filter((m) => m.id !== joiner!.id),
            joiner
          )
        } else {
          this.tabs.splice(this.tabs.indexOf(anchor) + 1, 0, joiner)
        }
      }
      const plan: MergePlan | null = planMerge(this.tabs.map((t) => t.id), anchorId, joiner.id)
      if (!plan) return false
      const first = plan.firstId === anchorId ? (anchor as TabItem) : joiner
      const second = plan.firstId === anchorId ? joiner : (anchor as TabItem)
      const rest = this.tabs.filter((t) => t.id !== anchorId && t.id !== joiner.id)
      seq += 1
      const split: SplitTab = { id: `split#${seq}`, kind: 'split', members: [first, second], splitPct: readStoredSplitPct() }
      rest.splice(Math.min(plan.index, rest.length), 0, split)
      this.tabs = rest
      this.activate(split.id)
      return true
    },
    resizeSplit(id: string, pct: number): void {
      const split = findEntry(this.tabs, id)?.host
      if (split && tabIsSplit(split)) split.splitPct = pct
    },
    /** 拆分：把分屏标签的成员还原为独立标签（不销毁面板与连接） */
    unsplit(splitId: string): boolean {
      if (this.detachedIds.includes(splitId)) return false
      const idx = this.tabs.findIndex((t) => t.id === splitId)
      if (idx < 0) return false
      const tab = this.tabs[idx]
      if (!tabIsSplit(tab)) return false
      this.tabs.splice(idx, 1, ...tab.members)
      this.activate(tab.members[0].id)
      return true
    },
    /** 激活：id 可以是普通标签、分屏标签或分屏成员（激活其宿主） */
    activate(id: string): void {
      const entry = findEntry(this.tabs, id)
      if (!entry) return
      if (this.detachedIds.includes(entry.host.id)) return
      this.activeId = entry.host.id
      if (tabIsSplit(entry.host)) {
        entry.host.members.forEach((m) => this.remember(m))
      } else if (entry.member) {
        this.remember(entry.member)
      }
    },
    remember(tab: TabItem): void {
      if (tab.toolId === 'home') return
      const key = sessionIdentity(tab)
      // 同身份（同串口/主机/目录）只留一条，且以最新一次的参数与 tab id 为准
      this.recent = [
        { ...tab },
        ...this.recent.filter((entry) => entry.id !== tab.id && sessionIdentity(entry) !== key)
      ].slice(0, 8)
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
      const entry = findEntry(this.tabs, id)
      const tab = entry?.member
      if (!tab) return
      tab.connection = connection
      if (session) Object.assign(tab, session)
      const rec = this.recent.find((item) => item.id === id)
      if (rec) {
        Object.assign(rec, tab)
        persistRecent(this.recent)
      }
    },
    /** 拖拽排序：条目（普通标签或分屏标签整体）移动到目标前/后。home 恒为第一个 */
    moveTab(id: string, toId: string, position: 'before' | 'after' = 'before'): void {
      if (id === 'home' || toId === 'home' || id === toId) return
      const order = reorderTabIds(this.tabs.map((t) => t.id), id, toId, position)
      const map = new Map(this.tabs.map((t) => [t.id, t as WorkTab]))
      this.tabs = order.map((tid) => map.get(tid)!).filter(Boolean)
    },
    /** 面板重命名自身标签（如串口助手 → COM5@115200；SSH → root@10.0.0.1） */
    rename(id: string, title: string): void {
      if (!title) return
      const entry = findEntry(this.tabs, id)
      const tab = entry?.member
      if (!tab || tab.id === 'home') return
      tab.title = title
      const rec = this.recent.find((item) => item.id === id)
      if (rec) {
        rec.title = title
        persistRecent(this.recent)
      }
    },
    /** 关闭一个面板：记入最近使用，并通知主进程清理资源（停止钩子、关闭端口等） */
    release(tab: TabItem): void {
      // 任何工具关闭都记入最近使用（非会话工具无连接概念，恒为 disconnected）
      this.remember({ ...tab, connection: tab.serialParams || tab.sshParams || tab.shell ? 'disconnected' : undefined })
      window.api?.invoke(tab.toolId, 'dispose', tab.id).catch(() => {})
    },
    /** 关闭条目：普通标签关闭自身；分屏标签关闭并释放全部成员面板 */
    close(id: string): void {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx < 0 || id === 'home') return
      const [tab] = this.tabs.splice(idx, 1)
      this.markAttached(id)
      const members = tabIsSplit(tab) ? tab.members : [tab]
      members.forEach((m) => this.release(m))
      if (this.activeId === id) {
        const visible = (item: WorkTab) => !this.detachedIds.includes(item.id)
        const fallback = this.tabs.slice(0, idx).findLast(visible) ?? this.tabs.slice(idx).find(visible)
        this.activeId = fallback?.id ?? 'home'
      }
    },
    /**
     * 关闭分屏的一侧（side：0 左 / 1 右）：该成员释放，另一侧原地成为独立标签
     * （面板与连接不受影响；分屏正显示时接着显示留下的一侧）。
     */
    closeSplitSide(id: string, side: 0 | 1): boolean {
      if (this.detachedIds.includes(id)) return false
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab || !tabIsSplit(tab)) return false
      const kept = tab.members[side === 0 ? 1 : 0]
      if (!kept) return false
      this.release(tab.members[side])
      this.tabs.splice(this.tabs.indexOf(tab), 1, kept)
      if (this.activeId === id) this.activate(kept.id)
      return true
    },
    closeOthers(keepId: string): void {
      const targets = this.workbenchTabs.filter((t) => t.id !== 'home' && t.id !== keepId).map((t) => t.id)
      for (const id of targets) this.close(id)
      if (this.tabs.some((t) => t.id === keepId)) this.activate(keepId)
    },
    closeRight(anchorId: string): void {
      const anchorIdx = this.workbenchTabs.findIndex((t) => t.id === anchorId)
      if (anchorIdx < 0) return
      const targets = this.workbenchTabs.slice(anchorIdx + 1).map((t) => t.id)
      for (const id of targets) this.close(id)
    },
    closeAll(): void {
      const targets = this.workbenchTabs.filter((t) => t.id !== 'home').map((t) => t.id)
      for (const id of targets) this.close(id)
      this.activeId = 'home'
    },
    /** 恢复最近关闭的一个未打开会话（Ctrl+Shift+T） */
    reopenLastClosed(resolver: (toolId: string) => ToolDef | undefined): boolean {
      const openIds = new Set(this.flatSessions.map((t) => t.id))
      const candidate = this.recent.find((entry) => !openIds.has(entry.id))
      if (!candidate) return false
      const tool = resolver(candidate.toolId)
      if (!tool) return false
      this.openTool(tool, candidate)
      return true
    }
  }
})
