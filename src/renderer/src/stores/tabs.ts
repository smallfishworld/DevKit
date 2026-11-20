import { defineStore } from 'pinia'
import type { SshParams } from '../../../shared/ssh'
import type { SerialParams } from '../../../shared/serial'
import type { ToolDef } from '@renderer/tools/registry'

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
export const connectionLabels = { connected: '已连接', connecting: '连接中', disconnected: '未连接' }

let seq = 0

export const useTabStore = defineStore('tabs', {
  state: () => ({
    tabs: [{ id: 'home', toolId: 'home', title: '工具箱' }] as TabItem[],
    activeId: 'home',
    recent: [] as TabItem[]
  }),
  getters: {
    active(state): TabItem | undefined {
      return state.tabs.find((t) => t.id === state.activeId)
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
        id, toolId: tool.id, title: previous?.title ?? tool.name,
        serialParams: previous?.serialParams, sshParams: previous?.sshParams, shell: previous?.shell
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
    },
    setConnection(id: string, connection: NonNullable<TabItem['connection']>,
      session?: Pick<TabItem, 'serialParams' | 'sshParams' | 'shell'>): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab) return
      tab.connection = connection
      if (session) Object.assign(tab, session)
      const entry = this.recent.find((item) => item.id === id)
      if (entry) Object.assign(entry, tab)
    },
    /** 拖拽排序：把 id 移动到 toId 的位置（浏览器式换序）。home 恒为第一个，不可移入其前 */
    moveTab(id: string, toId: string): void {
      if (id === toId || id === 'home' || toId === 'home') return
      const from = this.tabs.findIndex((t) => t.id === id)
      const to = this.tabs.findIndex((t) => t.id === toId)
      if (from < 0 || to < 0) return
      const [tab] = this.tabs.splice(from, 1)
      const insertAt = this.tabs.findIndex((t) => t.id === toId)
      this.tabs.splice(insertAt, 0, tab)
    },
    /** 面板重命名自身标签（如串口助手 → COM5@115200；SSH → root@10.0.0.1） */
    rename(id: string, title: string): void {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab || !title || tab.id === 'home') return
      tab.title = title
      const entry = this.recent.find((item) => item.id === id)
      if (entry) entry.title = title
    },
    close(id: string): void {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx < 0 || id === 'home') return
      const [tab] = this.tabs.splice(idx, 1)
      if (tab.serialParams || tab.sshParams || tab.shell) this.remember({ ...tab, connection: 'disconnected' })
      else this.recent = this.recent.filter((entry) => entry.id !== id)
      // 通知主进程清理该面板资源（停止钩子、关闭端口等）
      window.api?.invoke(tab.toolId, 'dispose', tab.id).catch(() => {})
      if (this.activeId === id) {
        this.activeId = this.tabs[Math.max(0, idx - 1)].id
      }
    }
  }
})
