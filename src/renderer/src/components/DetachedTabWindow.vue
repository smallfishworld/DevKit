<script setup lang="ts">
import { computed, onMounted, onUnmounted, watchEffect } from 'vue'
import { Back, Close, FullScreen, Minus } from '@element-plus/icons-vue'
import { tabIsSplit, type WorkTab } from '@renderer/stores/tabs'
import { sendTabWindow, type DetachedTab } from '../composables/useDetachedTabs'
import { splitTabTitle } from './split-tab'
import { tabDragStarted } from './tab-drag'
import WorkbenchBody from './WorkbenchBody.vue'

const props = defineProps<{
  tab: WorkTab
  entry: DetachedTab
  attachAt: (id: string, x: number, y: number) => boolean
}>()
const emit = defineEmits<{ attach: []; ready: [mount: HTMLElement] }>()
const title = computed(() => tabIsSplit(props.tab) ? splitTabTitle(props.tab.members) : props.tab.title)
watchEffect(() => {
  if (!props.entry.popup.closed) props.entry.root.ownerDocument.title = title.value + ' · DevKit'
})

let drag: { pointerId: number; x: number; y: number; offsetX: number; offsetY: number; started: boolean } | undefined
function beginDrag(e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary) return
  drag = {
    pointerId: e.pointerId, x: e.screenX, y: e.screenY,
    offsetX: e.clientX, offsetY: e.clientY, started: false
  }
  ;(e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId)
}

function moveDrag(e: PointerEvent): void {
  if (!drag || drag.pointerId !== e.pointerId || !(e.buttons & 1)) return
  if (!drag.started) {
    drag.started = tabDragStarted(drag, { x: e.screenX, y: e.screenY })
    if (!drag.started) return
  }
  sendTabWindow(props.entry.name, { action: 'move', offsetX: drag.offsetX, offsetY: drag.offsetY })
}

function endDrag(e: PointerEvent): void {
  if (drag?.pointerId !== e.pointerId) return
  const started = drag.started
  drag = undefined
  if (started && props.attachAt(props.tab.id, e.screenX, e.screenY)) emit('attach')
}

function cancelDrag(e: PointerEvent): void {
  if (drag?.pointerId === e.pointerId) drag = undefined
}

const owner = props.entry.root.ownerDocument.defaultView
onMounted(() => {
  owner?.addEventListener('pointermove', moveDrag, true)
  owner?.addEventListener('pointerup', endDrag, true)
  owner?.addEventListener('pointercancel', cancelDrag, true)
})
onUnmounted(() => {
  owner?.removeEventListener('pointermove', moveDrag, true)
  owner?.removeEventListener('pointerup', endDrag, true)
  owner?.removeEventListener('pointercancel', cancelDrag, true)
})
</script>

<template>
  <Teleport :to="entry.root">
    <div class="app-shell">
      <header class="detached-header">
        <button
          type="button"
          class="detached-tab"
          title="拖动标签可移回主窗口"
          @pointerdown="beginDrag"
          @lostpointercapture="cancelDrag"
        >{{ title }}</button>
        <span class="detached-spacer" />
        <button type="button" class="detached-return" title="移回主窗口" @click="emit('attach')">
          <el-icon><Back /></el-icon>移回主窗口
        </button>
        <button type="button" title="最小化" aria-label="最小化" @click="sendTabWindow(entry.name, { action: 'minimize' })">
          <el-icon><Minus /></el-icon>
        </button>
        <button type="button" title="最大化或还原" aria-label="最大化或还原" @click="sendTabWindow(entry.name, { action: 'toggle-maximize' })">
          <el-icon><FullScreen /></el-icon>
        </button>
        <button type="button" class="detached-close" title="关闭窗口" aria-label="关闭窗口" @click="entry.popup.close()">
          <el-icon><Close /></el-icon>
        </button>
      </header>
      <WorkbenchBody :split="tabIsSplit(tab) ? tab : undefined" :owner-document="entry.root.ownerDocument" @ready="emit('ready', $event)" />
    </div>
  </Teleport>
</template>

<style scoped>
.detached-header {
  display: flex;
  align-items: stretch;
  flex: none;
  height: 42px;
  padding-inline-start: 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color-page);
  user-select: none;
  -webkit-app-region: drag;
}

.detached-header button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 42px;
  border: 0;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.detached-header button:hover {
  background: var(--el-fill-color-dark);
}

.detached-header .detached-tab {
  display: block;
  width: auto;
  max-width: 55%;
  margin-top: 6px;
  padding-inline: 12px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: var(--el-bg-color);
  color: var(--el-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  touch-action: none;
  cursor: grab;
}

.detached-tab:active {
  cursor: grabbing;
}

.detached-spacer {
  flex: 1;
}

.detached-header .detached-return {
  width: auto;
  padding-inline: 10px;
  gap: 5px;
  font-size: 12px;
}

.detached-header .detached-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
