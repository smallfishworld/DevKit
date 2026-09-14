/**
 * TFTP 工具服务：每个面板可启动独立实例（不同端口/根目录/绑定 IP），panelId 即实例键
 */
import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import { getSection, setSection } from '../macro/configStore'
import { TftpServer, type TransferInfo } from './server'

interface StartPayload {
  port: number
  root?: string
  /** 绑定的本机 IPv4；空或 0.0.0.0 表示全部网卡 */
  address?: string
}

interface TftpConfig {
  port: number
  root: string
  address: string
}

export function defaultTftpRoot(): string {
  return join(app.getPath('documents'), 'DevKit-TFTP')
}

function defaultConfig(): TftpConfig {
  return { port: 69, root: defaultTftpRoot(), address: '0.0.0.0' }
}

/** 列出本机全部 IPv4 地址（供面板下拉选择绑定 IP） */
function listIPv4(): Array<{ address: string; name: string }> {
  const out: Array<{ address: string; name: string }> = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, name })
    }
  }
  return out
}

class TftpService implements ToolService {
  private servers = new Map<string, TftpServer>()

  private bindEvents(panelId: string, server: TftpServer): void {
    const send = (type: string, payload: unknown): void => {
      emitToolEvent('tftp', panelId, type, payload)
    }
    server.on('log', (line: string) => send('log', { line, time: Date.now() }))
    server.on('transfer-start', (info: TransferInfo) => send('transfer', info))
    server.on('transfer-progress', (info: TransferInfo) => send('transfer', info))
    server.on('transfer-done', (info: TransferInfo) => send('transfer', info))
  }

  invoke(panelId: string, action: string, payload: unknown): unknown {
    switch (action) {
      case 'default-root':
        return { root: defaultTftpRoot() }
      case 'list-ips':
        return { ips: listIPv4() }
      case 'config:get':
        return getSection<TftpConfig>('tftp', defaultConfig())
      case 'config:set':
        return setSection('tftp', payload).then(() => ({ ok: true }))
      case 'pick-dir':
        void dialog
          .showOpenDialog({
            title: '选择 TFTP 根目录',
            properties: ['openDirectory', 'createDirectory']
          })
          .then(({ canceled, filePaths }) => {
            if (!canceled && filePaths[0]) {
              emitToolEvent('tftp', panelId, 'dir-picked', { root: filePaths[0] })
            }
          })
        return { pending: true }
      case 'open-dir': {
        const { root } = payload as { root: string }
        void shell.openPath(root)
        return { ok: true }
      }
      case 'start': {
        const { port, root, address } = payload as StartPayload
        if (this.servers.get(panelId)?.running) return { ok: false, error: '已在运行' }
        const server = new TftpServer()
        this.bindEvents(panelId, server)
        const realRoot = root && root.trim() ? root : defaultTftpRoot()
        const addr = address && address.trim() ? address : '0.0.0.0'
        return server
          .start(port, realRoot, addr)
          .then(() => {
            this.servers.set(panelId, server)
            return { ok: true, root: realRoot, port, address: server.address }
          })
          .catch((err: Error) => {
            return { ok: false, error: err.message }
          })
      }
      case 'stop': {
        const server = this.servers.get(panelId)
        server?.stop()
        this.servers.delete(panelId)
        return { ok: true }
      }
      case 'status': {
        const server = this.servers.get(panelId)
        return {
          running: server?.running ?? false,
          port: server?.port ?? 0,
          address: server?.address ?? ''
        }
      }
      default:
        throw new Error(`tftp 服务未知操作: ${action}`)
    }
  }

  dispose(panelId: string): void {
    const server = this.servers.get(panelId)
    server?.stop()
    this.servers.delete(panelId)
  }
}

export const tftpService = new TftpService()
