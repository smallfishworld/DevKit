import { app, dialog } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emitToolEvent } from '../../ipc'
import { fileNameStamp } from '../../../shared/logtext'
import { OutputWindow, PanelTasks, DisplayBacklog, type HistoryQuery, type HistoryTailQuery, type OutputAck } from '../../../shared/terminal-stream'
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
   * Serial terminal visibility controls only drawing. Capture and disk logging
   * never stop while the tab/window is hidden. The user returns to a LIVE view,
   * not a fast-forward movie of the hidden interval.
   */
  setVisible(id: string, visible: boolean): void {
    if (!visible) {
      this.hiddenViews.add(id)
      this.outputs.get(id)?.suspendDelivery()
      this.setPressure(id, 'display', false)
      return
    }
    if (!this.hiddenViews.delete(id)) return
    const backlog = this.backlogs.get(id)
    this.backlogs.delete(id)
    const oldOutput = this.outputs.get(id)
    if (this.options.has(id) && (backlog?.pending || (oldOutput?.pending ?? 0) > 0)) {
      // A fresh output generation cancels queued pre-hide frames; its reset
      // event is delivered before the latest tail. No historical fast-forward.
      const latest = backlog?.recent() ?? ''
      // Keep the already rendered xterm scrollback; only retire the IPC queue.
      this.resetOutput(id, true)
      if (latest) this.outputs.get(id)?.write('\x1b[0m' + latest)
    } else {
      oldOutput?.resumeDelivery()
    }
  }

  forgetVisible(id: string): void {
    this.hiddenViews.delete(id)
    this.backlogs.delete(id)
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

  resetOutput(id: string, preserveScrollback = false): void {
    this.backlogs.delete(id)
    this.outputs.get(id)?.dispose()
    this.outputs.delete(id)
    emitToolEvent(this.tool, id, preserveScrollback ? 'output:resync' : 'output:reset')
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
    } else this.outputs.get(id)?.write(text)
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
    return ['output:ack', 'output:reset', 'history:query', 'history:tail', 'history:pick', 'history:save'].includes(action)
  }

  invoke(id: string, action: string, payload: unknown): unknown {
    switch (action) {
      case 'output:ack': this.outputs.get(id)?.ack(payload as OutputAck); return true
      case 'output:reset': this.resetOutput(id); return true
      case 'history:query': return this.query(id, (payload ?? {}) as HistoryQuery)
      case 'history:tail': return this.tailPage(id, (payload ?? {}) as HistoryTailQuery)
      case 'history:pick': return this.pick(id)
      case 'history:save': return this.export(id)
    }
  }

  private async tailPage(id: string, request: HistoryTailQuery): Promise<unknown> {
    const history = this.histories.get(id)
    if (!history) return { rows: [], before: 0, hasMore: false, size: 0 }
    return history.tailPage(request)
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
