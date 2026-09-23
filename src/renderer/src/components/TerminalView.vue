<script setup lang="ts">
/**
 * 共享终端组件（xterm.js 封装）
 * 串口助手 / SSH 终端共用：ANSI 彩色、VT100 仿真、键盘直入、字体字号与缩放
 * 复制粘贴：选中后左键点击复制；终端内右键直接粘贴
 * 搜索：Ctrl+F 打开搜索条，Enter/下一个按钮向下找，Shift+Enter 向上找
 * 数据流：父组件调 write()/info() 灌入远端输出；@data 把键入原样交给父组件发送
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { resolveGlobalKey, resolveMouseDown, resolveTermKey } from './termInput'
import { fmtStamp, stampLines } from '../../../shared/logtext'
import type { TerminalTheme } from '../../../shared/theme'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { toXtermTheme } from '@renderer/theme/apply'

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
    /** 回滚行数上限（可滚回查看的历史行数）；MobaXterm 默认 360000，取 500000 留余量 */
    scrollback?: number
    /** 可选会话级主题覆盖；缺省使用全局 Appearance 终端主题 */
    theme?: TerminalTheme
  }>(),
  { font: 'Consolas', fontSize: 13, localEcho: false, showTime: false, scrollback: 500000 }
)

const emit = defineEmits<{
  /** 键盘原始输入（Enter 为 \r），由父组件决定发到哪 */
  (e: 'data', text: string): void
  /** 终端行列变化（SSH 需转发 setWindow，串口可忽略） */
  (e: 'resize', size: { cols: number; rows: number }): void
  /** 缩放/换字号时同步（父组件持久化） */
  (e: 'update:fontSize', size: number): void
}>()

const appearance = useAppearanceStore()
const effectiveTheme = computed(() => props.theme ?? appearance.terminalTheme)

const DEFAULT_FONT_SIZE = 13
const SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28]

const termBox = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObserver: ResizeObserver | null = null
// 被 select/clearSelection 补丁包装前的原始方法（doSearch 需要绕过锁造临时锚点选区）
let rawSelect: ((col: number, row: number, length: number) => void) | null = null

function fontFamilyCss(): string {
  return `${props.font}, Consolas, "Courier New", monospace`
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
    scrollback: props.scrollback,
    // addon-search 的结果高亮依赖 registerDecoration（proposed API）
    allowProposedApi: true,
    theme: toXtermTheme(effectiveTheme.value)
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
      term?.write(data)
      midLine = !/[\r\n]$/.test(data)
    }
    emit('data', data)
  })
  term.onResize(({ cols, rows }) => emit('resize', { cols, rows }))
  // 容器尺寸变化（含标签页切换 0→有尺寸）时重排
  resizeObserver = new ResizeObserver(() => {
    try {
      fitAddon?.fit()
    } catch {
      /* 容器 0 尺寸时 fit 可能抛错，忽略 */
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
  resizeObserver?.disconnect()
  resizeObserver = null
  webglAddon?.dispose()
  webglAddon = null
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
  effectiveTheme,
  (value) => {
    if (term) term.options.theme = toXtermTheme(value)
  },
  { deep: true }
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

/** 时间戳逐行补戳逻辑见 shared/logtext.ts 的 stampLines（纯函数，可单测） */
let midLine = false
function write(text: string): void {
  if (!text) return
  if (!props.showTime) {
    term?.write(text)
    midLine = !/[\r\n]$/.test(text)
    return
  }
  const r = stampLines(text, `\x1b[90m[${fmtStamp()}]\x1b[0m `, midLine)
  term?.write(r.out)
  midLine = r.midLine
}

/** 灌入本地灰色提示行 */
function info(text: string): void {
  term?.write(`\x1b[90m[DevKit] ${text}\x1b[0m\r\n`)
  midLine = false
}

/** 清屏（含滚动缓冲区）；清屏后光标回到行首 */
function clear(): void {
  term?.clear()
  term?.write('\x1b[2J\x1b[H')
  midLine = false
}

function focus(): void {
  term?.focus()
}

defineExpose({ write, info, clear, focus, openSearch })
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
    <div ref="termBox" class="term mono" :style="{ backgroundColor: effectiveTheme.background }"></div>
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
