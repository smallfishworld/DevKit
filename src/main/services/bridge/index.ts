/**
 * 串口TCP桥接服务（多实例：panelId -> 会话；一个面板 = 8 路通道 + 远程管理）。
 * 服务端模式：本机串口 ⇄ TCP 透传 + 可选管理端口（远程客户端可连入管理）。
 * 客户端模式：连远端管理端口，远程查看/改配置/启停通道。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { networkInterfaces } from 'node:os'
import { createSocket } from 'node:dgram'
import { SerialPort } from 'serialport'
import type { FileHandle } from 'node:fs/promises'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import {
  DEFAULT_BRIDGE_CONFIG,
  portDeviceOf,
  safeFilePart,
  type BridgeChannelParams,
  type BridgeChannelStatus,
  type BridgeConfig,
  type BridgeIdentityConfig,
  type BridgeSharedStatus
} from '../../../shared/bridge-protocol'
import { getSection, setSection } from '../macro/configStore'
import { BridgeChannel, type BridgeEventHandlers } from './channel'
import { RemoteServer, type RemoteServerHost } from './remote-server'
import { RemoteClient, type RemoteClientHandlers } from './remote-client'

const CHANNEL_COUNT = 8

interface BridgeSession {
  /** 8 个通道槽位（cid 1~8），null = 未运行 */
  channels: Array<BridgeChannel | null>
  /** 面板当前身份的配置（渲染端操作直接改这份并持久化） */
  identity: BridgeIdentityConfig
  remoteServer: RemoteServer | null
  remoteClient: RemoteClient | null
  /** 磁盘日志句柄（按身份+按天） */
  logFile: FileHandle | null
  logDate: string
  logIdentity: string
  /** 串口列表缓存 {path, friendlyName}（远程 get_ports 拼显示名同步返回，后台刷新） */
  portCache: Array<{ path: string; friendlyName: string }>
}

const sessions = new Map<string, BridgeSession>()

function bridgeLogDir(): string {
  return join(app.getPath('userData'), 'bridge-logs')
}

class BridgeService implements ToolService {
  private emit(panelId: string, type: string, payload?: unknown): void {
    emitToolEvent('bridge', panelId, type, payload)
  }

  // ---------- 磁盘日志（按身份+按天，每条带时间戳） ----------

  private logStamp(): string {
    const d = new Date()
    const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  private todayStr(): string {
    const d = new Date()
    const p = (n: number): string => n.toString().padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  }

  private async writeDiskLog(s: BridgeSession, text: string): Promise<void> {
    const today = this.todayStr()
    if (!s.logFile || today !== s.logDate) {
      await s.logFile?.close().catch(() => {})
      s.logFile = null
      s.logDate = today
      try {
        await fs.mkdir(bridgeLogDir(), { recursive: true })
        s.logFile = await fs.open(
          join(bridgeLogDir(), `${safeFilePart(s.logIdentity)}_bridge_${today}.log`),
          'a'
        )
      } catch {
        s.logFile = null
      }
    }
    if (!s.logFile) return
    try {
      await s.logFile.appendFile(`[${this.logStamp()}] ${text}\n`, 'utf8')
    } catch {
      // 写失败静默：日志不影响主流程
    }
  }

  // ---------- 会话与配置 ----------

  private defaultIdentity(mode: 'server' | 'client'): BridgeIdentityConfig {
    return {
      mode,
      remoteHost: '127.0.0.1',
      remotePort: 9999,
      remoteOn: false,
      shared: { dataBits: 8, parity: 'none', stopBits: 1, flowCtrl: 'none' },
      allowMulti: true,
      telnetMode: true,
      channels: Array.from({ length: CHANNEL_COUNT }, (_, i) => ({
        cid: i + 1,
        baudRate: 115200,
        tcpPort: 10000 + i + 1
      }))
    }
  }

  private async ensureSession(panelId: string): Promise<BridgeSession> {
    let s = sessions.get(panelId)
    if (s) return s
    const cfg = await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)
    const ident = cfg.lastIdentity || 'server_9999'
    const identity =
      cfg.identities[ident] ?? this.defaultIdentity(ident.startsWith('client') ? 'client' : 'server')
    s = {
      channels: Array.from({ length: CHANNEL_COUNT }, () => null),
      identity,
      remoteServer: null,
      remoteClient: null,
      logFile: null,
      logDate: this.todayStr(),
      logIdentity: ident,
      portCache: []
    }
    sessions.set(panelId, s)
    void this.refreshPortCache(panelId)
    return s
  }

  /** 保存当前身份配置到 configStore（渲染端每次改动后调用） */
  private async persistConfig(panelId: string): Promise<void> {
    const s = sessions.get(panelId)
    if (!s) return
    const cfg = await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)
    const ident = this.currentIdentityOf(s)
    cfg.identities[ident] = s.identity
    cfg.lastIdentity = ident
    await setSection('bridge', cfg)
  }

  /** 身份 = 按当前 mode/host/port 派生（文件名安全） */
  private currentIdentityOf(s: BridgeSession): string {
    const { mode, remoteHost, remotePort } = s.identity
    return mode === 'client'
      ? safeFilePart(`${remoteHost}_${remotePort}`)
      : safeFilePart(`server_${remotePort}`)
  }

  // ---------- 通道启停（含冲突防护） ----------

  /**
   * 通道事件处理器。bridgeRef 在 startChannel 里回填实例，
   * 客户端数事件由此读到实时 count。
   */
  private channelHandlers(panelId: string, cid: number): BridgeEventHandlers & { bridgeRef: { v: BridgeChannel | null } } {
    const bridgeRef = { v: null as BridgeChannel | null }
    return {
      bridgeRef,
      status: (text) => {
        this.emit(panelId, 'channel-status', { cid, text })
        this.scheduleRemoteBroadcast(panelId)
      },
      log: (text) => {
        this.emit(panelId, 'log', { cid, level: 'log', text: `CH${cid} ${text}` })
        const s = sessions.get(panelId)
        if (s) void this.writeDiskLog(s, `CH${cid} ${text}`)
      },
      error: (text) => {
        this.emit(panelId, 'log', { cid, level: 'error', text: `CH${cid} ${text}` })
        const s = sessions.get(panelId)
        if (s) void this.writeDiskLog(s, `CH${cid} ${text}`)
      },
      client: (addr) => {
        this.emit(panelId, 'log', { cid, level: 'info', text: `CH${cid} 客户端连接 ${addr}` })
        this.emit(panelId, 'clients', { cid, count: bridgeRef.v?.clientCount ?? 0 })
        this.scheduleRemoteBroadcast(panelId)
      },
      clientClose: (addr) => {
        this.emit(panelId, 'log', { cid, level: 'log', text: `CH${cid} 客户端断开 ${addr}` })
        this.emit(panelId, 'clients', { cid, count: bridgeRef.v?.clientCount ?? 0 })
        this.scheduleRemoteBroadcast(panelId)
      },
      stateChanged: () => this.scheduleRemoteBroadcast(panelId)
    }
  }

  /** 单通道启动（silent=true 用于「全部启动」，冲突静默跳过） */
  private async startChannel(
    panelId: string,
    cid: number,
    overrides: Partial<BridgeChannelParams> = {},
    silent = false
  ): Promise<true | string> {
    const s = sessions.get(panelId)
    if (!s) return '面板未初始化'
    if (s.identity.mode === 'client') return '客户端模式下本地不启动通道'
    if (s.channels[cid - 1]?.running) return true
    const ch = s.identity.channels[cid - 1] ?? {}
    const shared = s.identity.shared
    if (!shared) return '共享串口格式缺失'
    const params: BridgeChannelParams = {
      cid,
      port: portDeviceOf(String(overrides.port ?? ch.port ?? '')),
      baudRate: Number(overrides.baudRate ?? ch.baudRate ?? 0),
      tcpPort: Number(overrides.tcpPort ?? ch.tcpPort ?? 0)
    }
    if (!params.port) return silent ? true : '请选择串口'
    if (!(params.baudRate > 0)) return silent ? true : '波特率必须是正整数'
    if (!(params.tcpPort >= 1 && params.tcpPort <= 65535)) return silent ? true : 'TCP 端口必须在 1-65535'

    // 冲突防护：TCP 端口重复 / 串口被占
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      if (i === cid - 1) continue
      const other = s.channels[i]
      if (!other?.running || !other.config) continue
      if (other.config.tcpPort === params.tcpPort) {
        return silent ? true : `TCP 端口 ${params.tcpPort} 已被 CH${i + 1} 占用`
      }
      if (other.config.port === params.port) {
        return silent ? true : `串口 ${params.port} 已被 CH${i + 1} 占用`
      }
    }

    // 空闲槽位上复用/新建实例
    s.channels[cid - 1]?.stop()
    const handlers = this.channelHandlers(panelId, cid)
    const bridge = new BridgeChannel(handlers)
    handlers.bridgeRef.v = bridge
    const ok = await bridge.start(
      params,
      shared,
      params.tcpPort,
      s.identity.allowMulti ?? true,
      s.identity.telnetMode ?? true
    )
    if (ok !== true) return ok
    s.channels[cid - 1] = bridge
    // 运行参数回写配置（面板上改了参数再启动 → 配置跟上）
    s.identity.channels[cid - 1] = {
      cid,
      port: params.port,
      baudRate: params.baudRate,
      tcpPort: params.tcpPort
    }
    await this.persistConfig(panelId)
    return true
  }

  private stopChannel(panelId: string, cid: number): void {
    const s = sessions.get(panelId)
    if (!s) return
    s.channels[cid - 1]?.stop()
    s.channels[cid - 1] = null
    this.scheduleRemoteBroadcast(panelId)
  }

  private async startAll(panelId: string): Promise<string[]> {
    const s = sessions.get(panelId)
    if (!s) return []
    const errors: string[] = []
    const usedTcp = new Set<number>()
    const usedDev = new Set<string>()
    // 先纳入运行中的通道，避免「全部启动」与运行通道撞口
    for (const ch of s.channels) {
      if (ch?.running && ch.config) {
        usedTcp.add(ch.config.tcpPort)
        if (ch.config.port) usedDev.add(ch.config.port)
      }
    }
    for (let cid = 1; cid <= CHANNEL_COUNT; cid++) {
      const ch = s.identity.channels[cid - 1]
      if (!ch?.port || s.channels[cid - 1]?.running) continue
      const tcp = Number(ch.tcpPort ?? 0)
      if (usedTcp.has(tcp) || usedDev.has(String(ch.port))) continue
      usedTcp.add(tcp)
      usedDev.add(String(ch.port))
      const r = await this.startChannel(panelId, cid, {}, true)
      if (r !== true) errors.push(`CH${cid}: ${r}`)
    }
    return errors
  }

  private stopAllChannels(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s) return
    for (let cid = 1; cid <= CHANNEL_COUNT; cid++) this.stopChannel(panelId, cid)
  }

  // ---------- 串口列表（缓存 + 后台刷新，供远程 get_ports 同步取） ----------

  private async refreshPortCache(panelId: string): Promise<void> {
    const s = sessions.get(panelId)
    if (!s) return
    try {
      const ports = await SerialPort.list()
      s.portCache = ports.map((p) => ({
        path: p.path,
        friendlyName: p.friendlyName && p.friendlyName !== 'n/a' && p.friendlyName !== p.path ? p.friendlyName : ''
      }))
    } catch {
      s.portCache = []
    }
  }

  // ---------- 远程管理（服务端侧） ----------

  private broadcastTimer = new Map<string, ReturnType<typeof setTimeout>>()

  /** 状态变化后 100ms 合并广播（防抖） */
  private scheduleRemoteBroadcast(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s?.remoteServer?.running) return
    const old = this.broadcastTimer.get(panelId)
    if (old) clearTimeout(old)
    this.broadcastTimer.set(
      panelId,
      setTimeout(() => {
        this.broadcastTimer.delete(panelId)
        sessions.get(panelId)?.remoteServer?.broadcastStatus()
      }, 100)
    )
  }

  private serverHostOf(panelId: string): RemoteServerHost {
    const self = this
    return {
      getChannelsStatus: () => self.channelsStatusOf(panelId),
      getSharedStatus: () => self.sharedStatusOf(panelId),
      applyRemoteConfig: (msg) => self.applyRemoteUpdate(panelId, msg),
      startChannel: (cid) => {
        void self.startChannel(panelId, cid, {}, false).catch(() => {})
      },
      stopChannel: (cid) => self.stopChannel(panelId, cid),
      startAll: () => {
        void self.startAll(panelId).catch(() => {})
      },
      stopAll: () => self.stopAllChannels(panelId),
      listPorts: () => {
        // 同步返回缓存显示名，同时后台刷新供下次使用
        void self.refreshPortCache(panelId)
        return (sessions.get(panelId)?.portCache ?? []).map((p) =>
          p.friendlyName ? `${p.path}  (${p.friendlyName})` : p.path
        )
      },
      sendBreak: (cid) => sessions.get(panelId)?.channels[cid - 1]?.sendBreak() ?? false
    }
  }

  private async startRemoteServer(panelId: string, port: number): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '面板未初始化' }
    if (s.remoteServer?.running) return { ok: true }
    const srv = new RemoteServer(
      this.serverHostOf(panelId),
      (text) => this.pushLog(panelId, 'info', `[远程] ${text}`),
      (text) => this.pushLog(panelId, 'error', `[远程] ${text}`)
    )
    const ok = await srv.start(port)
    if (!ok) return { ok: false, error: '管理端口监听失败' }
    s.remoteServer = srv
    return { ok: true }
  }

  private stopRemoteServer(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s) return
    s.remoteServer?.stop()
    s.remoteServer = null
  }

  // ---------- 远程管理（客户端侧） ----------

  private clientHandlersOf(panelId: string): RemoteClientHandlers {
    return {
      connected: () => this.emit(panelId, 'remote', { state: 'connected' }),
      disconnected: () => this.emit(panelId, 'remote', { state: 'disconnected' }),
      statusPush: (channels, shared) => this.emit(panelId, 'remote-status', { channels, shared }),
      portsPush: (ports) => this.emit(panelId, 'remote-ports', { ports }),
      response: (ok, message) =>
        this.pushLog(panelId, ok ? 'info' : 'error', `[远程] ${ok ? '远程操作成功' : '远程操作失败'}: ${message}`),
      log: (text) => this.pushLog(panelId, 'info', `[远程] ${text}`),
      error: (text) => this.pushLog(panelId, 'error', `[远程] ${text}`)
    }
  }

  private async connectRemote(
    panelId: string,
    host: string,
    port: number
  ): Promise<{ ok: boolean; error?: string }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false, error: '面板未初始化' }
    s.remoteClient?.stop()
    const cli = new RemoteClient(host, port, this.clientHandlersOf(panelId))
    const ok = await cli.connect()
    if (!ok) return { ok: false, error: '连接失败' }
    s.remoteClient = cli
    return { ok: true }
  }

  private disconnectRemote(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s) return
    s.remoteClient?.stop()
    s.remoteClient = null
    this.emit(panelId, 'remote', { state: 'disconnected' })
  }

  private sendRemote(panelId: string, cmd: string, kv: Record<string, unknown> = {}): boolean {
    const cli = sessions.get(panelId)?.remoteClient
    if (!cli?.running) return false
    return cli.send(cmd, kv)
  }

  // ---------- 状态快照 ----------

  private channelsStatusOf(panelId: string): BridgeChannelStatus[] {
    const s = sessions.get(panelId)
    if (!s) return []
    return Array.from({ length: CHANNEL_COUNT }, (_, i) => {
      const ch = s.channels[i]
      const cfg = s.identity.channels[i] ?? {}
      return {
        cid: i + 1,
        port: ch?.config?.port ?? String(cfg.port ?? ''),
        baudrate: ch?.config?.baudRate ?? Number(cfg.baudRate ?? 0),
        tcp_port: ch?.config?.tcpPort ?? Number(cfg.tcpPort ?? 0),
        running: ch?.running ?? false,
        rx_bytes: ch?.rxBytes ?? 0,
        tx_bytes: ch?.txBytes ?? 0,
        clients: ch?.clientCount ?? 0
      }
    })
  }

  private sharedStatusOf(panelId: string): BridgeSharedStatus {
    const s = sessions.get(panelId)
    const shared = s?.identity.shared
    return {
      bytesize: shared?.dataBits ?? 8,
      parity: shared?.parity ?? 'none',
      stopbits: shared?.stopBits ?? 1,
      flowctrl: shared?.flowCtrl ?? 'none',
      allow_multi: s?.identity.allowMulti ?? true
    }
  }

  /** 远端推送的配置落到当前身份（update_config / start_channel 附带参数） */
  private applyRemoteUpdate(panelId: string, msg: Record<string, unknown>): void {
    const s = sessions.get(panelId)
    if (!s) return
    const cid = Number(msg.cid)
    if (!Number.isInteger(cid) || cid < 1 || cid > CHANNEL_COUNT) return
    const slot = (s.identity.channels[cid - 1] ??= {})
    if (typeof msg.port === 'string') slot.port = msg.port
    if (msg.baudrate !== undefined) slot.baudRate = Number(msg.baudrate)
    if (msg.tcp_port !== undefined) slot.tcpPort = Number(msg.tcp_port)
    const shared = s.identity.shared
    if (shared) {
      if (msg.bytesize !== undefined) shared.dataBits = Number(msg.bytesize) as 5 | 6 | 7 | 8
      if (typeof msg.parity === 'string') shared.parity = msg.parity as typeof shared.parity
      if (msg.stopbits !== undefined) shared.stopBits = Number(msg.stopbits) as 1 | 1.5 | 2
      if (typeof msg.flowctrl === 'string') shared.flowCtrl = msg.flowctrl
    }
    if (msg.allow_multi !== undefined) s.identity.allowMulti = Boolean(msg.allow_multi)
    this.emit(panelId, 'remote-config-applied', { cid })
    void this.persistConfig(panelId)
  }

  private pushLog(panelId: string, level: string, text: string): void {
    this.emit(panelId, 'log', { cid: 0, level, text })
    const s = sessions.get(panelId)
    if (s) void this.writeDiskLog(s, text)
  }

  // ---------- IPC 入口 ----------

  invoke(panelId: string, action: string, payload: unknown): Promise<unknown> | unknown {
    switch (action) {
      case 'attach':
        return this.attach(panelId)
      case 'config:set':
        return this.setIdentityConfig(panelId, payload as BridgeIdentityConfig)
      case 'config:switch-identity':
        return this.switchIdentity(panelId, (payload as { identity: string }).identity)
      case 'config:delete-identity':
        return this.deleteIdentity((payload as { identity: string }).identity)
      case 'config:list-identities':
        return this.listIdentities()
      case 'start':
        return this.startChannel(panelId, (payload as { cid: number }).cid, payload as Partial<BridgeChannelParams>)
      case 'stop':
        this.stopChannel(panelId, (payload as { cid: number }).cid)
        return { ok: true }
      case 'start-all':
        return this.startAll(panelId).then((errors) => ({ ok: true, errors }))
      case 'stop-all':
        this.stopAllChannels(panelId)
        return { ok: true }
      case 'break':
        return {
          ok: sessions.get(panelId)?.channels[(payload as { cid: number }).cid - 1]?.sendBreak() ?? false
        }
      case 'remote-server:start':
        return this.startRemoteServer(panelId, (payload as { port: number }).port)
      case 'remote-server:stop':
        this.stopRemoteServer(panelId)
        return { ok: true }
      case 'remote:connect':
        return this.connectRemote(
          panelId,
          (payload as { host: string; port: number }).host,
          (payload as { host: string; port: number }).port
        )
      case 'remote:disconnect':
        this.disconnectRemote(panelId)
        return { ok: true }
      case 'remote:send':
        return {
          ok: this.sendRemote(
            panelId,
            (payload as { cmd: string }).cmd,
            (payload as Record<string, unknown> | undefined) ?? {}
          )
        }
      case 'list':
        return this.refreshPortCache(panelId).then(() => sessions.get(panelId)?.portCache ?? [])
      case 'list-ips':
        return this.listIps()
      case 'status':
        return this.statusOf(panelId)
      default:
        throw new Error(`bridge 服务未知操作: ${action}`)
    }
  }

  private async attach(panelId: string): Promise<unknown> {
    const s = await this.ensureSession(panelId)
    return {
      identity: s.identity,
      identities: (await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)).identities,
      lastIdentity: this.currentIdentityOf(s),
      channels: this.channelsStatusOf(panelId),
      shared: this.sharedStatusOf(panelId)
    }
  }

  private async setIdentityConfig(panelId: string, identity: BridgeIdentityConfig): Promise<{ ok: boolean }> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false }
    s.identity = identity
    await this.persistConfig(panelId)
    return { ok: true }
  }

  private async switchIdentity(panelId: string, identity: string): Promise<unknown> {
    const s = sessions.get(panelId)
    if (!s) return { ok: false }
    // 切身份：停所有本地通道与远程管理
    this.stopAllChannels(panelId)
    this.stopRemoteServer(panelId)
    this.disconnectRemote(panelId)
    const cfg = await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)
    s.identity =
      cfg.identities[identity] ?? this.defaultIdentity(identity.startsWith('client') ? 'client' : 'server')
    s.logIdentity = identity
    await this.persistConfig(panelId)
    this.emit(panelId, 'remote', { state: 'identity-switched' })
    return { ok: true, identity: s.identity, lastIdentity: this.currentIdentityOf(s) }
  }

  private async deleteIdentity(identity: string): Promise<{ ok: boolean; remaining: string[] }> {
    const cfg = await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)
    delete cfg.identities[identity]
    cfg.lastIdentity = Object.keys(cfg.identities)[0] ?? 'server_9999'
    await setSection('bridge', cfg)
    return { ok: true, remaining: Object.keys(cfg.identities).sort() }
  }

  private async listIdentities(): Promise<{ identities: string[] }> {
    const cfg = await getSection<BridgeConfig>('bridge', DEFAULT_BRIDGE_CONFIG)
    return { identities: Object.keys(cfg.identities).sort() }
  }

  /**
   * 本机 IPv4 列表 + 默认出口 IP（UDP connect 法取默认出口，不实际发包；离线/失败回退空串）。
   */
  private listIps(): Promise<{ ips: Array<{ address: string; name: string }>; egress: string }> {
    const out: Array<{ address: string; name: string }> = []
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, name })
      }
    }
    const egress = new Promise<string>((resolve) => {
      const s = createSocket('udp4')
      let done = false
      const finish = (v: string): void => {
        if (done) return
        done = true
        try {
          s.close()
        } catch {
          /* 已关闭 */
        }
        resolve(v)
      }
      s.once('error', () => finish(''))
      s.connect(53, '8.8.8.8', () => {
        try {
          finish(s.address().address)
        } catch {
          finish('')
        }
      })
      setTimeout(() => finish(''), 1000)
    })
    return egress.then((eg) => ({ ips: out, egress: eg }))
  }

  private statusOf(panelId: string): unknown {
    const s = sessions.get(panelId)
    if (!s) return null
    return {
      channels: this.channelsStatusOf(panelId),
      shared: this.sharedStatusOf(panelId),
      remoteServerRunning: s.remoteServer?.running ?? false,
      remoteClientRunning: s.remoteClient?.running ?? false,
      identity: this.currentIdentityOf(s)
    }
  }

  /** 面板关闭时清理资源 */
  dispose(panelId: string): void {
    const s = sessions.get(panelId)
    if (!s) return
    this.stopAllChannels(panelId)
    s.remoteServer?.stop()
    s.remoteClient?.stop()
    const timer = this.broadcastTimer.get(panelId)
    if (timer) clearTimeout(timer)
    this.broadcastTimer.delete(panelId)
    void s.logFile?.close().catch(() => {})
    s.logFile = null
    sessions.delete(panelId)
  }
}

export const bridgeService = new BridgeService()
