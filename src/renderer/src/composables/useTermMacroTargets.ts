/**
 * 分屏共享快捷命令栏的执行目标登记表。
 *
 * 快捷命令库全局只有一份（useTermMacros），两个终端分屏时各渲染一份列表只是重复：
 * 改为只留一条共享栏，命令转给「当前选中的终端」。
 * 终端面板挂载时在这里登记自己的执行方式（串口 / SSH / 本地终端写法不同），卸载时注销；
 * 终端获得焦点即成为选中目标，没点过任何终端时默认分屏里的第一个。
 */
import { ref, shallowReactive } from 'vue'
import type { PluginActionReference, PluginMacroAction, QuickCmdStep } from '../../../shared/term-macro'

export interface TermMacroTarget {
  panelId: string
  /** 标签标题（COM1 / root@host / 配置名）：共享栏据此标出命令发往哪个终端 */
  title: () => string | undefined
  /** 未连接时点击命令只提示不执行 */
  enabled: () => boolean
  /** 步骤执行器 */
  writer: (st: QuickCmdStep) => Promise<void> | void
  /** 以下几项由串口面板提供：插件动作绑定在该面板上 */
  getConnectionGeneration?: () => number
  runPluginAction?: (action: PluginActionReference) => Promise<void>
  getPluginActions?: () => Promise<{ actions: PluginMacroAction[]; error?: string }>
  pluginConfigVersion?: () => number
  requestPluginConfig?: () => void
  /** 自带侧栏底部的提示（如 SSH 的明文密码提醒），共享栏里照常显示 */
  footnote?: () => string
}

const targets = shallowReactive(new Map<string, TermMacroTarget>())
/** 最近获得焦点的终端 */
const activePanelId = ref<string>()

/** 登记执行目标，返回注销函数 */
export function registerTermMacroTarget(target: TermMacroTarget): () => void {
  targets.set(target.panelId, target)
  return () => {
    targets.delete(target.panelId)
    if (activePanelId.value === target.panelId) activePanelId.value = undefined
  }
}

export function activateTermMacroTarget(panelId: string): void {
  activePanelId.value = panelId
}

export function getTermMacroTargets(panelIds: string[]): TermMacroTarget[] {
  return panelIds.map((id) => targets.get(id)).filter((t): t is TermMacroTarget => t !== undefined)
}

/** 共享栏当前的目标：优先选中的终端；没选过、或选中的已不在这些面板里，就取第一个 */
export function pickTermMacroTarget(panelIds: string[]): TermMacroTarget | undefined {
  const preferred = activePanelId.value
  return (
    (preferred && panelIds.includes(preferred) ? targets.get(preferred) : undefined) ??
    getTermMacroTargets(panelIds)[0]
  )
}

let sharedFinishRecording: (() => void) | undefined

/** 共享栏登记「停止录制并整理保存」的入口；终端工具栏上的停止录制按钮转给它 */
export function registerSharedRecordingFinisher(fn: (() => void) | undefined): void {
  sharedFinishRecording = fn
}

/** 有共享栏时由它停止录制并返回 true；否则返回 false，由调用方自己处理 */
export function finishSharedRecording(): boolean {
  if (!sharedFinishRecording) return false
  sharedFinishRecording()
  return true
}
