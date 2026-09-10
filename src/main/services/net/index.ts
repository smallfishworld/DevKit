/**
 * 网络调试助手服务（多实例：panelId -> 主机实例）
 * 与串口一致的 80ms 批量推送，防高速收发卡 UI
 */
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { NetConfig, NetParams } from '../../../shared/net'
import { DEFAULT_NET_CONFIG } from '../../../shared/net'
import { getSection, setSection } from '../macro/configStore'
import { createHost, type NetHost, type PeerInfo } from './hosts'

interface PendingPiece {
  buf: Buffer
  time: number
  /** 来源（TCP 客户端标识 / UDP 对端地址），服务端模式区分数据来源 */
  peer: string
}

interface NetSession {
  host: NetHost
  params: NetParams
  rxBytes: number
  txBytes: number
  pending: PendingPiece[]
  flushTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, NetSession>()
const FLUSH_MS = 80

class NetService implements ToolService {
  private emit(panelId: string, type: string, payload: unknown): void {
    emitToolEvent('net', panelId, type, payload)
  }

  private emitStatus(panelId: string): void {
    const s = sessions.get(panelId)
    this.emit(panelId, 'status', {
      running: !!s,
      mode: s?.params.mode ?? null,
      params: s?.params ?? null,
      rxBytes: s?.rxBytes ?? 0,
      txBytes: s?.txBytes ?? 0
    })
  }

  private flush(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s || s.pending.length === 0) return
    const pieces = s.pending
    s.pending = []
    // 按对端分组各自合并：服务端多客户端/UDP 多对端时不同来源的字节流不能拼接
    const byPeer = new Map<string, Buffer[]>()
    for (const p of pieces) {
      const list = byPeer.get(p.peer)
      if (list) list.push(p.buf)
      else byPeer.set(p.peer, [p.buf])
    }
    for (const [peer, bufs] of byPeer) {
      const first = pieces.find((p) => p.peer === peer)
      const total = Buffer.concat(bufs)
      this.emit(panelId, 'data', {
        peer,
        hex: total.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
        text: total.toString('utf8'),
        bytes: total.length,
        time: first?.time ?? Date.now(),
        rxBytes: s.rxBytes,
        txBytes: s.txBytes
      })
    }
  }

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'attach':
        return getSection<NetConfig>('net', DEFAULT_NET_CONFIG).then((config) => ({
          config,
          running: sessions.has(panelId)
        }))
      case 'config:set':
        return setSection('net', payload).then(() => ({ ok: true }))
      case 'start': {
        const params = payload as NetParams
        return this.stop(panelId).then(() =>
          this.start(panelId, params).then((r) => {
            if (r.ok) {
              // 只更新 last，不整段覆写（保留面板已保存的 displayHex/showTimestamp 等偏好）
              void getSection<NetConfig>('net', DEFAULT_NET_CONFIG)
                .then((cfg) => setSection('net', { ...cfg, last: params }))
                .catch(() => {})
            }
            return r
          })
        )
      }
      case 'stop':
        return this.stop(panelId)
      case 'send':
        return this.send(
          panelId,
          payload as { mode: 'ascii' | 'hex'; text: string; newline: string; targetId?: string }
        )
      default:
        throw new Error(`net 服务未知操作: ${action}`)
    }
  }

  private async start(panelId: string, params: NetParams): Promise<{ ok: boolean; error?: string }> {
    const session: NetSession = {
      host: null as unknown as NetHost,
      params: { ...params },
      rxBytes: 0,
      txBytes: 0,
      pending: [],
      flushTimer: null
    }
    let s: NetSession | null = null
    const host = createHost(params.mode, {
      onData: (peer, buf, time) => {
        if (!s) return
        s.rxBytes += buf.length
        s.pending.push({ buf, time, peer })
        if (!s.flushTimer) {
          s.flushTimer = setTimeout(() => {
            if (s) s.flushTimer = null
            this.flush(panelId)
          }, FLUSH_MS)
        }
      },
      onStatus: (running, error) => {
        if (!running && sessions.get(panelId) === s) {
          sessions.delete(panelId)
        }
        this.emitStatus(panelId)
        if (error) this.emit(panelId, 'error', { message: error })
      },
      onClients: (clients: PeerInfo[]) => {
        this.emit(panelId, 'clients', { clients })
      },
      onError: (message: string) => {
        this.emit(panelId, 'error', { message })
      }
    })
    const r = await host.start(params)
    if (!r.ok) return r
    s = session
    session.host = host
    sessions.set(panelId, session)
    this.emitStatus(panelId)
    return { ok: true }
  }

  private async stop(panelId: string): Promise<{ ok: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: true }
    sessions.delete(panelId)
    this.flush(panelId)
    const timer = s.flushTimer
    if (timer) clearTimeout(timer)
    await s.host.stop()
    this.emitStatus(panelId)
    return { ok: true }
  }

  private send(
    panelId: string,
    p: { mode: 'ascii' | 'hex'; text: string; newline: string; targetId?: string }
  ): { ok: boolean; error?: string; bytes?: number } {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '未启动' }
    let buf: Buffer
    if (p.mode === 'hex') {
      const compact = p.text.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
      if (compact.length === 0) return { ok: false, error: 'HEX 内容为空' }
      if (compact.length % 2 !== 0) return { ok: false, error: 'HEX 长度须为偶数' }
      buf = Buffer.from(compact, 'hex')
    } else {
      const nl = p.newline === 'crlf' ? '\r\n' : p.newline === 'lf' ? '\n' : p.newline === 'cr' ? '\r' : ''
      buf = Buffer.from(p.text + nl, 'utf8')
    }
    if (buf.length === 0) return { ok: false, error: '发送内容为空' }
    const r = s.host.send(buf, p.targetId)
    if (!r.ok) return r
    s.txBytes += buf.length
    this.emit(panelId, 'tx', {
      hex: buf.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
      text: buf.toString('utf8'),
      bytes: buf.length,
      time: Date.now(),
      target: p.targetId ?? '',
      rxBytes: s.rxBytes,
      txBytes: s.txBytes
    })
    return { ok: true, bytes: buf.length }
  }

  dispose(panelId: string): void {
    if (sessions.has(panelId)) void this.stop(panelId)
  }
}

export const netService = new NetService()
