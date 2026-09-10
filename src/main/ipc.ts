import { BrowserWindow, ipcMain } from 'electron'
import type { ToolEvent, ToolInvoke } from '../shared/types'

export interface ToolService {
  /** 处理渲染进程调用 */
  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown
  /** 面板关闭时清理资源（停止钩子/关闭端口等），不需要服务参与时可空实现 */
  dispose?(panelId: string): void
}

const services = new Map<string, ToolService>()
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function registerService(tool: string, service: ToolService): void {
  services.set(tool, service)
}

/** 服务向渲染进程发事件 */
export function emitToolEvent(tool: string, panelId: string, type: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const ev: ToolEvent = { tool, panelId, type, payload }
  mainWindow.webContents.send('tool:event', ev)
}

export function registerToolIpc(): void {
  ipcMain.handle('tool:invoke', async (_event, req: ToolInvoke) => {
    const { tool, panelId, action, payload } = req
    const service = services.get(tool)
    if (!service) {
      // dispose 宽松处理：纯前端工具（如计算器）没有后端服务
      if (action === 'dispose') return true
      throw new Error(`未知工具服务: ${tool}`)
    }
    if (action === 'dispose') {
      service.dispose?.(panelId)
      return true
    }
    return await service.invoke(panelId, action, payload)
  })
}

export function disposeAllPanels(): void {
  for (const service of services.values()) service.dispose?.('*')
}
