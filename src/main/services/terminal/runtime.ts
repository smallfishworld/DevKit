import { app, dialog } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emitToolEvent } from '../../ipc'
import { fileNameStamp } from '../../../shared/logtext'
import { OutputWindow, PanelTasks, DisplayBacklog, SERIAL_REPLAY_HIGH_WATER_CHARS, SERIAL_REPLAY_FRAME_CHARS, type HistoryQuery, type OutputAck } from '../../../shared/terminal-stream'
import { SessionHistory, readHistoryPage } from './history'

interface RuntimeOptions {
  dir: string
  name: string
  temporary: boolean
  pause: (paused: boolean) => void
  fatal: () => void
  stats?: () => Record<string, unknown>
}

/** Shared lifecycle for all three terminal transports. Disconnected panels retain disk references only. */
export class TerminalRuntime {
  readonly tasks = new PanelTasks()
  private histories = new Map<string, SessionHistory>()
  private outputs = new Map<string, OutputWindow>()
  private options = new Map<string, RuntimeOptions>()
  private selected = new Map<string, string>()
  private pressure = new Map<string, Set<string>>()
  private hiddenViews = new Set<string>()
  private backlogs = new Map<string, DisplayBacklog>()
  private replays = new Map<string, DisplayBacklog>()
  private pumpingReplays = new Set<string>()

  constructor(private tool: string) {}
  get ids(): string[] { return [...new Set([...this.tasks.ids, ...this.histories.keys(), ...this.outputs.keys(), ...this.selected.keys()])] }

  private setPressure(id: string, reason: string, paused: boolean): void {
    const reasons = this.pressure.get(id)
    if (!reasons) return
    // An inactive serial view must not pause its transport just because xterm
    // still has older frames waiting for ACK; disk backpressure remains active.
    if (reason === 'display' && this.hiddenViews.has(id)) paused = false
    if (paused) reasons.add(reason); else reasons.delete(reason)
    this.options.get(id)?.pause(reasons.size > 0)
  }

  /**
   * Hidden serial tabs stop only xterm rendering, never capture to disk. On return
   * replay in small ACK-paced frames instead of queuing all 16 Mi code units.
   */
  setVisible(id: string, visible: boolean): void {
    if (!visible) {
      this.hiddenViews.add(id)
      this.outputs.get(id)?.suspendDelivery()
      this.setPressure(id, 'display', false)
      const replay = this.replays.get(id)
      if (replay) {
        this.replays.delete(id)
        this.backlogs.set(id, replay)
      }
      return
    }
    if (!this.hiddenViews.delete(id)) return
    const output = this.outputs.get(id)
    output?.resumeDelivery()
    this.setPressure(id, 'display', (output?.pending ?? 0) >= SERIAL_REPLAY_HIGH_WATER_CHARS)
    const backlog = this.backlogs.get(id)
    this.backlogs.delete(id)
    if (!backlog || !this.outputs.has(id)) return
    this.replays.set(id, backlog)
    this.pumpReplay(id)
  }

  /**
   * Never exceed the normal OutputWindow high-water limit while catching up.
   * New serial bytes are appended to this FIFO until it has been fully emitted,
   * so an incoming live frame cannot overtake older background output.
   * Actual xterm parsing completion is still acknowledged by the renderer.
   */
  private pumpReplay(id: string): void {
    if (this.pumpingReplays.has(id) || this.hiddenViews.has(id)) return
    const backlog = this.replays.get(id)
    const output = this.outputs.get(id)
    if (!backlog || !output) return
    this.pumpingReplays.add(id)
    try {
      const dropped = backlog.takeDropped()
      if (dropped > 0) {
        // Close any unterminated OSC/DCS and restore the default rendition before
        // the tail; overflow may have evicted the opening half of a VT sequence.
        output.write('\x1b\\\x1b[0m\r\n[DevKit] 后台缓存已满，较早的显示内容请查看「历史日志」。\r\n')
      }
      while (backlog.pending && output.pending < SERIAL_REPLAY_HIGH_WATER_CHARS) {
        const available = SERIAL_REPLAY_HIGH_WATER_CHARS - output.pending
        const frame = backlog.read(Math.min(SERIAL_REPLAY_FRAME_CHARS, Math.max(2, available)))
        if (!frame) break
        output.write(frame)
      }
      if (!backlog.pending) this.replays.delete(id)
    } finally {
      this.pumpingReplays.delete(id)
    }
  }

  forgetVisible(id: string): void {
    this.hiddenViews.delete(id)
    this.backlogs.delete(id)
    this.replays.delete(id)
    this.pumpingReplays.delete(id)
  }

  async start(id: string, options: RuntimeOptions): Promise<void> {
    await this.dispose(id)
    this.options.set(id, options)
    this.pressure.set(id, new Set())
    const dir = options.temporary ? join(app.getPath('temp'), 'devkit-history') : options.dir
    const path = join(dir, `${options.name.replace(/[\\/:*?"<>|]/g, '_')}-${fileNameStamp()}-${randomUUID().slice(0, 8)}.log`)
    try {
      const history = await SessionHistory.create(path, options.temporary,
        (paused) => this.setPressure(id, 'disk', paused),
        (error) => {
          emitToolEvent(this.tool, id, 'error', { message: `${error.message}；会话将关闭，已写入的历史仍可查询和导出。` })
          queueMicrotask(() => this.options.get(id)?.fatal())
        })
      this.histories.set(id, history)
      this.resetOutput(id)
    } catch (error) {
      this.options.delete(id); this.pressure.delete(id)
      throw error
    }
  }

  resetOutput(id: string): void {
    this.replays.delete(id)
    this.backlogs.delete(id)
    this.outputs.get(id)?.dispose()
    this.outputs.delete(id)
    emitToolEvent(this.tool, id, 'output:reset')
    if (!this.options.has(id)) return
    const output = new OutputWindow(randomUUID(),
      (frame) => emitToolEvent(this.tool, id, 'data', { ...this.options.get(id)?.stats?.(), ...frame }),
      (paused) => this.setPressure(id, 'display', paused),
      () => emitToolEvent(this.tool, id, 'output:overflow', { message: '终端显示积压已达上限，显示已暂停，磁盘日志继续记录。可打开历史日志；点击清屏恢复显示。无硬件流控的串口无法保证无限速实时显示。' }))
    if (this.hiddenViews.has(id)) output.suspendDelivery()
    this.outputs.set(id, output)
  }

  data(id: string, text: string): void {
    this.histories.get(id)?.append(text)
    if (this.hiddenViews.has(id)) {
      let backlog = this.backlogs.get(id)
      if (!backlog) { backlog = new DisplayBacklog(); this.backlogs.set(id, backlog) }
      backlog.push(text)
    } else {
      const replay = this.replays.get(id)
      if (replay) {
        replay.push(text)
        this.pumpReplay(id)
      } else this.outputs.get(id)?.write(text)
    }
  }
  note(id: string, text: string): void { this.histories.get(id)?.note(text) }

  async close(id: string): Promise<void> {
    await this.histories.get(id)?.close()
    // Release transport closures as well as the write handle after disconnect.
    this.options.delete(id)
    this.pressure.delete(id)
  }

  async dispose(id: string): Promise<void> {
    this.backlogs.delete(id)
    this.replays.delete(id)
    this.pumpingReplays.delete(id)
    this.options.delete(id)
    this.pressure.delete(id)
    this.outputs.get(id)?.dispose()
    this.outputs.delete(id)
    const history = this.histories.get(id)
    this.histories.delete(id)
    this.selected.delete(id)
    await history?.dispose()
  }

  async export(id: string, defaultDir?: string): Promise<{ ok: boolean; error?: string }> {
    const history = this.histories.get(id)
    if (!history || !history.bytes) return { ok: false, error: '无日志可存' }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存会话日志', defaultPath: join(defaultDir || app.getPath('documents'), `${this.tool}-${fileNameStamp()}.log`),
      filters: [{ name: '日志', extensions: ['log', 'txt'] }]
    })
    if (canceled || !filePath) return { ok: false, error: '已取消' }
    try { await history.exportTo(filePath); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  handles(action: string): boolean {
    return ['output:ack', 'output:reset', 'history:query', 'history:pick', 'history:save'].includes(action)
  }

  invoke(id: string, action: string, payload: unknown): unknown {
    switch (action) {
      case 'output:ack':
        this.outputs.get(id)?.ack(payload as OutputAck)
        this.pumpReplay(id)
        return true
      case 'output:reset': this.resetOutput(id); return true
      case 'history:query': return this.query(id, (payload ?? {}) as HistoryQuery)
      case 'history:pick': return this.pick(id)
      case 'history:save': return this.export(id)
    }
  }

  private async query(id: string, request: HistoryQuery): Promise<unknown> {
    const path = request.selected ? this.selected.get(id) : undefined
    if (path) return readHistoryPage(path, request)
    const history = this.histories.get(id)
    if (!history) return { path: '', rows: [], nextOffset: 0, size: 0, eof: true }
    return history.query(request)
  }

  private async pick(id: string): Promise<{ ok: boolean }> {
    const result = await dialog.showOpenDialog({ title: '打开历史日志', properties: ['openFile'], filters: [{ name: '日志', extensions: ['log', 'txt'] }] })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    this.selected.set(id, result.filePaths[0])
    return { ok: true }
  }
}
