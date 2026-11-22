<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, Box, Close, CopyDocument, House, Plus } from '@element-plus/icons-vue'
import { connectionLabels, useTabStore, type TabItem } from '@renderer/stores/tabs'
import { toolById } from '@renderer/tools/registry'
import { cycleTabId, tabIdByDigit } from './workbench-navigation'
import ToolLauncher from './ToolLauncher.vue'

const tabs = useTabStore()
const launcher = ref<InstanceType<typeof ToolLauncher>>()
const stripRef = ref<HTMLElement>()

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
  () => [tabs.activeId, tabs.tabs.length],
  async () => {
    await nextTick()
    updateScrollState()
    const activeEl = stripRef.value?.querySelector<HTMLElement>('.tab-item.active')
    activeEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  },
  { flush: 'post' }
)

// ---------- 拖拽排序（左右半区精准插入，支持拖到队尾） ----------
const draggingId = ref<string | null>(null)
const overId = ref<string | null>(null)
const overSide = ref<'before' | 'after'>('before')

function onDragStart(id: string, e: DragEvent): void {
  if (id === 'home') {
    e.preventDefault()
    return
  }
  draggingId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(id: string, e: DragEvent): void {
  if (!draggingId.value || id === 'home' || id === draggingId.value) {
    overId.value = null
    return
  }
  e.preventDefault()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  overId.value = id
  overSide.value = e.clientX >= rect.left + rect.width / 2 ? 'after' : 'before'
}

function onDragEnd(): void {
  draggingId.value = null
  overId.value = null
}

function onDrop(toId: string): void {
  if (draggingId.value && toId !== 'home') {
    tabs.moveTab(draggingId.value, toId, overSide.value)
  }
  onDragEnd()
}

// ---------- 右键上下文菜单 ----------
const contextMenu = ref<{ tab: TabItem; x: number; y: number } | null>(null)

const menuTargetIndex = computed(() =>
  contextMenu.value ? tabs.tabs.findIndex((t) => t.id === contextMenu.value!.tab.id) : -1
)
const canDuplicateTarget = computed(() => {
  const tab = contextMenu.value?.tab
  if (!tab || tab.id === 'home') return false
  const tool = toolById(tab.toolId)
  return Boolean(tool && !tool.singleton)
})
const hasOtherClosable = computed(() =>
  contextMenu.value ? tabs.tabs.some((t) => t.id !== 'home' && t.id !== contextMenu.value!.tab.id) : false
)
const hasRightClosable = computed(() =>
  menuTargetIndex.value >= 0 && menuTargetIndex.value < tabs.tabs.length - 1
)
const hasAnyClosable = computed(() => tabs.tabs.some((t) => t.id !== 'home'))

function openContextMenu(tab: TabItem, e: MouseEvent): void {
  e.preventDefault()
  const menuW = 168
  const menuH = 186
  const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
  contextMenu.value = { tab, x: Math.max(8, x), y: Math.max(8, y) }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function duplicateTab(tab: TabItem): void {
  const tool = toolById(tab.toolId)
  if (!tool) return
  tabs.openTool(tool, {
    ...tab,
    title: tab.title,
    connection: undefined
  })
  closeContextMenu()
}

// ---------- 全局标签快捷键 ----------
function isModalOpen(): boolean {
  return Boolean(document.querySelector('dialog[open], .el-overlay-dialog:not([aria-hidden="true"]) .el-dialog'))
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return

  if (e.key === 'Escape' && contextMenu.value) {
    closeContextMenu()
    return
  }

  const mod = e.ctrlKey || e.metaKey
  if (!mod || e.altKey || isModalOpen()) return

  const key = e.key.toLowerCase()

  // Ctrl+Tab / Ctrl+Shift+Tab 轮切标签
  if (e.key === 'Tab') {
    e.preventDefault()
    const next = cycleTabId(
      tabs.tabs.map((t) => t.id),
      tabs.activeId,
      e.shiftKey ? -1 : 1
    )
    if (next) tabs.activate(next)
    return
  }

  // Ctrl+Shift+T 恢复最近关闭的会话
  if (e.shiftKey && key === 't') {
    e.preventDefault()
    tabs.reopenLastClosed(toolById)
    return
  }

  if (e.shiftKey) return

  // Ctrl+W 关闭当前标签（焦点在终端内时不拦截，保留 bash Ctrl+W 删词）
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
    const id = tabIdByDigit(tabs.tabs.map((t) => t.id), Number(e.key))
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
  window.addEventListener('pointerdown', closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
})

onUnmounted(() => {
  stripObserver?.disconnect()
  window.removeEventListener('keydown', onGlobalKeydown, true)
  window.removeEventListener('pointerdown', closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
})

defineExpose({ openLauncher: () => launcher.value?.open() })
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
        v-for="tab in tabs.tabs"
        :key="tab.id"
        class="tab-item"
        :class="{
          'is-home': tab.id === 'home',
          active: tab.id === tabs.activeId,
          dragging: tab.id === draggingId,
          'drop-before': tab.id === overId && overSide === 'before' && tab.id !== draggingId,
          'drop-after': tab.id === overId && overSide === 'after' && tab.id !== draggingId
        }"
        :draggable="tab.id !== 'home'"
        @auxclick.middle="tabs.close(tab.id)"
        @contextmenu="openContextMenu(tab, $event)"
        @dragstart="(e: DragEvent) => onDragStart(tab.id, e)"
        @dragend="onDragEnd"
        @dragover="(e: DragEvent) => onDragOver(tab.id, e)"
        @dragleave="overId === tab.id && (overId = null)"
        @drop.prevent="onDrop(tab.id)"
      >
        <button
          type="button"
          class="tab-select"
          :aria-current="tab.id === tabs.activeId ? 'page' : undefined"
          @click="tabs.activate(tab.id)"
        >
          <span
            v-if="tab.connection"
            class="tab-dot"
            :data-state="tab.connection"
            :title="connectionLabels[tab.connection]"
            :aria-label="connectionLabels[tab.connection]"
            role="img"
          />
          <el-icon :size="15">
            <House v-if="tab.id === 'home'" />
            <Box v-else-if="tab.toolId === 'extensions'" />
            <component :is="toolById(tab.toolId)?.icon" v-else />
          </el-icon>
          <span class="tab-title" :title="tab.title">{{ tab.id === 'home' ? '首页' : tab.title }}</span>
        </button>
        <button
          v-if="tab.id !== 'home'"
          type="button"
          class="tab-close"
          :aria-label="'关闭 ' + tab.title"
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
        @click="launcher?.open()"
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
      class="tab-context-menu"
      role="menu"
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

  <ToolLauncher ref="launcher" />
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
  max-width: 210px;
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

.tab-context-menu button:hover:not(:disabled) {
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
