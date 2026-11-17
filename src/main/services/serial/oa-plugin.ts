import { randomUUID } from 'node:crypto'
import type { BuiltinPluginDefinition, PluginSerialLease } from '../../../shared/plugins'
import { DeviceActionLines, runDeviceAction } from './device-actions'
import type { DeviceActionResult, DeviceActionStage, WaitVerdictInput } from './device-actions'
import { isTriggerWord, matchChallengeLine } from './device-action-match'
import { parseDeviceActionsConfig } from './device-actions-config'
import type { DeviceActionHold, DeviceActionProfile, DeviceActionsConfig } from './device-actions-config'
import { createDeviceActionProvider } from './device-actions-provider'
import type { DeviceActionProvider } from './device-actions-provider'

export interface OaSession {
  connectionId: string
  suspendedAt: number | null
  holdOwner?: string
  action?: {
    owner: string
    source: 'manual' | 'auto'
    controller: AbortController
    locked: boolean
    receive?: (text: string, receivedAt: number) => void
  }
  watch?: {
    owner: string
    provider: DeviceActionProvider
    profiles: DeviceActionProfile[]
    lines: DeviceActionLines
    signal?: AbortSignal
    stop?: () => void
    state?: (value: unknown) => void
  }
}

/** The OA adapter receives capabilities, never the native SerialPort. */
export interface OaPluginHost {
  session(panelId: string): OaSession | undefined
  connected(panelId: string, session: OaSession): boolean
  transferActive(panelId: string): boolean
  acquire(panelId: string, owner: string, signal: AbortSignal): Promise<PluginSerialLease>
  flush(panelId: string): void
  emit(panelId: string, type: string, payload: unknown): void
  note(panelId: string, text: string): void
  beginHold(session: OaSession, config: false | DeviceActionHold, owner: string): void
  releaseHold(panelId: string, session: OaSession, replay: boolean, owner?: string): void
  replayHold(panelId: string, session: OaSession, lease: PluginSerialLease, owner: string): Promise<void>
}

/** Built-in OA extension. Legacy action:* calls are a compatibility adapter to this class. */
export class OaDevicePlugin {
  readonly definition: BuiltinPluginDefinition

  constructor(
    private readonly host: OaPluginHost,
    private readonly loadLegacyProvider: () => Promise<DeviceActionProvider>,
    private readonly providerFactory: (config: DeviceActionsConfig) => DeviceActionProvider = createDeviceActionProvider
  ) {
    this.definition = {
      manifest: {
        id: 'devkit.oa-debug', name: 'OA 设备解锁', version: '1.0.0', apiVersion: 1,
        entry: 'builtin:oa-unlock', description: 'OA 登录、挑战码取口令与设备应答；每个实例拥有独立配置。',
        autoRespond: true, capabilities: ['serial.read', 'serial.write', 'serial.exclusive', 'auth.session'],
        actions: [{ id: 'run', label: '执行设备动作' }],
        configSchema: {
          type: 'object', required: ['deviceActions'], additionalProperties: false,
          properties: {
            deviceActions: { type: 'object', title: '设备动作配置', additionalProperties: true },
            profileId: { type: 'string', title: '手动动作 ID' },
            auto: { type: 'boolean', title: '允许自动应答', default: true }
          }
        }
      },
      managesSerialLease: true,
      activate: async (context) => {
        const snapshot = parseDeviceActionsConfig(structuredClone(context.config.deviceActions ?? context.config))
        if (typeof context.config.profileId === 'string' && context.config.profileId) {
          snapshot.profiles = snapshot.profiles.filter((profile) => profile.id === context.config.profileId)
          if (!snapshot.profiles.length) throw new Error('找不到实例选择的设备动作配置')
        }
        const provider = this.providerFactory(snapshot)
        const owner = `oa:${randomUUID()}`
        const panelId = context.session.panelId
        const session = this.host.session(panelId)
        if (!session || session.connectionId !== context.session.connectionId || !this.host.connected(panelId, session)) {
          throw new Error('串口连接已变化')
        }
        context.signal.throwIfAborted()
        const stop = (): void => this.stopOwner(panelId, session, owner, new Error('OA 插件已停止'))
        context.signal.addEventListener('abort', stop, { once: true })
        try {
          if (context.autoEnabled && context.config.auto !== false) {
            this.installWatch(panelId, session, owner, provider, context.signal, context.state)
          }
        } catch (error) {
          context.signal.removeEventListener('abort', stop)
          throw error
        }
        return {
          run: async (actionId, args) => {
            context.signal.throwIfAborted()
            if (actionId !== 'run') throw new Error('未知 OA 插件动作')
            const requested = args && typeof args === 'object' ? (args as { profileId?: unknown }).profileId : undefined
            const profileId = requested ?? context.config.profileId ?? snapshot.profiles.find((profile) => profile.trigger === 'manual')?.id
            const profile = snapshot.profiles.find((candidate) => candidate.id === profileId)
            if (!profile || profile.trigger === 'auto') throw new Error('请选择配置中的手动设备动作')
            if (!this.host.connected(panelId, session)) throw new Error('串口连接已变化')
            const result = await this.runAction(panelId, provider, profile, {
              source: 'manual', owner, signal: context.signal, state: context.state
            })
            if (!result.ok) throw new Error(result.error)
            return result
          },
          dispose: () => { context.signal.removeEventListener('abort', stop); stop() }
        }
      }
    }
  }

  async profiles(panelId: string): Promise<unknown> {
    try {
      const { config } = await this.loadLegacyProvider()
      return {
        profiles: config.profiles.map(({ id, label, actionLabel, trigger }) => ({ id, label, actionLabel, trigger })),
        armed: this.host.session(panelId)?.watch?.owner === 'legacy'
      }
    } catch (error) {
      return { profiles: [], armed: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  cancel(panelId: string, reason = new Error('已取消设备动作')): void {
    this.host.session(panelId)?.action?.controller.abort(reason)
  }

  close(panelId: string, session: OaSession, reason: Error): void {
    this.legacyPanels.delete(panelId)
    session.action?.controller.abort(reason)
    this.removeWatch(session)
    this.host.releaseHold(panelId, session, false)
  }

  private removeWatch(session: OaSession): void {
    const watch = session.watch
    if (watch?.stop) watch.signal?.removeEventListener('abort', watch.stop)
    delete session.watch
  }

  private stopOwner(panelId: string, session: OaSession, owner: string, reason: Error): void {
    if (session.watch?.owner !== owner && session.action?.owner !== owner && session.holdOwner !== owner) return
    if (session.watch?.owner === owner) this.removeWatch(session)
    if (session.action?.owner === owner) session.action.controller.abort(reason)
    this.host.releaseHold(panelId, session, false, owner)
  }

  /** A running action keeps its provider snapshot. The new watcher has no copied busy flag. */
  async refreshLegacyWatches(): Promise<void> {
    const armed = this.legacySessions()
    if (!armed.length) return
    let provider: DeviceActionProvider
    try { provider = await this.loadLegacyProvider() }
    catch (error) {
      for (const [panelId, session] of armed) {
        this.stopOwner(panelId, session, 'legacy', new Error('设备动作配置已失效'))
        this.host.emit(panelId, 'action:state', { source: 'auto', armed: false, running: false, error: String(error) })
      }
      return
    }
    for (const [panelId, session] of armed) {
      if (!this.host.connected(panelId, session) || session.watch?.owner !== 'legacy') continue
      try { this.installWatch(panelId, session, 'legacy', provider) }
      catch (error) {
        this.stopOwner(panelId, session, 'legacy', new Error('没有可用的自动应答配置'))
        this.host.emit(panelId, 'action:state', { source: 'auto', armed: false, running: false, error: String(error) })
      }
    }
  }

  private readonly legacyPanels = new Set<string>()
  private legacySessions(): Array<[string, OaSession]> {
    const result: Array<[string, OaSession]> = []
    for (const panelId of this.legacyPanels) {
      const session = this.host.session(panelId)
      if (session?.watch?.owner === 'legacy') result.push([panelId, session])
      else this.legacyPanels.delete(panelId)
    }
    return result
  }

  async setLegacyWatch(panelId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const session = this.host.session(panelId)
    if (!session || !this.host.connected(panelId, session)) return { ok: false, error: '串口未打开' }
    if (!enabled) {
      this.stopOwner(panelId, session, 'legacy', new Error('自动应答已关闭'))
      this.legacyPanels.delete(panelId)
      this.host.emit(panelId, 'action:state', { source: 'auto', armed: false, running: false })
      return { ok: true }
    }
    try {
      const provider = await this.loadLegacyProvider()
      if (!this.host.connected(panelId, session)) throw new Error('串口连接已变化')
      this.installWatch(panelId, session, 'legacy', provider)
      this.legacyPanels.add(panelId)
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  private installWatch(
    panelId: string, session: OaSession, owner: string, provider: DeviceActionProvider,
    signal?: AbortSignal, state?: (value: unknown) => void
  ): void {
    signal?.throwIfAborted()
    if (session.watch && session.watch.owner !== owner) throw new Error('此串口已经绑定了另一个 OA 自动应答实例')
    const profiles = provider.config.profiles.filter((profile) => profile.trigger === 'auto')
    if (!profiles.length) throw new Error('配置没有 trigger 为 auto 的设备动作')
    this.removeWatch(session)
    const stop = (): void => this.stopOwner(panelId, session, owner, new Error('OA 插件已停止'))
    session.watch = { owner, provider, profiles, lines: new DeviceActionLines(), signal, stop, state }
    signal?.addEventListener('abort', stop, { once: true })
    this.host.emit(panelId, 'action:state', {
      source: 'auto', armed: true, running: session.action?.source === 'auto',
      profiles: profiles.map(({ id, label, actionLabel }) => ({ id, label, actionLabel }))
    })
  }

  receive(panelId: string, session: OaSession, text: string, receivedAt: number): void {
    const watch = session.watch
    if (watch && session.suspendedAt === null) {
      watch.lines.push(text, (line) => {
        if (!this.host.connected(panelId, session) || session.watch !== watch) return true
        if (session.action || this.host.transferActive(panelId) || watch.signal?.aborted) return false
        for (const profile of watch.profiles) {
          if (isTriggerWord(line, profile.triggerWords)) this.host.beginHold(session, profile.holdInput, watch.owner)
        }
        for (const profile of watch.profiles) {
          let challenge: string | undefined
          try { challenge = matchChallengeLine(profile.detect, line) } catch { continue }
          if (!challenge) continue
          this.host.beginHold(session, profile.holdInput, watch.owner)
          void this.runAuto(panelId, session, watch, profile, challenge, receivedAt)
          return true
        }
        return false
      })
    }
    session.action?.receive?.(text, receivedAt)
  }

  private async runAuto(
    panelId: string, session: OaSession, watch: NonNullable<OaSession['watch']>,
    profile: DeviceActionProfile, challenge: string, receivedAt: number
  ): Promise<void> {
    let ok = false
    try {
      const result = await this.runAction(panelId, watch.provider, profile, {
        source: 'auto', owner: watch.owner, signal: watch.signal, state: watch.state,
        challenge: { value: challenge, receivedAt }
      })
      ok = result.ok
      this.host.emit(panelId, 'action:state', {
        source: 'auto', running: false, profileId: profile.id, ok, error: result.ok ? undefined : result.error
      })
      watch.state?.({ running: false, ok, error: result.ok ? undefined : result.error })
    } finally { this.host.releaseHold(panelId, session, ok, watch.owner) }
  }

  async runLegacy(panelId: string, profileId: unknown): Promise<DeviceActionResult> {
    const session = this.host.session(panelId)
    if (!session || !this.host.connected(panelId, session)) return { ok: false, error: '串口未打开' }
    try {
      const provider = await this.loadLegacyProvider()
      if (!this.host.connected(panelId, session)) return { ok: false, error: '串口连接已变化' }
      const profile = provider.config.profiles.find(({ id }) => id === profileId)
      if (!profile) return { ok: false, error: '找不到此设备动作的配置' }
      if (profile.trigger === 'auto') return { ok: false, error: '该设备动作配置为自动应答，不通过快捷命令执行' }
      return this.runAction(panelId, provider, profile, { source: 'manual', owner: 'legacy' })
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  private async runAction(
    panelId: string, provider: DeviceActionProvider, profile: DeviceActionProfile,
    options: {
      source: 'manual' | 'auto'; owner: string; signal?: AbortSignal; state?: (value: unknown) => void
      challenge?: { value: string; receivedAt: number }
    }
  ): Promise<DeviceActionResult> {
    const session = this.host.session(panelId)
    if (!session || !this.host.connected(panelId, session)) return { ok: false, error: '串口未打开' }
    if (session.action || this.host.transferActive(panelId)) return { ok: false, error: '该串口有设备动作或文件传输正在运行' }
    const task: NonNullable<OaSession['action']> = {
      owner: options.owner, source: options.source, controller: new AbortController(), locked: false
    }
    session.action = task
    const signal = task.controller.signal
    const propagateAbort = (): void => task.controller.abort(options.signal?.reason ?? new Error('设备动作已取消'))
    options.signal?.addEventListener('abort', propagateAbort, { once: true })
    if (options.signal?.aborted) propagateAbort()
    let lease: PluginSerialLease | undefined
    let responseSent = false
    const checkConnection = (): void => {
      signal.throwIfAborted()
      if (!this.host.connected(panelId, session)) throw new Error('串口连接已变化')
    }
    const setStage = (stage: DeviceActionStage): void => {
      if (options.source === 'manual') this.host.emit(panelId, 'action:stage', { stage })
      else this.host.emit(panelId, 'action:state', { source: 'auto', running: true, stage, profileId: profile.id })
      options.state?.({ running: true, stage, profileId: profile.id })
    }
    const send = (text: string, secret: boolean): Promise<void> => {
      checkConnection()
      if (!lease) throw new Error('设备动作尚未取得串口事务')
      responseSent ||= secret
      return lease.write(Buffer.from(text, 'ascii'), { secret })
    }
    try {
      setStage('checking')
      checkConnection()
      await runDeviceAction(provider, profile, {
        signal, challenge: options.challenge, setStage,
        lock: async () => {
          checkConnection()
          if (this.host.transferActive(panelId)) throw new Error('已有文件传输进行中')
          task.locked = true
          lease = await this.host.acquire(panelId, `oa:${options.owner}`, signal)
          checkConnection()
        },
        exchange: async (text, secret, timeoutMs, match) => {
          checkConnection()
          this.host.flush(panelId)
          const lines = new DeviceActionLines()
          return new Promise((resolve, reject) => {
            let settled = false
            const onAbort = (): void => finish(signal.reason)
            const timer = setTimeout(() => finish(new Error(secret
              ? '口令已发送，未收到设备的明确结果' : '等待设备挑战码超时')), timeoutMs)
            function finish(error?: Error, result?: { value: string; receivedAt: number }): void {
              if (settled) return
              settled = true
              clearTimeout(timer)
              signal.removeEventListener('abort', onAbort)
              task.receive = undefined
              if (result) resolve(result); else reject(error)
            }
            signal.addEventListener('abort', onAbort, { once: true })
            task.receive = (data, receivedAt) => lines.push(data, (line) => {
              try {
                const value = match(line)
                if (!value) return false
                finish(undefined, { value, receivedAt })
              } catch (error) { finish(error as Error) }
              return true
            })
            try {
              void send(text, secret).catch(() => finish(new Error(secret ? '口令写入异常，设备结果未确认' : '发送设备动作命令失败')))
            } catch (error) { finish(error as Error) }
          })
        },
        waitVerdict: async (input: WaitVerdictInput) => {
          checkConnection()
          this.host.flush(panelId)
          const lines = new DeviceActionLines()
          return new Promise<'accepted' | 'rejected'>((resolve, reject) => {
            let settled = false
            let decision: NodeJS.Timeout | undefined
            const onAbort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error('设备动作已终止'))
            const timer = setTimeout(() => finish('accepted'), input.timeoutMs)
            function finish(verdict: 'accepted' | 'rejected' | Error): void {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (decision) clearTimeout(decision)
              signal.removeEventListener('abort', onAbort)
              task.receive = undefined
              if (verdict instanceof Error) reject(verdict); else resolve(verdict)
            }
            signal.addEventListener('abort', onAbort, { once: true })
            task.receive = (data) => lines.push(data, (line) => {
              if (input.isReject(line)) { finish('rejected'); return true }
              if (!decision) decision = setTimeout(() => finish('accepted'), input.decisionDelayMs)
              return false
            })
            try { void send(input.reply, true).catch(() => finish(new Error('口令写入异常，设备结果未确认'))) }
            catch (error) { finish(error as Error) }
          })
        }
      })
      checkConnection()
      if (options.source === 'auto' && lease) await this.host.replayHold(panelId, session, lease, options.owner)
      checkConnection()
      this.host.note(panelId, '[DevKit] 设备动作成功')
      return { ok: true }
    } catch (error) {
      if (task.locked && this.host.connected(panelId, session) && !signal.aborted) this.host.note(panelId, '[DevKit] 设备动作未完成')
      if (responseSent && signal.aborted) return { ok: false, error: '口令已发送，设备结果未确认' }
      return { ok: false, error: error instanceof Error ? error.message : '设备动作失败' }
    } finally {
      options.signal?.removeEventListener('abort', propagateAbort)
      lease?.release()
      if (session.action === task) session.action = undefined
    }
  }
}
