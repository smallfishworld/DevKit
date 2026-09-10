import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ToolEvent, WinInfo } from '../shared/types'

const api = {
  invoke(tool: string, action: string, panelId: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke('tool:invoke', { tool, action, panelId, payload })
  },
  /** 拖放文件路径（Electron 移除 File.path 后唯一可靠途径；仅本机拖入的文件有效） */
  dragPath(file: File): string {
    return webUtils.getPathForFile(file)
  },
  on(
    tool: string,
    panelId: string,
    type: string,
    listener: (payload: unknown) => void
  ): () => void {
    const wrapped = (_event: IpcRendererEvent, ev: ToolEvent): void => {
      if (ev.tool === tool && ev.panelId === panelId && ev.type === type) listener(ev.payload)
    }
    ipcRenderer.on('tool:event', wrapped as never)
    return () => ipcRenderer.removeListener('tool:event', wrapped as never)
  },
  /** 无边框窗口：窗口控制 + 版本信息（自绘标题栏用） */
  win: {
    minimize(): void {
      ipcRenderer.send('win:minimize')
    },
    toggleMaximize(): void {
      ipcRenderer.send('win:toggle-maximize')
    },
    close(): void {
      ipcRenderer.send('win:close')
    },
    info(): Promise<WinInfo> {
      return ipcRenderer.invoke('win:info')
    },
    onMaxChange(cb: (maximized: boolean) => void): () => void {
      const wrapped = (_e: IpcRendererEvent, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('win:maximized', wrapped as never)
      return () => ipcRenderer.removeListener('win:maximized', wrapped as never)
    },
    readClipboard(): Promise<string> {
      return ipcRenderer.invoke('win:clipboard-read')
    },
    writeClipboard(text: string): Promise<boolean> {
      return ipcRenderer.invoke('win:clipboard-write', text)
    }
  }
}

export type DevKitApi = typeof api

contextBridge.exposeInMainWorld('api', api)
