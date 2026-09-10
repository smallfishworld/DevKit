/**
 * 宏回放引擎：按步骤延时注入（SendInput），支持倍速/循环/急停
 * 所有 sleep 均分段可中断，保证急停响应
 */
import { injectKey, injectMouseMove, injectMouseButton, injectWheel, injectText } from '../input/inject'
import { waitColor } from './color'
import type { InputEventData, KeyEventData, MouseEventData, WheelEventData } from '../../../shared/types'
import type { MacroFile, MacroStep } from '../../../shared/macro'

export interface PlayOptions {
  speed: number
  /** 0 = 无限循环 */
  loops: number
}

export interface PlayProgress {
  running: boolean
  loop: number
  loops: number
  index: number
  total: number
  message?: string
}

export interface PlayResult {
  completed: boolean
  stopped: boolean
  error: string | null
  elapsedMs: number
}

class Player {
  private stopFlag = false
  private playing = false
  /** 已注入但未释放的按键（急停时统一抬起，避免按键卡死） */
  private heldKeys = new Set<number>()

  isPlaying(): boolean {
    return this.playing
  }

  requestStop(): void {
    this.stopFlag = true
  }

  private async sleepInterruptible(ms: number): Promise<boolean> {
    if (ms <= 0) return !this.stopFlag
    const slice = 20
    let remain = ms
    while (remain > 0) {
      if (this.stopFlag) return false
      const step = Math.min(slice, remain)
      await new Promise((r) => setTimeout(r, step))
      remain -= step
    }
    return !this.stopFlag
  }

  private async injectInput(data: InputEventData): Promise<void> {
    if (data.kind === 'key') {
      await this.injectKeyData(data)
    } else if (data.kind === 'mouse') {
      await this.injectMouseData(data)
    } else {
      const w = data as WheelEventData
      injectWheel(w.x, w.y, w.delta)
    }
  }

  private async injectKeyData(data: KeyEventData): Promise<void> {
    if (data.down) {
      this.heldKeys.add(data.vk)
      injectKey(data.vk, true)
    } else {
      this.heldKeys.delete(data.vk)
      injectKey(data.vk, false)
    }
  }

  private async injectMouseData(data: MouseEventData): Promise<void> {
    if (data.action === 'move') {
      injectMouseMove(data.x, data.y)
      return
    }
    // 点击前先移到目标位置
    injectMouseMove(data.x, data.y)
    await new Promise((r) => setTimeout(r, 15))
    injectMouseButton(data.button, data.action === 'down')
  }

  private releaseHeldKeys(): void {
    for (const vk of this.heldKeys) injectKey(vk, false)
    this.heldKeys.clear()
  }

  async start(
    macro: MacroFile,
    opts: PlayOptions,
    onProgress: (p: PlayProgress) => void
  ): Promise<PlayResult> {
    if (this.playing) {
      return { completed: false, stopped: false, error: '已有宏在回放中', elapsedMs: 0 }
    }
    this.playing = true
    this.stopFlag = false
    this.heldKeys.clear()
    const startedAt = Date.now()
    const enabled = macro.steps.filter((s) => s.enabled)
    const speed = Math.max(0.1, Math.min(10, opts.speed || 1))
    const loops = opts.loops
    let loop = 0
    let error: string | null = null
    let completedNormally = false

    try {
      while (loops === 0 || loop < loops) {
        loop += 1
        for (let i = 0; i < enabled.length; i += 1) {
          if (this.stopFlag) break
          const step: MacroStep = enabled[i]
          onProgress({ running: true, loop, loops, index: i + 1, total: enabled.length })
          const ok = await this.sleepInterruptible(step.delayMs / speed)
          if (!ok) break
          switch (step.type) {
            case 'input':
              await this.injectInput(step.data as InputEventData)
              break
            case 'text':
              injectText(step.text ?? '')
              break
            case 'delay':
              break
            case 'wait-color': {
              const satisfied = await waitColor(
                step.wait as NonNullable<MacroStep['wait']>,
                () => this.stopFlag
              )
              if (!satisfied && !this.stopFlag) {
                throw new Error(
                  `等待颜色超时 (${step.wait?.color} @ ${step.wait?.x},${step.wait?.y}，${step.wait?.timeoutMs}ms)`
                )
              }
              break
            }
          }
        }
        if (this.stopFlag) break
        if (loops !== 0 && loop >= loops) {
          completedNormally = true
          break
        }
        if (loops === 0) {
          completedNormally = true // 仅用于标记"不是错误"，无限循环只有被停止才会退出
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      this.releaseHeldKeys()
      this.playing = false
      onProgress({ running: false, loop, loops, index: 0, total: enabled.length })
    }

    return {
      completed: completedNormally && !error,
      stopped: this.stopFlag,
      error,
      elapsedMs: Date.now() - startedAt
    }
  }
}

export const player = new Player()
