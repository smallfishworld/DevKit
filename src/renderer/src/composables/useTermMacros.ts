/**
 * 终端快捷命令（宏）共享逻辑：串口助手 / SSH 终端共用
 * 模块级单例状态——宏库一份，录制状态全局唯一（任一面板开启录制即全局录制）
 * 录制期间不弹窗；终端键入（回车确认）与命令间隔（自动延时）都记入
 */
import { ref } from 'vue'
import type { QuickCmd, QuickCmdStep, QuickCmdsConfig } from '../../../shared/term-macro'
import { DEFAULT_QUICKCMDS_CONFIG, migrateQuickCmd } from '../../../shared/term-macro'

// ---------- 模块级共享状态（所有面板实例共用） ----------
const quickCmds = ref<QuickCmd[]>([])
const groups = ref<string[]>([])
const recording = ref(false)
const playing = ref(false)
const recordedCount = ref(0)
let loaded = false

// 录制暂存
let recSteps: QuickCmdStep[] = []
let recBuf = ''
let recLastAt = 0

/** 宏库为全局配置，不走具体面板实例，用固定 panelId */
const GLOBAL_PANEL = '__global__'

export function useTermMacros() {
  /** 首次调用时加载宏库（含旧版 serial.quickCmds 迁移） */
  async function loadOnce(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const cfg = (await window.api.invoke('quickcmds', 'config:get', GLOBAL_PANEL)) as QuickCmdsConfig
      quickCmds.value = cfg.list ?? []
      groups.value = cfg.groups ?? []
    } catch {
      quickCmds.value = DEFAULT_QUICKCMDS_CONFIG.list
      groups.value = []
    }
  }

  async function persist(): Promise<void> {
    await window.api
      .invoke('quickcmds', 'config:set', GLOBAL_PANEL, {
        list: JSON.parse(JSON.stringify(quickCmds.value)),
        groups: JSON.parse(JSON.stringify(groups.value))
      })
      .catch(() => {})
  }

  /** 新建分组（可先建组，之后往组内添加命令；空分组也持久化保留） */
  async function createGroup(name: string): Promise<boolean> {
    const n = name.trim()
    if (!n) return false
    // 不与已声明分组或命令上的分组重名
    const exists =
      groups.value.includes(n) ||
      quickCmds.value.some((c) => (c.group ?? '').trim() === n)
    if (exists) return false
    groups.value = [...groups.value, n]
    await persist()
    return true
  }

  /** 重命名分组：更新声明列表，并同步改名该组下所有命令的 group 字段 */
  async function renameGroup(old: string, name: string): Promise<boolean> {
    const n = name.trim()
    if (!n || n === old) return false
    // 新名不能与其它分组/命令冲突
    const exists =
      groups.value.some((g) => g.trim() !== old && g.trim() === n) ||
      quickCmds.value.some((c) => (c.group ?? '').trim() !== old && (c.group ?? '').trim() === n)
    if (exists) return false
    groups.value = groups.value.map((g) => (g.trim() === old ? n : g))
    quickCmds.value = quickCmds.value.map((c) =>
      (c.group ?? '').trim() === old ? { ...c, group: n } : c
    )
    await persist()
    return true
  }

  /** 把若干宏移动到某分组末尾（group 为空 = 移到未分组末尾）；移动后原空声明的分组保留 */
  async function moveToGroup(names: string[], group: string): Promise<void> {
    if (names.length === 0) return
    const set = new Set(names)
    const dragged = quickCmds.value
      .filter((c) => set.has(c.name))
      .map((c) => ({ ...c, group }))
    if (dragged.length === 0) return
    const rest = quickCmds.value.filter((c) => !set.has(c.name))
    // 插到目标组最后一个成员之后（组内显示顺序 = quickCmds 顺序）；
    // 目标组暂无成员时保持原相对位置即可（显示不受数组中位置影响）
    let lastIdx = -1
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      if ((rest[i].group ?? '').trim() === group) {
        lastIdx = i
        break
      }
    }
    let insertAt: number
    if (lastIdx >= 0) insertAt = lastIdx + 1
    else {
      const firstOrig = quickCmds.value.findIndex((c) => set.has(c.name))
      insertAt = Math.min(Math.max(firstOrig, 0), rest.length)
    }
    rest.splice(insertAt, 0, ...dragged)
    quickCmds.value = rest
    await persist()
  }

  /** 拖动排序：把若干宏插到 beforeName 之前；group 非 null 时同时移入目标组（'' = 未分组） */
  async function reorderCmds(names: string[], beforeName: string, group: string | null): Promise<void> {
    if (names.length === 0) return
    const set = new Set(names)
    const dragged = quickCmds.value.filter((c) => set.has(c.name))
    if (dragged.length === 0) return
    const rest = quickCmds.value.filter((c) => !set.has(c.name))
    const withGroup = group === null ? dragged : dragged.map((c) => ({ ...c, group }))
    const idx = rest.findIndex((c) => c.name === beforeName)
    rest.splice(idx < 0 ? rest.length : idx, 0, ...withGroup)
    quickCmds.value = rest
    await persist()
  }

  /** 拖动分组排序：dragged 组移到 before 组之前（before 为 null 移到末尾）；未声明的组顺带声明 */
  async function reorderGroups(dragged: string, before: string | null): Promise<void> {
    const arr = [...groups.value]
    for (const n of before ? [dragged, before] : [dragged]) {
      if (n && !arr.includes(n)) arr.push(n)
    }
    const from = arr.indexOf(dragged)
    if (from < 0) return
    arr.splice(from, 1)
    const idx = before ? arr.indexOf(before) : -1
    if (idx >= 0) arr.splice(idx, 0, dragged)
    else arr.push(dragged)
    groups.value = arr
    await persist()
  }

  /** 删除空分组：从声明列表移除；组内命令的 group 字段一并清空（防孤儿组名） */
  async function removeGroup(name: string): Promise<void> {
    groups.value = groups.value.filter((g) => g !== name)
    quickCmds.value = quickCmds.value.map((c) =>
      (c.group ?? '').trim() === name ? { ...c, group: '' } : c
    )
    await persist()
  }

  /**
   * 录制开关。开启 → 无弹窗纯指示；停止 → 返回录到的步骤（空数组 = 无内容）
   */
  function toggleRecord(): { stopped: boolean; steps: QuickCmdStep[] } {
    if (recording.value) {
      finalizeRecBuf()
      recording.value = false
      const steps = recSteps
      recSteps = []
      return { stopped: true, steps }
    }
    recSteps = []
    recBuf = ''
    recLastAt = Date.now()
    recordedCount.value = 0
    recording.value = true
    return { stopped: false, steps: [] }
  }

  /** 录制：记一条命令步骤；间隔 ≥500ms 自动插延时步骤（按 100ms 取整） */
  function recordCmdStep(text: string, mode: 'ascii' | 'hex', crlf: boolean): void {
    if (!text) return
    const now = Date.now()
    const gap = now - recLastAt
    if (recSteps.length > 0 && gap >= 500) {
      recSteps.push({ type: 'sleep', ms: Math.round(gap / 100) * 100 })
    }
    recSteps.push({ type: 'cmd', text, mode, crlf })
    recLastAt = now
    recordedCount.value = recSteps.length
  }

  /** 录制：终端逐字符键入。回车确认一条命令；转义/控制字符识别为按键步骤 */
  function recordTermKey(data: string): void {
    if (data === '\r' || data === '\n') {
      finalizeRecBuf()
      return
    }
    // 特殊键：ESC 序列（方向键/Home/F1~）或控制字符（Ctrl+C 等）单独成按键步骤
    if (data.startsWith('\x1b') || (data.length === 1 && data.charCodeAt(0) < 32)) {
      finalizeRecBuf()
      recSteps.push({ type: 'key', key: data })
      recLastAt = Date.now()
      recordedCount.value = recSteps.length
      return
    }
    recBuf += data
  }

  function finalizeRecBuf(): void {
    if (recBuf) {
      recordCmdStep(recBuf, 'ascii', true)
      recBuf = ''
    } else {
      recLastAt = Date.now() // 空回车：重置延时基准
    }
  }

  /** 发送栏发送时调用：整条记为一个命令步骤 */
  function recordSend(text: string, mode: 'ascii' | 'hex', crlf: boolean): void {
    if (recording.value) recordCmdStep(text, mode, crlf)
  }

  /** 保存宏（新增或原位替换） */
  async function saveCmd(draft: QuickCmd, editIdx: number): Promise<void> {
    if (editIdx >= 0) {
      quickCmds.value[editIdx] = draft
    } else {
      quickCmds.value = [...quickCmds.value.filter((c) => c.name !== draft.name), draft]
    }
    await persist()
  }

  async function removeCmd(name: string): Promise<void> {
    quickCmds.value = quickCmds.value.filter((c) => c.name !== name)
    await persist()
  }

  /** 复制一条宏：名字加数字后缀 `名字 (N)`，取下一个空缺序号，避免重名 */
  async function copyCmd(name: string): Promise<void> {
    const src = quickCmds.value.find((c) => c.name === name)
    if (!src) return
    const base = name.replace(/\s*\(\d+\)\s*$/, '') // 去掉已有 (N) 后缀，得到基础名
    // 统计同基础名现有的最大序号，下一个序号 = 最大+1
    const nums = quickCmds.value
      .map((c) => c.name.match(new RegExp(`^${escapeReg(base)}\\s*\\((\\d+)\\)$`)))
      .filter(Boolean)
      .map((m) => Number(m![1]))
    const next = (nums.length ? Math.max(...nums) : 0) + 1
    const newName = `${base} (${next})`
    const clone: QuickCmd = {
      name: newName,
      group: src.group ?? '',
      steps: JSON.parse(JSON.stringify(src.steps))
    }
    quickCmds.value = [...quickCmds.value.filter((c) => c.name !== newName), clone]
    await persist()
  }

  /** 正则转义（用于按基础名统计已有序号） */
  function escapeReg(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 导出宏库为 DevKit JSON（空库时导出无意义，返回 false 由调用方提示） */
  async function exportCmds(): Promise<{ ok: boolean; count?: number; error?: string }> {
    const res = (await window.api.invoke('quickcmds', 'export', GLOBAL_PANEL, {
      list: JSON.parse(JSON.stringify(quickCmds.value))
    })) as { ok: boolean; count?: number; error?: string }
    return res
  }

  /** 导入：文件选择框自动识别 DevKit JSON / MobaXterm 宏文件；同名覆盖，其余追加 */
  async function importCmds(): Promise<{ ok: boolean; count?: number; source?: string; error?: string }> {
    const res = (await window.api.invoke('quickcmds', 'import', GLOBAL_PANEL)) as {
      ok: boolean
      list?: QuickCmd[]
      source?: string
      error?: string
    }
    if (!res.ok || !res.list) return { ok: false, error: res.error ?? '导入失败' }
    // 合并：同名（含分组）覆盖旧宏，其余追加到列表末尾
    const next = [...quickCmds.value]
    for (const c of res.list) {
      const idx = next.findIndex((x) => x.name === c.name)
      if (idx >= 0) next[idx] = c
      else next.push(c)
    }
    quickCmds.value = next
    await persist()
    return { ok: true, count: res.list.length, source: res.source }
  }

  /**
   * 回放：按步骤顺序执行。writer 由面板注入（串口 / SSH 的写法不同）；
   * enabled 由面板注入（未连接时中止）
   */
  async function playCmd(
    cmd: QuickCmd,
    writer: (st: QuickCmdStep) => void,
    enabled: () => boolean
  ): Promise<void> {
    if (!enabled() || playing.value) return
    playing.value = true
    try {
      for (const st of cmd.steps) {
        if (!enabled()) break
        if (st.type === 'sleep') {
          await new Promise((r) => setTimeout(r, Math.max(0, st.ms ?? 0)))
        } else {
          writer(st)
          await new Promise((r) => setTimeout(r, 30)) // 命令间至少 30ms
        }
      }
    } finally {
      playing.value = false
    }
  }

  return {
    quickCmds,
    groups,
    recording,
    playing,
    recordedCount,
    loadOnce,
    createGroup,
    renameGroup,
    removeGroup,
    reorderGroups,
    reorderCmds,
    toggleRecord,
    recordTermKey,
    recordSend,
    saveCmd,
    removeCmd,
    copyCmd,
    moveToGroup,
    playCmd,
    exportCmds,
    importCmds
  }
}
