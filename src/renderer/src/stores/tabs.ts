import { defineStore } from 'pinia'
import type { ToolDef } from '@renderer/tools/registry'

export interface TabItem {
  id: string
  toolId: string
  title: string
}

let seq = 0

export const useTabStore = defineStore('tabs', {
  state: () => ({
    tabs: [{ id: 'home', toolId: 'home', title: '工具箱' }] as TabItem[],
    activeId: 'home'
  }),
  getters: {
    active(state): TabItem | undefined {
      return state.tabs.find((t) => t.id === state.activeId)
    }
  },
  actions: {
    openTool(tool: ToolDef): void {
      if (tool.singleton) {
        const existing = this.tabs.find((t) => t.toolId === tool.id)
        if (existing) {
          this.activeId = existing.id
          return
        }
      }
      seq += 1
      const id = `${tool.id}#${seq}`
      this.tabs.push({ id, toolId: tool.id, title: tool.name })
      this.activeId = id
    },
    activate(id: string): void {
      this.activeId = id
    },
    /** 面板重命名自身标签（如串口助手 → COM5@115200；SSH → root@10.0.0.1） */
    rename(id: string, title: string): void {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab && title && tab.id !== 'home') tab.title = title
    },
    close(id: string): void {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx < 0 || id === 'home') return
      const [tab] = this.tabs.splice(idx, 1)
      // 通知主进程清理该面板资源（停止钩子、关闭端口等）
      window.api?.invoke(tab.toolId, 'dispose', tab.id).catch(() => {})
      if (this.activeId === id) {
        this.activeId = this.tabs[Math.max(0, idx - 1)].id
      }
    }
  }
})
