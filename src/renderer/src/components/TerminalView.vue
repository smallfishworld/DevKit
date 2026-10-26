<script setup lang="ts">
/**
 * 共享终端组件（xterm.js 封装）
 * 串口助手 / SSH 终端共用：ANSI 彩色、VT100 仿真、键盘直入、字体字号与缩放
 * 复制粘贴：选中后左键点击复制；终端内右键直接粘贴
 * 搜索：Ctrl+F 打开搜索条，Enter/下一个按钮向下找，Shift+Enter 向上找
 * 数据流：父组件调 write()/info() 灌入远端输出；@data 把键入原样交给父组件发送
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { resolveGlobalKey, resolveMouseDown, resolveTermKey, localEchoFor } from './termInput'
import { DEFAULT_FLOW_LIMITS, dropNotice, pushDisplay } from './termFlow'
import { crToNewline, fmtStamp, stampLines } from '../../../shared/logtext'
import { VtGuard, reopenResetSequence, type VtGuardStats } from '../../../shared/vtguard'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { toXtermTheme } from '@renderer/theme'

const props = withDefaults(
  defineProps<{
    /** 字体族（首个为有效字体，缺省自动回退到 Consolas/等宽） */
    font?: string
    /** 字号，Ctrl+滚轮缩放范围 9~28 */
    fontSize?: number
    /** 本地回显：远端不回显时勾选可看到自己敲入的字符 */
    localEcho?: boolean
    /** 显示时间戳：每批接收数据前插灰色本地时间 [HH:MM:SS.mmm]（与日志落盘格式一致） */
    showTime?: boolean
    /**
     * 裸 \r 的显示模式：
     * - raw（默认）：真实 VT 语义，\r 只把光标移回行首覆盖重绘
     * - newline：\r 当换行（与日志归一规则一致），用于设备用 \r 刷进度/失步重绘时看清每一帧
     */
    crMode?: 'raw' | 'newline'
    /**
     * 回滚保护（默认关，串口面板显式开启）：中和 `CSI 3J`（擦回滚）、`ESC c`（硬复位）、
     * 备用屏切换 —— 这三者会销毁已滚出屏幕的内容，表现为「前半段看不见、滚动也看不见」。
     * SSH/本地终端不开：vim/top 依赖备用屏，`clear` 擦回滚也是远端终端的正常语义。
     */
    guardScrollback?: boolean
  }>(),
  {
    font: 'Consolas',
    fontSize: 13,
    localEcho: false,
    showTime: false,
    crMode: 'raw',
    guardScrollback: false
  }
)

const appearance = useAppearanceStore()

const emit = defineEmits<{
  /** 键盘原始输入（Enter 为 \r），由父组件决定发到哪 */
  (e: 'data', text: string): void
  /** 终端行列变化（SSH 需转发 setWindow，串口可忽略） */
  (e: 'resize', size: { cols: number; rows: number }): void
  /** 缩放/换字号时同步（父组件持久化） */
  (e: 'update:fontSize', size: number): void
  /** 回滚保护命中（每批最多一次，已累计）：父组件用来提示「设备发了清回滚/复位」 */
  (e: 'guard', stats: VtGuardStats): void
  /** 设备切了备用屏（原样放行，仅统计）：父组件用来在日志里留痕，便于事后归因 */
  (e: 'altscreen', count: number): void
}>()

const DEFAULT_FONT_SIZE = 13
const SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]

const termBox = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObserver: ResizeObserver | null = null
/** fit 节流的收尾定时器（拖动停止后补最后一次重排） */
let fitTrailingTimer: ReturnType<typeof setTimeout> | null = null
// 被 select/clearSelection 补丁包装前的原始方法（doSearch 需要绕过锁造临时锚点选区）
let rawSelect: ((col: number, row: number, length: number) => void) | null = null

function fontFamilyCss(): string {
  // 末尾追加 CJK 回退：Consolas / Courier New 均无中文字形，
  // WebGL 渲染器遇缺字形会留空（中文输出「不显示」的根因）。
  // 中文字形放在等宽字体之后，拉丁字符仍走 Consolas，CJK 自然双宽对齐。
  return `${props.font}, Consolas, "Courier New", "Microsoft YaHei", "PingFang SC", monospace`
}

/** 重建 WebGL 渲染器：GPU 上下文丢失/窗口隐藏后恢复用 */
function recreateWebgl(): void {
  if (!term) return
  try {
    const addon = new WebglAddon()
    // GPU 驱动重置（如远程桌面切换、驱动恢复）会触发 contextLoss：不处理会留下
    // 花屏/蒙版状残影。丢弃当前渲染器立即重建；重建失败自动回退 DOM 渲染。
    // 捕获具体实例：旧实例销毁后可能仍派发一次排队的 contextLoss，
    // 若读共享变量会误杀新建的渲染器。
    addon.onContextLoss(() => {
      if (webglAddon !== addon) return
      webglAddon?.dispose()
      webglAddon = null
      recreateWebgl()
    })
    webglAddon = addon
    term.loadAddon(addon)
  } catch {
    webglAddon = null
  }
}

/** 窗口最小化/隐藏时 Windows 会丢失 GPU 上下文，回到可见时重建 WebGL 渲染器避免花屏 */
function onVisibilityChange(): void {
  if (document.hidden) {
    webglAddon?.dispose()
    webglAddon = null
  } else if (term) {
    recreateWebgl()
    fitAddon?.fit()
  }
}

onMounted(() => {
  if (!termBox.value || term) return
  term = new Terminal({
    fontFamily: fontFamilyCss(),
    fontSize: props.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    convertEol: true, // 兼容只发 \n 的裸设备；\r\n 设备不受影响
    // 回滚 20 万行：真实日志长度（60~100 字符/行）实测 36 万行满缓冲堆 ~138MB、
    // Major GC 暂停 48-54ms（20 万行 ~80MB / 17-27ms，tests/probes/xterm-heap-probe.js 可复测）；
    // 长会话持续打印下 50ms 级暂停就是肉眼可见的周期性卡顿，故维持 20 万行。
    // 全量历史不丢：日志双通道（主进程 Buffer 堆外，不受 GC 影响）
    scrollback: 200_000,
    // addon-search 的结果高亮依赖 registerDecoration（proposed API）
    allowProposedApi: true,
    theme: toXtermTheme(appearance.terminalTheme)
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  searchAddon.onDidChangeResults(onSearchResults)
  // 查找打开期间用户点击终端后锁定选区操作：SearchAddon 在每次终端写入后会延时
  // findPrevious(incremental) 重新 select 命中项，把用户刚拖出的手动选区顶掉。
  // 锁定期间 addon 的 select/clearSelection 变为空操作（高亮装饰不受影响），
  // 回到查找框触发 doSearch 时解锁，命中导航恢复正常。
  const boundSelect = term.select.bind(term)
  const boundClearSelection = term.clearSelection.bind(term)
  rawSelect = boundSelect
  term.select = (col: number, row: number, length: number): void => {
    if (!selectionLocked) boundSelect(col, row, length)
  }
  term.clearSelection = (): void => {
    if (!selectionLocked) boundClearSelection()
  }
  term.open(termBox.value)
  fitAddon.fit()

  // WebGL 渲染器：刷屏日志高吞吐下性能远优于默认 DOM 渲染器
  // （GPU 不可用时 addon 会告警并自动回退 DOM，不影响功能）
  recreateWebgl()
  document.addEventListener('visibilitychange', onVisibilityChange)
  // 键盘直入：xterm 捕获按键后交给父组件发送
  term.onData((data) => {
    if (props.localEcho) {
      // \x7f/\b 被 VT 解析器当无操作，直接回写屏幕删除会失效（见 localEchoFor）
      writeRaw(localEchoFor(data))
      midLine = !/[\r\n]$/.test(data)
    }
    emit('data', data)
  })
  term.onResize(({ cols, rows }) => emit('resize', { cols, rows }))
  // 容器尺寸变化（含标签页切换 0→有尺寸）时重排。节流 120ms：
  // fit 改变列数时 xterm 要对整个回滚缓冲重排换行（O(行数×列数)，50 万行时单次即数百 ms），
  // 拖侧栏/缩放窗口时鼠标每帧触发 resize，不节流会连续叠加 reflow 把界面卡死
  const FIT_THROTTLE_MS = 120
  let lastFitAt = 0
  const runFit = (): void => {
    try {
      fitAddon?.fit()
    } catch {
      /* 容器 0 尺寸时 fit 可能抛错，忽略 */
    }
  }
  resizeObserver = new ResizeObserver(() => {
    const now = Date.now()
    const since = now - lastFitAt
    if (since >= FIT_THROTTLE_MS) {
      lastFitAt = now
      if (fitTrailingTimer) {
        clearTimeout(fitTrailingTimer)
        fitTrailingTimer = null
      }
      runFit()
      return
    }
    if (!fitTrailingTimer) {
      fitTrailingTimer = setTimeout(() => {
        fitTrailingTimer = null
        lastFitAt = Date.now()
        runFit()
      }, FIT_THROTTLE_MS - since)
    }
  })
  resizeObserver.observe(termBox.value)
  termBox.value.addEventListener('mousedown', onMousedown, true)
  termBox.value.addEventListener('contextmenu', onContextmenu, true)
  // Ctrl+= / Ctrl+- / Ctrl+0 缩放（拦截，不发给远端）；Ctrl+F 打开搜索
  // Ctrl+C 有选区时复制、无选区时照旧作为中断信号；Ctrl+V 粘贴（判定逻辑见 termInput.ts）
  term.attachCustomKeyEventHandler((ev) => {
    // 查找打开时焦点在终端按 Esc：关闭查找（不拦截会把 \x1b 发给远端）
    if (searchOpen.value && ev.type === 'keydown' && ev.key === 'Escape') {
      closeSearch()
      return false
    }
    const act = resolveTermKey({
      type: ev.type,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      key: ev.key,
      hasSelection: !!term?.getSelection()
    })
    switch (act) {
      case 'zoom-in':
        zoom(1)
        return false
      case 'zoom-out':
        zoom(-1)
        return false
      case 'zoom-reset':
        setFontSize(DEFAULT_FONT_SIZE)
        return false
      case 'open-search':
        openSearch()
        return false
      case 'copy':
        // preventDefault：否则浏览器原生复制/粘贴仍会走 xterm textarea 的 paste 监听，导致粘贴两次
        if (term) void window.api.win.writeClipboard(term.getSelection())
        ev.preventDefault()
        return false
      case 'paste':
        pasteFromClipboard()
        ev.preventDefault()
        return false
      default:
        // 其余 Ctrl 组合（Ctrl+Z/D/\ 等）放行给 xterm 作为终端控制键发出
        return true
    }
  })
  // Ctrl+滚轮缩放（须非 passive 才能阻止默认滚动）
  termBox.value.addEventListener('wheel', onWheel, { passive: false })
  // 全局捕获终端控制键：焦点不在输入框时，Ctrl+C/Z/D/\ 等直接发给终端
  // （终端会话期间这些键始终作为终端输入）
  window.addEventListener('keydown', onGlobalKeydown, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  termBox.value?.removeEventListener('wheel', onWheel)
  termBox.value?.removeEventListener('mousedown', onMousedown, true)
  termBox.value?.removeEventListener('contextmenu', onContextmenu, true)
  if (fitTrailingTimer) {
    clearTimeout(fitTrailingTimer)
    fitTrailingTimer = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
  webglAddon?.dispose()
  webglAddon = null
  // 作废挂起的显示块：term 即将释放，drain 的回调不应再触碰它
  displayQueue = []
  draining = false
  term?.dispose()
  term = null
  fitAddon = null
  searchAddon = null
})

// ---------- 复制粘贴 ----------
// xterm 自身的 mousedown 处理器会立刻清空选区开始新选择；
// 本组件的监听在捕获阶段先于 xterm 执行，才能读到点击前的选区
function onMousedown(e: MouseEvent): void {
  if (!term) return
  const hasSelection = !!term.getSelection()
  const act = resolveMouseDown({
    button: e.button,
    hasSelection
  })
  // 查找打开时点击终端：锁定选区操作，阻止 addon 的延时重选把选区/视口拉回命中处，
  // 用户的手动选区与复制粘贴不受影响；高亮装饰保留。回到查找框触发查找时解锁。
  if (searchOpen.value) {
    selectionLocked = true
  }
  switch (act) {
    case 'copy':
      // 捕获阶段选区尚在（xterm 随后会清空选区开始新选择）
      void window.api.win.writeClipboard(term.getSelection())
      return
    case 'paste':
      pasteFromClipboard()
      return
    default:
      return
  }
}

function onContextmenu(e: MouseEvent): void {
  e.preventDefault()
}

function pasteFromClipboard(): void {
  void window.api.win.readClipboard().then((text) => {
    if (text) emit('data', text)
  })
}

// ---------- 终端控制键（Ctrl+C/Z/D/\ 等） ----------
// xterm 在终端有焦点时已能把 Ctrl+C 发成 \x03；但焦点离开终端后（如点了会话/发送框）
// 这些键会被浏览器默认行为吃掉。这里在捕获阶段兜底：焦点不在输入型元素时，
// 把常用终端控制键作为终端输入发出（判定逻辑见 termInput.ts 的 resolveGlobalKey）。

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (!term) return
  const act = resolveGlobalKey({
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    key: e.key,
    editableTarget: isEditableTarget(e.target),
    hasSelection: !!term.getSelection()
  })
  if (act.kind === 'none') return
  // 阻止浏览器默认行为（如 Ctrl+C 复制），并作为终端输入/复制执行
  e.preventDefault()
  e.stopPropagation()
  if (act.kind === 'copy') void window.api.win.writeClipboard(term.getSelection())
  else emit('data', act.seq)
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey) return
  e.preventDefault()
  zoom(e.deltaY < 0 ? 1 : -1)
}

function zoom(delta: number): void {
  setFontSize(Math.min(28, Math.max(9, (term?.options.fontSize ?? props.fontSize) + delta)))
}

function setFontSize(size: number): void {
  if (!term || !fitAddon) return
  term.options.fontSize = size
  try {
    fitAddon.fit()
  } catch {
    /* 忽略 0 尺寸 */
  }
  emit('update:fontSize', size)
}

watch(
  () => props.font,
  () => {
    if (term) term.options.fontFamily = fontFamilyCss()
  }
)

watch(
  () => props.fontSize,
  (v) => {
    if (term && v !== term.options.fontSize) setFontSize(v)
  }
)

watch(
  () => appearance.terminalTheme,
  (theme) => {
    // xterm 支持运行时替换 theme；不重建实例，因此不会中断串口/SSH 会话。
    if (term) term.options.theme = toXtermTheme(theme)
  }
)

// ---------- 搜索 ----------
const searchOpen = ref(false)
const searchTerm = ref('')
const searchInfo = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
/** 查找打开期间点击终端后置位：抑制 addon 偷换选区，doSearch 时复位 */
let selectionLocked = false

function onSearchResults(r: { resultCount: number; resultIndex: number }): void {
  // 无结果或结果未变化时不显示计数
  if (r.resultCount === 0) searchInfo.value = '无结果'
  else searchInfo.value = `${r.resultIndex + 1}/${r.resultCount}`
}

function openSearch(): void {
  searchOpen.value = true
  // 已有选区时以其为初始关键词（同浏览器 Ctrl+F 习惯）
  const sel = term?.getSelection()
  if (sel) {
    searchTerm.value = sel.trim().split(/\r?\n/)[0] ?? ''
  }
  requestAnimationFrame(() => searchInput.value?.focus())
  if (searchTerm.value) doSearch(true)
}

/** 重建 SearchAddon：dispose 时一并取消其内部 200ms 延时重选定时器
 *  （onWriteParsed 后它会 findPrevious(incremental) 重新选中命中项，
 *  把用户刚做的选区顶掉、光标跳回命中处——复制粘贴因此失效）。 */
function resetSearchAddon(): void {
  if (!term || !searchAddon) return
  searchAddon.dispose()
  searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  searchAddon.onDidChangeResults(onSearchResults)
}

function closeSearch(refocus = true): void {
  searchOpen.value = false
  // 先解锁再清选区：锁定期间 clearSelection 被包装为空操作，不复位会清不掉
  selectionLocked = false
  resetSearchAddon()
  term?.clearSelection()
  if (refocus) term?.focus()
}

const SEARCH_DECORATIONS = {
  // 普通命中：亮黄底 + 深色文字（高对比，暗色终端上醒目）
  matchBackground: '#e6c229',
  matchBorder: '#000000',
  matchOverviewRuler: '#e6c229',
  // 当前项：亮橙红底 + 白色文字 + 白框，明显区别于普通命中
  activeMatchBackground: '#ff5f1f',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ff5f1f'
}

function doSearch(next: boolean): void {
  // 用户主动触发查找（输入/Enter/↑/↓）时解除选区锁定，命中导航恢复正常
  selectionLocked = false
  // 关键词被清空时也要清除查找高亮与选区，否则「删除后仍在查找」
  if (!searchTerm.value) {
    if (searchAddon) searchAddon.clearDecorations()
    term?.clearSelection()
    searchInfo.value = ''
    return
  }
  if (!searchAddon || !term) return
  // 无选区时（用户点过终端后 xterm 已清掉选区），addon 会从缓冲区最顶/最底开始搜，
  // 直接跳到 5000 行回滚缓冲的端点——看起来像「眼前的匹配文本找不到」。
  // 先在当前视口造一个 1 字符临时锚点选区，让查找从可视区域开始
  // （引擎随后的 clearSelection 会清掉锚点，再选中真正的命中项）。
  if (!term.getSelection() && rawSelect) {
    const row = next ? term.buffer.active.viewportY : term.buffer.active.viewportY + term.rows - 1
    rawSelect(0, row, 1)
  }
  if (next) searchAddon.findNext(searchTerm.value, { decorations: SEARCH_DECORATIONS })
  else searchAddon.findPrevious(searchTerm.value, { decorations: SEARCH_DECORATIONS })
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    doSearch(!e.shiftKey) // Enter 下一个，Shift+Enter 上一个
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
}

/** 查找框右键粘贴：Electron 输入框无默认右键菜单，手动把剪贴板内容插入光标处 */
async function onSearchContextmenu(e: MouseEvent): Promise<void> {
  e.preventDefault()
  const input = searchInput.value
  const text = await window.api.win.readClipboard()
  if (!text || !input) return
  const s = input.selectionStart ?? searchTerm.value.length
  const t = input.selectionEnd ?? s
  searchTerm.value = searchTerm.value.slice(0, s) + text + searchTerm.value.slice(t)
  doSearch(true)
  requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(s + text.length, s + text.length)
  })
}

// ---------- 显示队列（有界 + 背压） ----------
// 入队的文本由 drain() 用 xterm 的 write 完成回调逐块推进，在途字节恒为一块。
// xterm 的 WriteBuffer 累积 50MB 会 throw，throw 穿出 IPC 监听器会打断该面板后续数据处理；
// 这里在 8MB 就丢最旧的显示块（只丢屏幕，日志在主进程独立通道，完整性不受影响）。
let displayQueue: string[] = []
let draining = false
/** 清屏请求：等在途块落地后再执行（见 clear()） */
let clearAfterFlight: (() => void) | null = null
/** 上次丢弃提示的时刻：刷屏时每块都提示会淹没屏幕，1s 内只报一次累计量 */
let lastDropNoticeAt = 0
let pendingDropBytes = 0

function drain(): void {
  if (draining || !term || displayQueue.length === 0) return
  const next = displayQueue.shift()
  if (next === undefined) return
  draining = true
  try {
    // 完成回调在 xterm 解析完这一块后触发，再写下一块 —— 这就是端到端背压
    term.write(next, () => {
      draining = false
      // 有待执行的清屏：作废在此期间新到的块，清完再继续，保证清屏排在被清历史之后
      const pendingClear = clearAfterFlight
      if (pendingClear) {
        clearAfterFlight = null
        pendingClear()
      }
      drain()
    })
  } catch {
    // 极端情况下 xterm 仍可能抛（数据被丢弃/实例已释放）：丢掉该块继续，不中断后续数据
    draining = false
    midLine = false
    setTimeout(drain, 0)
  }
}

/**
 * 队列本身按"最新优先"保留，但被丢掉的可能是**未完行**——直接接上提示行会把
 * `[DevKit] ...` 黏在半截设备输出后面。所以在队尾补一个换行：若停在行首（多数情况）
 * 它只会产生一个空行；若停在行中间，提示行才能独占一行。宁可多一个空行也不能拼错。
 */
function enqueue(text: string): void {
  if (!text) return
  const r = pushDisplay(displayQueue, text, DEFAULT_FLOW_LIMITS)
  displayQueue = r.queue
  if (r.droppedBytes > 0) {
    pendingDropBytes += r.droppedBytes
    const now = Date.now()
    if (now - lastDropNoticeAt >= 1000) {
      // 提示行也走 pushDisplay：直接 push 会绕过字节上限，队列可能越界增长，
      // 且绕过 FIFO 账目后提示行自己在下次丢弃时被当成「最旧块」先删掉，用户永远看不到
      lastDropNoticeAt = now
      const a = pushDisplay(displayQueue, '\r\n', DEFAULT_FLOW_LIMITS)
      const b = pushDisplay(a.queue, dropNotice(pendingDropBytes), DEFAULT_FLOW_LIMITS)
      displayQueue = b.queue
      pendingDropBytes = 0
    }
  }
  drain()
}

/** 真落队列的出口：所有显示文本（含本地提示行）都从这里进，保证顺序与背压一致 */
function writeRaw(text: string): void {
  enqueue(text)
}

/** 时间戳逐行补戳逻辑见 shared/logtext.ts 的 stampLines（纯函数，可单测） */
let midLine = false
/** 回滚保护：跨批拼回被切开的序列，命中即回报（逻辑见 shared/vtguard.ts） */
const vtGuard = new VtGuard()

function write(text: string): void {
  if (!text) return
  // 回滚保护先做：CSI 3J / ESC c 会销毁已滚出屏幕的内容，且日志里被剥掉看不见。
  // （备用屏序列只统计不改写——中和它会把全屏程序画到主屏上覆盖现有内容，见 vtguard.ts 文件头）
  let src = text
  if (props.guardScrollback) {
    const g = vtGuard.push(text)
    src = g.out
    // 只在实际中和了序列时上报（备用屏是原样放行的，不能对用户说「已拦下」）
    if (g.stats.eraseScrollback > 0 || g.stats.hardReset > 0) emit('guard', g.stats)
    // 备用屏单独上报：只用于可追溯（写进日志/提示一次），不改写字节
    if (g.stats.altScreen > 0) emit('altscreen', g.stats.altScreen)
    if (!src) return
  }
  // 裸 CR 显示模式：设备用 \r 重绘同一行时，按换行展开才看得到每一帧
  if (props.crMode === 'newline') src = crToNewline(src)
  if (!props.showTime) {
    writeRaw(src)
    midLine = !/[\r\n]$/.test(src)
    return
  }
  const r = stampLines(src, `\x1b[90m[${fmtStamp()}]\x1b[0m `, midLine)
  writeRaw(r.out)
  midLine = r.midLine
}

/** 灌入本地灰色提示行 */
function info(text: string): void {
  writeRaw(`\x1b[90m[DevKit] ${text}\x1b[0m\r\n`)
  midLine = false
}

/**
 * 清屏（含滚动缓冲区）；清屏后光标回到行首。挂起的显示块一并作废（属于被清掉的历史）。
 *
 * 在途块是拦不住的：xterm 的 WriteBuffer 没有取消接口，已经交给它解析的块一定会画出来。
 * 所以「清空」不能只是丢队列后立刻 term.clear()——那样在途块会落在清屏**之后**，
 * 用户看到清完还残留一屏。这里改为：先作废队列，等在途块落地（draining 归 false）再真正清屏。
 */
function clear(): void {
  vtGuard.reset()
  const doClear = (): void => {
    // 作废「清空之前」收到的内容（含等待期间新到的块：它们早于清屏，属于被清历史）
    displayQueue = []
    pendingDropBytes = 0
    term?.clear()
    term?.write('\x1b[2J\x1b[H')
    midLine = false
  }
  if (draining) {
    // 在途块会晚于清屏落地，等它画完再清，避免清完又冒出一屏
    clearAfterFlight = doClear
    return
  }
  doClear()
}

/**
 * 把终端从「上一会话遗留的 VT 状态」里拉回来，但保留回滚内容（重开串口时调用）。
 * 场景：设备在备用屏里断线（vi/top 被打断），不退出就再也看不到主屏历史。
 *
 * `?1049l` **只在确实处于备用屏时才发**：在主屏上发它会让 xterm 的 restoreCursor()
 * 把光标倒回未初始化的 savedY=0，新会话的输出就会原地上覆回滚顶部
 * （实测见 tests/probes/normal-screen-1049l-probe.js：顶部历史被覆盖成新内容）。
 * DECSTR(`ESC[!p`) 只复位模式，不碰光标，单独发对主屏无副作用；但它**不能**退出备用屏
 * （实测见 altscreen-exit-strategy-probe.js），所以两者按需组合。
 */
function resetVtState(): void {
  // 是否真的在备用屏，以 xterm 的 buffer.active.type 为准（与「保护回滚」开关无关，权威）
  vtGuard.reset()
  writeRaw(reopenResetSequence(term?.buffer.active.type === 'alternate' ? 'alternate' : 'normal'))
  midLine = false
}

function focus(): void {
  term?.focus()
}

defineExpose({ write, info, clear, resetVtState, focus, openSearch })
</script>

<template>
  <div class="term-wrap">
    <div v-if="searchOpen" class="search-bar">
      <input
        ref="searchInput"
        v-model="searchTerm"
        class="search-input"
        placeholder="查找…"
        @keydown="onSearchKeydown"
        @input="doSearch(true)"
        @contextmenu="onSearchContextmenu"
      />
      <span class="search-info">{{ searchInfo }}</span>
      <button class="search-btn" title="上一个（Shift+Enter）" @click="doSearch(false)">↑</button>
      <button class="search-btn" title="下一个（Enter）" @click="doSearch(true)">↓</button>
      <button class="search-btn" title="关闭（Esc）" @click="closeSearch()">×</button>
    </div>
    <div
      ref="termBox"
      class="term mono"
      :style="{ background: appearance.terminalTheme.background }"
    ></div>
  </div>
</template>

<style scoped>
.mono {
  font-family: var(--font-mono);
}

.term-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.term {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
}

.term :deep(.xterm .xterm-viewport) {
  background: transparent;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  margin-bottom: 6px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.search-input {
  width: 200px;
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  outline: none;
}

.search-input:focus {
  border-color: var(--el-color-primary);
}

.search-info {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--el-text-color-secondary);
  min-width: 52px;
  text-align: center;
}

.search-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.search-btn:hover {
  background: var(--el-fill-color-darker);
  color: var(--el-text-color-primary);
}
</style>
