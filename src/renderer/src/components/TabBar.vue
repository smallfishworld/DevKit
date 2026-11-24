<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, Box, Close, CopyDocument, House, Monitor, Plus, Right } from '@element-plus/icons-vue'
import { connectionLabels, useTabStore, tabIsSplit, type TabItem, type WorkTab } from '@renderer/stores/tabs'
import { toolById } from '@renderer/tools/registry'
import { cycleTabId, tabIdByDigit } from './workbench-navigation'
import { memberTabIds, splitTabTitle } from './split-tab'
import { insideTabStrip, tabDragDestination, tabDragStarted, tabInsertion } from './tab-drag'
import ToolLauncher from './ToolLauncher.vue'

const emit = defineEmits<{
  detach: [id: string]
  preview: [id: string, offset: { offsetX: number; offsetY: number }]
  hidePreview: [id: string]
  cancelPreview: [id: string]
}>()
const tabs = useTabStore()
const launcher = ref<InstanceType<typeof ToolLauncher>>()
const stripRef = ref<HTMLElement>()

/** 分屏模式锚点：非空时选择器选中即与该标签合并（选择器关闭后自动复位） */
const splitAnchorId = ref<string | null>(null)

// ---------- 溢出滚动状态 ----------
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let stripObserver: ResizeObserver | undefined

function updateScrollState(): void {
  const el = stripRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 2
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

function scrollStrip(delta: number): void {
  stripRef.value?.scrollBy({ left: delta, behavior: 'smooth' })
}

function onWheel(e: WheelEvent): void {
  const el = stripRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (delta === 0) return
  e.preventDefault()
  el.scrollLeft += delta
  updateScrollState()
}

watch(
  () => [tabs.activeId, tabs.workbenchTabs.length],
  async () => {
    await nextTick()
    updateScrollState()
    const activeEl = stripRef.value?.querySelector<HTMLElement>('.tab-item.active')
    activeEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  },
  { flush: 'post' }
)

// ---------- 合并分屏条目的模板辅助（避免模板内类型收窄） ----------

function tabTitle(tab: WorkTab): string {
  return tabIsSplit(tab) ? splitTabTitle(tab.members) : tab.id === 'home' ? '首页' : tab.title
}

/** 连接状态点：普通标签 0/1 个；分屏标签每个成员一个 */
function tabDots(tab: WorkTab): { id: string; connection?: string }[] {
  if (tabIsSplit(tab)) return tab.members.map((m) => ({ id: m.id, connection: m.connection }))
  return tab.connection ? [{ id: tab.id, connection: tab.connection }] : []
}

function tabIcon(tab: WorkTab): unknown {
  if (tabIsSplit(tab)) return toolById(tab.members[0]?.toolId ?? '')?.icon
  return toolById(tab.toolId)?.icon
}

// Keep the original handle mounted until pointer capture is released.
const draggingId = ref<string>()
const dropTarget = ref<ReturnType<typeof tabInsertion>>()
const stripTabs = computed(() => tabs.tabs.filter((tab) =>
  tab.id === draggingId.value || !tabs.detachedIds.includes(tab.id)
))
let drag: {
  id: string
  pointerId: number
  handle: HTMLButtonElement
  start: { x: number; y: number }
  offset: { offsetX: number; offsetY: number }
} | undefined
let ignoreClick = false

function beginTabDrag(id: string, e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary || drag) return
  ignoreClick = false
  if (id === 'home') return
  const handle = e.currentTarget as HTMLButtonElement
  const rect = handle.getBoundingClientRect()
  drag = {
    id, pointerId: e.pointerId, handle,
    start: { x: e.clientX, y: e.clientY },
    offset: { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top }
  }
  handle.setPointerCapture(e.pointerId)
}

function insertionAt(x: number, draggedId: string) {
  const bounds = Array.from(stripRef.value?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [], (el) => {
    const { left, right } = el.getBoundingClientRect()
    return { id: el.dataset.tabId!, left, right }
  })
  return tabInsertion(bounds.filter((tab) => tab.id !== draggedId), x)
}

function moveTabDrag(e: PointerEvent): void {
  if (!drag || drag.pointerId !== e.pointerId || !stripRef.value) return
  if (!(e.buttons & 1)) {
    cancelTabDrag()
    return
  }
  const point = { x: e.clientX, y: e.clientY }
  if (!draggingId.value && !tabDragStarted(drag.start, point)) return
  draggingId.value = drag.id
  ignoreClick = true
  if (tabDragDestination(point, stripRef.value.getBoundingClientRect()) === 'detach') {
    dropTarget.value = undefined
    emit('preview', drag.id, drag.offset)
  } else {
    emit('hidePreview', drag.id)
    dropTarget.value = insertionAt(point.x, drag.id)
  }
}

function resetTabDrag(): void {
  const current = drag
  drag = undefined
  draggingId.value = undefined
  dropTarget.value = undefined
  if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
}

function cancelTabDrag(e?: PointerEvent): void {
  if (!drag || (e && drag.pointerId !== e.pointerId)) return
  if (draggingId.value) emit('cancelPreview', drag.id)
  resetTabDrag()
}

function dropTab(e: PointerEvent): void {
  if (!drag || drag.pointerId !== e.pointerId) return
  const id = drag.id
  const wasDragging = !!draggingId.value
  resetTabDrag()
  if (!wasDragging || !stripRef.value) return
  const point = { x: e.clientX, y: e.clientY }
  if (tabDragDestination(point, stripRef.value.getBoundingClientRect()) === 'detach') {
    emit('detach', id)
  } else {
    emit('cancelPreview', id)
    const target = insertionAt(point.x, id)
    if (target) tabs.moveTab(id, target.id, target.side)
  }
}

function activateTab(id: string, e: MouseEvent): void {
  if (ignoreClick && e.detail) {
    ignoreClick = false
    return
  }
  tabs.activate(id)
}

function attachAt(id: string, screenX: number, screenY: number): boolean {
  const strip = stripRef.value?.getBoundingClientRect()
  const point = { x: screenX - window.screenX, y: screenY - window.screenY }
  if (!strip || !insideTabStrip(point, strip)) return false
  const target = insertionAt(point.x, id)
  if (target) tabs.moveTab(id, target.id, target.side)
  return true
}

// ---------- 右键上下文菜单 ----------
const contextMenu = ref<{ tab: WorkTab; x: number; y: number } | null>(null)

const menuTargetIndex = computed(() =>
  contextMenu.value ? tabs.workbenchTabs.findIndex((t) => t.id === contextMenu.value!.tab.id) : -1
)
const canDuplicateTarget = computed(() => {
  const tab = contextMenu.value?.tab
  if (!tab || tab.id === 'home' || tabIsSplit(tab)) return false
  const tool = toolById(tab.toolId)
  return Boolean(tool && !tool.singleton)
})
/** 普通非 home 标签 → 可发起合并分屏 */
const canSplitTarget = computed(() => {
  const tab = contextMenu.value?.tab
  return Boolean(tab && tab.id !== 'home' && !tabIsSplit(tab))
})
/** 分屏标签 → 可拆分回独立标签 */
const isSplitTarget = computed(() => {
  const tab = contextMenu.value?.tab
  return Boolean(tab && tabIsSplit(tab))
})
const hasOtherClosable = computed(() =>
  contextMenu.value ? tabs.workbenchTabs.some((t) => t.id !== 'home' && t.id !== contextMenu.value!.tab.id) : false
)
const hasRightClosable = computed(() =>
  menuTargetIndex.value >= 0 && menuTargetIndex.value < tabs.workbenchTabs.length - 1
)
const hasAnyClosable = computed(() => tabs.workbenchTabs.some((t) => t.id !== 'home'))

const menuRef = ref<HTMLElement>()
let menuInvoker: HTMLButtonElement | undefined

function enabledMenuItems(): HTMLButtonElement[] {
  return Array.from(menuRef.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
}

async function openContextMenu(tab: WorkTab, invoker: HTMLButtonElement, x: number, y: number, keyboard = false): Promise<void> {
  menuInvoker = invoker
  contextMenu.value = { tab, x, y }
  await nextTick()
  if (contextMenu.value?.tab.id !== tab.id || !menuRef.value) return
  const { width, height } = menuRef.value.getBoundingClientRect()
  contextMenu.value.x = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  contextMenu.value.y = Math.max(8, Math.min(y, window.innerHeight - height - 8))
  if (keyboard) enabledMenuItems()[0]?.focus()
}

function onTabContextMenu(tab: WorkTab, e: MouseEvent): void {
  e.preventDefault()
  const invoker = (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('.tab-select')
  if (invoker) void openContextMenu(tab, invoker, e.clientX, e.clientY)
}

function onTabMenuKey(tab: WorkTab, e: KeyboardEvent): void {
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
  e.preventDefault()
  const invoker = e.currentTarget as HTMLButtonElement
  const rect = invoker.getBoundingClientRect()
  void openContextMenu(tab, invoker, rect.left, rect.bottom, true)
}

function closeContextMenu(): void {
  contextMenu.value = null
  menuInvoker = undefined
}

function dismissMenuAndRestoreFocus(): void {
  const invoker = menuInvoker
  closeContextMenu()
  invoker?.focus({ preventScroll: true })
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Tab') {
    dismissMenuAndRestoreFocus()
    return
  }
  const items = enabledMenuItems()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 :
    e.key === 'ArrowDown' ? (index + 1) % items.length :
      e.key === 'ArrowUp' ? (index + items.length - 1) % items.length : -1
  if (next < 0) return
  e.preventDefault()
  items[next]?.focus()
}

function detachTarget(): void {
  const id = contextMenu.value?.tab.id
  closeContextMenu()
  if (id) emit('detach', id)
}

function onWindowBlur(): void {
  closeContextMenu()
  cancelTabDrag()
}

function duplicateTab(tab: WorkTab): void {
  if (tabIsSplit(tab) || tab.id === 'home') return
  const tool = toolById(tab.toolId)
  if (!tool) return
  tabs.openTool(tool, {
    ...tab,
    title: tab.title,
    connection: undefined
  })
  closeContextMenu()
}

/** 菜单动作：发起合并分屏（选择器选中即并入） / 拆分为独立标签 */
function splitTargetRight(): void {
  const tab = contextMenu.value?.tab
  if (tab && tab.id !== 'home' && !tabIsSplit(tab)) {
    splitAnchorId.value = tab.id
    launcher.value?.open()
  }
  closeContextMenu()
}

function unsplitTarget(): void {
  const tab = contextMenu.value?.tab
  if (tab && tabIsSplit(tab)) tabs.unsplit(tab.id)
  closeContextMenu()
}

/** 菜单动作：关闭分屏的一侧，另一侧原地成为独立标签（side：0 左 / 1 右） */
function closeSplitSide(side: 0 | 1): void {
  const tab = contextMenu.value?.tab
  if (tab && tabIsSplit(tab)) tabs.closeSplitSide(tab.id, side)
  closeContextMenu()
}

// ---------- 全局标签快捷键 ----------
function isModalOpen(): boolean {
  return Boolean(document.querySelector('dialog[open], .el-overlay-dialog:not([aria-hidden="true"]) .el-dialog'))
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return

  if (e.key === 'Escape' && (contextMenu.value || draggingId.value)) {
    e.preventDefault()
    dismissMenuAndRestoreFocus()
    cancelTabDrag()
    return
  }

  const mod = e.ctrlKey || e.metaKey
  if (!mod || e.altKey || isModalOpen()) return

  const key = e.key.toLowerCase()

  // Ctrl+Tab / Ctrl+Shift+Tab 轮切标签（分屏标签作为单个条目参与）
  if (e.key === 'Tab') {
    e.preventDefault()
    const ids = tabs.workbenchTabs.map((t) => t.id)
    const next = cycleTabId(ids, tabs.activeId, e.shiftKey ? -1 : 1)
    if (next) tabs.activate(next)
    return
  }

  // Ctrl+\ 合并分屏（对当前标签发起，弹选择器）；Ctrl+Shift+\ 拆分当前分屏标签
  if (key === '\\') {
    e.preventDefault()
    const active = tabs.active
    if (e.shiftKey) {
      if (active && tabIsSplit(active)) tabs.unsplit(active.id)
    } else if (active && !tabIsSplit(active) && active.id !== 'home') {
      splitAnchorId.value = active.id
      launcher.value?.open()
    }
    return
  }

  // Ctrl+Shift+T 恢复最近关闭的会话
  if (e.shiftKey && key === 't') {
    e.preventDefault()
    tabs.reopenLastClosed(toolById)
    return
  }

  if (e.shiftKey) return

  // Ctrl+W 关闭当前标签（分屏标签关闭全部成员；焦点在终端内时不拦截，保留 bash Ctrl+W 删词）
  if (key === 'w') {
    const target = e.target as HTMLElement | null
    if (target?.closest('.xterm')) return
    if (tabs.activeId !== 'home') {
      e.preventDefault()
      tabs.close(tabs.activeId)
    }
    return
  }

  // Ctrl+1..9 快速跳转标签
  if (/^[1-9]$/.test(e.key)) {
    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable="true"]')) return
    const id = tabIdByDigit(tabs.workbenchTabs.map((t) => t.id), Number(e.key))
    if (id) {
      e.preventDefault()
      tabs.activate(id)
    }
  }
}

onMounted(() => {
  updateScrollState()
  if (stripRef.value && typeof ResizeObserver !== 'undefined') {
    stripObserver = new ResizeObserver(updateScrollState)
    stripObserver.observe(stripRef.value)
  }
  window.addEventListener('keydown', onGlobalKeydown, true)
  window.addEventListener('pointermove', moveTabDrag, true)
  window.addEventListener('pointerup', dropTab, true)
  window.addEventListener('pointercancel', cancelTabDrag, true)
  window.addEventListener('pointerdown', closeContextMenu)
  window.addEventListener('blur', onWindowBlur)
})

onUnmounted(() => {
  cancelTabDrag()
  stripObserver?.disconnect()
  window.removeEventListener('keydown', onGlobalKeydown, true)
  window.removeEventListener('pointermove', moveTabDrag, true)
  window.removeEventListener('pointerup', dropTab, true)
  window.removeEventListener('pointercancel', cancelTabDrag, true)
  window.removeEventListener('pointerdown', closeContextMenu)
  window.removeEventListener('blur', onWindowBlur)
})

defineExpose({
  attachAt,
  openLauncher: () => {
    splitAnchorId.value = null
    launcher.value?.open()
  }
})
</script>

<template>
  <nav class="tab-bar" aria-label="工作区">
    <button
      v-if="canScrollLeft"
      type="button"
      class="tab-scroll-btn"
      aria-label="向左滚动标签"
      title="向左滚动标签"
      @click="scrollStrip(-180)"
    >
      <el-icon :size="12"><ArrowLeft /></el-icon>
    </button>

    <div
      ref="stripRef"
      class="tab-strip"
      :class="{ 'fade-left': canScrollLeft, 'fade-right': canScrollRight }"
      @scroll="updateScrollState"
      @wheel="onWheel"
    >
      <div
        v-for="tab in stripTabs"
        :key="tab.id"
        class="tab-item"
        :data-tab-id="tab.id"
        :class="{
          'is-home': tab.id === 'home',
          'is-split-entry': tabIsSplit(tab),
          active: tab.id === tabs.activeId,
          dragging: tab.id === draggingId,
          'drop-before': tab.id === dropTarget?.id && dropTarget.side === 'before',
          'drop-after': tab.id === dropTarget?.id && dropTarget.side === 'after'
        }"
        @auxclick.middle="tabs.close(tab.id)"
        @contextmenu="onTabContextMenu(tab, $event)"
      >
        <button
          type="button"
          class="tab-select"
          :aria-current="tab.id === tabs.activeId ? 'page' : undefined"
          :title="tabIsSplit(tab) ? '已分屏：右键可拆分' : undefined"
          aria-haspopup="menu"
          @click="activateTab(tab.id, $event)"
          @keydown="onTabMenuKey(tab, $event)"
          @pointerdown="beginTabDrag(tab.id, $event)"
          @lostpointercapture="cancelTabDrag"
        >
          <span
            v-for="dot in tabDots(tab)"
            :key="dot.id"
            class="tab-dot"
            :data-state="dot.connection"
            :title="connectionLabels[dot.connection as keyof typeof connectionLabels]"
            :aria-label="connectionLabels[dot.connection as keyof typeof connectionLabels]"
            role="img"
          />
          <el-icon :size="15">
            <House v-if="tab.id === 'home'" />
            <Box v-else-if="tab.id === 'extensions'" />
            <component :is="tabIcon(tab)" v-else />
          </el-icon>
          <span class="tab-title">{{ tabTitle(tab) }}</span>
        </button>
        <button
          v-if="tab.id !== 'home'"
          type="button"
          class="tab-close"
          :aria-label="'关闭 ' + tabTitle(tab)"
          :title="tabIsSplit(tab) ? '关闭分屏（全部成员）' : undefined"
          @click="tabs.close(tab.id)"
        >
          <el-icon :size="12"><Close /></el-icon>
        </button>
      </div>

      <button
        class="new-tool"
        type="button"
        aria-label="快速打开工具"
        title="快速打开工具（Ctrl+K）"
        aria-keyshortcuts="Control+K"
        @click="splitAnchorId = null; launcher?.open()"
      >
        <el-icon><Plus /></el-icon>
      </button>
    </div>

    <button
      v-if="canScrollRight"
      type="button"
      class="tab-scroll-btn"
      aria-label="向右滚动标签"
      title="向右滚动标签"
      @click="scrollStrip(180)"
    >
      <el-icon :size="12"><ArrowRight /></el-icon>
    </button>
  </nav>

  <Teleport to="body">
    <div
      v-if="contextMenu"
      ref="menuRef"
      class="tab-context-menu"
      role="menu"
      aria-label="标签页操作"
      @keydown="onMenuKeydown"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @pointerdown.stop
    >
      <button
        v-if="canDuplicateTarget"
        type="button"
        role="menuitem"
        @click="duplicateTab(contextMenu.tab)"
      >
        <el-icon :size="13"><CopyDocument /></el-icon>
        <span>复制新会话</span>
      </button>
      <button v-if="contextMenu.tab.id !== 'home'" type="button" role="menuitem" @click="detachTarget">
        <el-icon :size="13"><Monitor /></el-icon>
        <span>移至新窗口</span>
      </button>
      <button
        v-if="canSplitTarget"
        type="button"
        role="menuitem"
        @click="splitTargetRight"
      >
        <el-icon :size="13"><Right /></el-icon>
        <span>分屏（Ctrl+\）</span>
      </button>
      <button
        v-if="isSplitTarget"
        type="button"
        role="menuitem"
        @click="unsplitTarget"
      >
        <el-icon :size="13"><CopyDocument /></el-icon>
        <span>拆分为独立标签（Ctrl+Shift+\）</span>
      </button>
      <button
        v-if="isSplitTarget"
        type="button"
        role="menuitem"
        @click="closeSplitSide(0)"
      >
        <el-icon :size="13"><ArrowLeft /></el-icon>
        <span>关闭左侧分屏</span>
      </button>
      <button
        v-if="isSplitTarget"
        type="button"
        role="menuitem"
        @click="closeSplitSide(1)"
      >
        <el-icon :size="13"><ArrowRight /></el-icon>
        <span>关闭右侧分屏</span>
      </button>
      <button
        v-if="contextMenu.tab.id !== 'home'"
        type="button"
        role="menuitem"
        @click="tabs.close(contextMenu.tab.id); closeContextMenu()"
      >
        <el-icon :size="13"><Close /></el-icon>
        <span>关闭当前</span>
      </button>
      <div v-if="contextMenu.tab.id !== 'home' || canDuplicateTarget" class="menu-divider" />
      <button
        type="button"
        role="menuitem"
        :disabled="!hasOtherClosable"
        @click="tabs.closeOthers(contextMenu.tab.id); closeContextMenu()"
      >
        <span>关闭其他标签</span>
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!hasRightClosable"
        @click="tabs.closeRight(contextMenu.tab.id); closeContextMenu()"
      >
        <span>关闭右侧标签</span>
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="!hasAnyClosable"
        @click="tabs.closeAll(); closeContextMenu()"
      >
        <span>关闭全部标签</span>
      </button>
    </div>
  </Teleport>

  <ToolLauncher ref="launcher" :split-anchor-id="splitAnchorId" @closed="splitAnchorId = null" />
</template>

<style scoped>
.tab-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 100%;
  padding-top: 6px;
  user-select: none;
  /* 保持 drag 继承自 app-header，让右侧空白区域可拖动窗口/双击最大化 */
  -webkit-app-region: drag;
}

.tab-strip {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.tab-strip::-webkit-scrollbar {
  height: 0;
}

.tab-strip.fade-left {
  mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 100%);
}

.tab-strip.fade-right {
  mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 18px), transparent 100%);
}

.tab-strip.fade-left.fade-right {
  mask-image: linear-gradient(to right, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
}

.tab-item {
  position: relative;
  flex: 0 1 auto;
  min-width: 96px;
  max-width: 240px;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 36px;
  padding: 0 6px 0 0;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  -webkit-app-region: no-drag;
}

.tab-item.is-home {
  flex: none;
  min-width: auto;
  padding-right: 0;
}

/* 合并分屏标签：主色描边暗示内部并排多面板 */
.tab-item.is-split-entry.active {
  border-color: color-mix(in srgb, var(--el-color-primary) 45%, var(--el-border-color-lighter));
}

.tab-item:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}

/* 激活标签与下方内容区同色（--el-bg-color），下移 1px 盖住 header 底边线，形成无缝一体感 */
.tab-item.active {
  z-index: 2;
  margin-bottom: -1px;
  padding-bottom: 1px;
  height: 37px;
  background: var(--el-bg-color);
  border-color: var(--el-border-color-lighter);
  color: var(--el-color-primary);
  font-weight: 600;
}

.tab-item.dragging {
  opacity: 0.4;
}

.tab-item.drop-before {
  box-shadow: inset 2px 0 0 var(--el-color-primary);
}

.tab-item.drop-after {
  box-shadow: inset -2px 0 0 var(--el-color-primary);
}

.tab-select,
.tab-close,
.tab-scroll-btn,
.new-tool {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  outline: none;
}

.tab-select {
  touch-action: none;
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 6px 0 12px;
  font: inherit;
}

.tab-item.is-home .tab-select {
  padding-inline: 11px;
}

.tab-select:focus-visible,
.tab-close:focus-visible,
.tab-scroll-btn:focus-visible,
.new-tool:focus-visible {
  outline: 1px solid var(--el-color-primary);
  outline-offset: -2px;
  border-radius: 5px;
}

.tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--el-text-color-secondary);
  opacity: 0;
  transition: opacity 0.12s ease, background 0.15s ease, color 0.15s ease;
}

.tab-item.active .tab-close,
.tab-item:hover .tab-close,
.tab-close:focus-visible {
  opacity: 1;
}

.tab-close:hover {
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-primary);
}

.tab-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.tab-dot + .tab-dot {
  margin-inline-start: -2px;
}

.tab-dot[data-state="connected"] {
  background: var(--el-color-success);
}

.tab-dot[data-state="connecting"] {
  background: var(--el-color-warning);
}

.new-tool,
.tab-scroll-btn {
  flex: none;
  align-self: flex-end;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-bottom: 4px;
  border-radius: 6px;
  color: var(--el-text-color-secondary);
  transition: background 0.15s ease, color 0.15s ease;
  -webkit-app-region: no-drag;
}

.new-tool {
  margin-inline-start: 2px;
}

.new-tool:hover,
.tab-scroll-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
</style>

<style>
.tab-context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 164px;
  padding: 5px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-dark);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tab-context-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tab-context-menu button:is(:hover, :focus-visible):not(:disabled) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.tab-context-menu button:disabled {
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}

.tab-context-menu .menu-divider {
  height: 1px;
  margin: 3px 6px;
  background: var(--el-border-color-lighter);
}
</style>
