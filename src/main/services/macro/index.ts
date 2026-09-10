/**
 * 键鼠宏工具服务：录制/回放/宏库/热键/设置 的总装配
 * 面板为单实例，attach 时记录 panelId 用于事件推送
 */
import { dialog } from 'electron'
import { promises as fs } from 'node:fs'
import type { ToolService } from '../../ipc'
import { emitToolEvent } from '../../ipc'
import type { InputEventData } from '../../../shared/types'
import type { MacroFile, MacroSettings, MacroStep, WaitColorSpec } from '../../../shared/macro'
import { startRecording, stopRecording, isRecording } from './recorder'
import { player, type PlayProgress, type PlayResult } from './player'
import { pickPoint } from './picker'
import { showHud, hideHud } from './hud'
import {
  loadMacroSettings,
  saveMacroSettings
} from './configStore'
import {
  registerHotkey,
  unregisterAll,
  unregisterHotkey
} from './hotkeys'
import { deleteMacro, listMacros, saveMacro } from './store'

let stepIdSeq = 1
const nextStepId = (): string => `s${Date.now().toString(36)}-${stepIdSeq++}`

/** 原始事件序列 -> 宏步骤（相邻事件间隔转为延时） */
function rawToSteps(raw: { data: InputEventData; time: number }[]): MacroStep[] {
  const steps: MacroStep[] = []
  let last = 0
  for (const item of raw) {
    const delayMs = last === 0 ? 0 : Math.max(0, item.time - last)
    last = item.time
    steps.push({
      id: nextStepId(),
      segment: '录制',
      enabled: true,
      type: 'input',
      delayMs,
      data: item.data
    })
  }
  return steps
}

class MacroService implements ToolService {
  private settings: MacroSettings | null = null
  private attachedPanel = ''
  private currentMacro: MacroFile | null = null

  private emit(type: string, payload: unknown): void {
    if (!this.attachedPanel) return
    emitToolEvent('macro', this.attachedPanel, type, payload)
  }

  /** 应用启动时调用：加载设置并注册全局热键 */
  async init(): Promise<void> {
    this.settings = await loadMacroSettings()
    this.applyHotkeys()
  }

  private applyHotkeys(): { id: string; accelerator: string; ok: boolean; reason?: string }[] {
    if (!this.settings) return []
    const s = this.settings
    const results: { id: string; accelerator: string; ok: boolean; reason?: string }[] = []
    const reg = (id: string, acc: string, handler: () => void): void => {
      const r = registerHotkey(id, acc, handler)
      results.push({ id, accelerator: acc, ok: r.ok, reason: r.reason })
    }
    reg('macro-record', s.hotkeyRecord, () => {
      if (isRecording()) this.finishRecord()
      else this.beginRecord()
    })
    reg('macro-play', s.hotkeyPlay, () => {
      if (isRecording()) return // 录制期间按回放热键：已被录制器过滤，不触发回放
      if (player.isPlaying()) {
        player.requestStop()
      } else if (this.currentMacro) {
        void this.playCurrent()
      }
    })
    reg('macro-stop', s.hotkeyStop, () => {
      if (isRecording()) this.finishRecord()
      if (player.isPlaying()) player.requestStop()
    })
    // 宏库各自的独立热键
    void listMacros().then((items) => {
      for (const { filename, macro } of items) {
        if (macro.meta.hotkey) {
          registerHotkey(`file:${filename}`, macro.meta.hotkey, () => {
            this.currentMacro = macro
            void this.playCurrent()
          })
        }
      }
    })
    return results
  }

  private beginRecord(): void {
    if (!this.settings || isRecording() || player.isPlaying()) return
    // 自身热键保持注册：录制器靠 matchesAnyHotkey 过滤其按键（注销反而会让它被录进宏）
    const name = `录制 ${new Date().toLocaleTimeString()}`
    this.currentMacro = {
      version: 1,
      meta: { name, hotkey: '', createdAt: Date.now(), updatedAt: Date.now() },
      steps: []
    }
    startRecording(this.settings, {
      onEvent: (count) => {
        this.emit('record', { recording: true, count })
        showHud(`● 录制中  ${count} 个事件\n${this.settings?.hotkeyRecord} 停止`, true)
      },
      onStop: () => {}
    })
    this.emit('record', { recording: true, count: 0 })
    showHud(`● 录制中\n${this.settings.hotkeyRecord} 停止`, true)
  }

  private finishRecord(): void {
    if (!isRecording()) return // 未在录制时调用（含重复停止）：不发伪事件
    const raw = stopRecording()
    hideHud()
    if (this.currentMacro && raw.length > 0) {
      this.currentMacro.steps = rawToSteps(raw)
    }
    this.emit('record', {
      recording: false,
      count: raw.length,
      macro: this.currentMacro
    })
  }

  private async playCurrent(): Promise<PlayResult | null> {
    if (!this.currentMacro) return null
    const s = this.settings
    const result = await player.start(
      this.currentMacro,
      { speed: s?.speed ?? 1, loops: s?.loops ?? 1 },
      (p: PlayProgress) => {
        if (p.running) {
          this.emit('play', p)
          showHud(
            `▶ 回放中  第 ${p.loop}${p.loops === 0 ? '∞' : `/${p.loops}`} 轮  ${p.index}/${p.total}\n${s?.hotkeyStop} 停止`
          )
        } else {
          this.emit('play', p)
          hideHud()
        }
      }
    )
    this.emit('play', { running: false, result })
    return result
  }

  invoke(panelId: string, action: string, payload: unknown): unknown {
    // 单实例面板：记录 panelId
    if (action === 'attach') {
      this.attachedPanel = panelId
      return { settings: this.settings }
    }
    if (!this.settings) return { error: 'macro 服务未初始化' }

    switch (action) {
      case 'settings:get':
        return { settings: this.settings }
      case 'settings:set': {
        const { settings } = payload as { settings: MacroSettings }
        this.settings = settings
        unregisterAll()
        const results = this.applyHotkeys()
        void saveMacroSettings(settings)
        return { ok: true, results }
      }
      case 'record:start':
        this.beginRecord()
        return { recording: isRecording() }
      case 'record:stop':
        this.finishRecord()
        return { macro: this.currentMacro }
      case 'record:status':
        return { recording: isRecording() }
      case 'play:status':
        return { playing: player.isPlaying() }
      case 'play:start': {
        if (isRecording()) return { error: '正在录制，请先停止录制' }
        if (player.isPlaying()) return { error: '正在回放中' }
        const { macro, speed, loops } = payload as {
          macro: MacroFile
          speed?: number
          loops?: number
        }
        this.currentMacro = macro
        const p = player.start(
          macro,
          { speed: speed ?? this.settings.speed, loops: loops ?? this.settings.loops },
          (progress) => {
            this.emit('play', progress)
            if (progress.running) {
              showHud(
                `▶ 回放中  第 ${progress.loop}${progress.loops === 0 ? '∞' : `/${progress.loops}`} 轮  ${progress.index}/${progress.total}\n${this.settings?.hotkeyStop} 停止`
              )
            } else {
              hideHud()
            }
          }
        )
        return p.then((result) => {
          this.emit('play', { running: false, result })
          return result
        })
      }
      case 'play:stop':
        player.requestStop()
        return { ok: true }
      case 'macro:save': {
        const { macro, originalFilename } = payload as { macro: MacroFile; originalFilename?: string }
        macro.meta.updatedAt = Date.now()
        // 重命名场景：旧文件由 saveMacro 删除，旧热键在此注销
        if (originalFilename) unregisterHotkey(`file:${originalFilename}`)
        return saveMacro(macro, originalFilename)
          .then((filename) => {
            unregisterHotkey(`file:${filename}`) // 同名覆盖时先注销旧回调
            let hotkey: { ok: boolean; reason?: string } = { ok: true }
            if (macro.meta.hotkey) {
              hotkey = registerHotkey(`file:${filename}`, macro.meta.hotkey, () => {
                this.currentMacro = macro
                void this.playCurrent()
              })
            }
            return { ok: true, filename, hotkey }
          })
          .catch((err: Error) => ({ ok: false, error: err.message }))
      }
      case 'macro:delete': {
        const { filename } = payload as { filename: string }
        return deleteMacro(filename).then(() => {
          unregisterHotkey(`file:${filename}`) // 删除后热键不再触发已不存在的宏
          return { ok: true }
        })
      }
      case 'macro:list':
        return listMacros()
      case 'macro:export': {
        const { macro } = payload as { macro: MacroFile }
        return dialog
          .showSaveDialog({
            title: '导出宏',
            defaultPath: `${macro.meta.name}.json`,
            filters: [{ name: '宏文件', extensions: ['json'] }]
          })
          .then(async ({ canceled, filePath }) => {
            if (canceled || !filePath) return { ok: false }
            await fs.writeFile(filePath, JSON.stringify(macro, null, 2), 'utf-8')
            return { ok: true }
          })
      }
      case 'macro:import': {
        return dialog
          .showOpenDialog({
            title: '导入宏',
            filters: [{ name: '宏文件', extensions: ['json'] }],
            properties: ['openFile']
          })
          .then(async ({ canceled, filePaths }) => {
            if (canceled || !filePaths[0]) return { ok: false }
            const raw = await fs.readFile(filePaths[0], 'utf-8')
            const macro = JSON.parse(raw) as MacroFile
            macro.meta.updatedAt = Date.now()
            const filename = await saveMacro(macro)
            // 导入的宏若带热键，立即注册（此前需重启才生效）
            if (macro.meta.hotkey) {
              unregisterHotkey(`file:${filename}`)
              registerHotkey(`file:${filename}`, macro.meta.hotkey, () => {
                this.currentMacro = macro
                void this.playCurrent()
              })
            }
            return { ok: true, macro }
          })
      }
      case 'macro:pick-point':
        return pickPoint()
      default:
        throw new Error(`macro 服务未知操作: ${action}`)
    }
  }

  dispose(): void {
    if (isRecording()) stopRecording()
    player.requestStop()
    hideHud()
  }
}

export const macroService = new MacroService()

export type { MacroFile, MacroSettings, MacroStep, WaitColorSpec }
