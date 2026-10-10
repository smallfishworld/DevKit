<script setup lang="ts">
import { ref } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { useTabStore } from '@renderer/stores/tabs'

const tabs = useTabStore()

// ---------- 拖拽排序（浏览器式）：原生 HTML5 drag，无需依赖 ----------
// dragover 时记录「当前悬停在哪个标签上」，供 drop 时换位（moveTab 负责边界）
const draggingId = ref<string | null>(null)
const overId = ref<string | null>(null)

function onDragStart(id: string, e: DragEvent): void {
  if (id === 'home') {
    e.preventDefault()
    return
  }
  draggingId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // 必须 setData 才能触发拖拽（Firefox 等要求非空）
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDragEnd(): void {
  draggingId.value = null
  overId.value = null
}

function onDrop(toId: string): void {
  if (draggingId.value) tabs.moveTab(draggingId.value, toId)
  onDragEnd()
}
</script>

<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab-item"
      :class="{ active: tab.id === tabs.activeId, dragging: tab.id === draggingId, 'drop-target': tab.id === overId && tab.id !== draggingId }"
      :draggable="tab.id !== 'home'"
      @click="tabs.activate(tab.id)"
      @auxclick.middle="tabs.close(tab.id)"
      @dragstart="(e: DragEvent) => onDragStart(tab.id, e)"
      @dragend="onDragEnd"
      @dragover.prevent="(overId = tab.id)"
      @dragleave="overId === tab.id && (overId = null)"
      @drop.prevent="onDrop(tab.id)"
    >
      <span class="tab-title" :title="tab.title">{{ tab.title }}</span>
      <span v-if="tab.id !== 'home'" class="tab-close" @click.stop="tabs.close(tab.id)">
        <el-icon :size="12"><Close /></el-icon>
      </span>
    </div>
  </div>
</template>
