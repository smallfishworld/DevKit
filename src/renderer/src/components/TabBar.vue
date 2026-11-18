<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { Box, Close, House, Plus } from '@element-plus/icons-vue'
import { useTabStore } from '@renderer/stores/tabs'

import { toolById } from '@renderer/tools/registry'

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

async function openToolSearch(): Promise<void> {
  tabs.activate('home')
  await nextTick()
  document.querySelector<HTMLInputElement>('.toolbox input[aria-label="搜索工具"]')?.focus()
}

function onDrop(toId: string): void {
  if (draggingId.value) tabs.moveTab(draggingId.value, toId)
  onDragEnd()
}
</script>

<template>
  <nav class="tab-bar" aria-label="工作区">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab-item"
      :class="{ active: tab.id === tabs.activeId, dragging: tab.id === draggingId, 'drop-target': tab.id === overId && tab.id !== draggingId }"
      :draggable="tab.id !== 'home'"
      @auxclick.middle="tabs.close(tab.id)"
      @dragstart="(e: DragEvent) => onDragStart(tab.id, e)"
      @dragend="onDragEnd"
      @dragover.prevent="(overId = tab.id)"
      @dragleave="overId === tab.id && (overId = null)"
      @drop.prevent="onDrop(tab.id)"
    >
      <button
        type="button" class="tab-select"
        :aria-current="tab.id === tabs.activeId ? 'page' : undefined"
        @click="tabs.activate(tab.id)"
      >
        <el-icon :size="15">
          <House v-if="tab.id === 'home'" />
          <Box v-else-if="tab.toolId === 'extensions'" />
          <component :is="toolById(tab.toolId)?.icon" v-else />
        </el-icon>
        <span class="tab-title" :title="tab.title">{{ tab.id === 'home' ? '首页' : tab.title }}</span>
      </button>
      <button v-if="tab.id !== 'home'" type="button" class="tab-close" :aria-label="'关闭 ' + tab.title" @click="tabs.close(tab.id)">
        <el-icon :size="12"><Close /></el-icon>
      </button>
    </div>
    <button class="new-tool" type="button" aria-label="打开工具箱" title="打开工具箱" @click="openToolSearch">
      <el-icon><Plus /></el-icon>
    </button>
  </nav>
</template>

<style scoped>
.tab-item { padding-inline:0 6px; gap:2px; }
.tab-select, .tab-close { border:0; background:transparent; color:inherit; cursor:pointer; }
.tab-select { height:100%; display:flex; align-items:center; gap:6px; padding:0 6px 0 11px; font:inherit; }
.tab-item:first-child { padding-inline-end:0; }
.tab-item:first-child .tab-select { padding-inline-end:11px; }
.tab-close { flex:none; padding:3px; }

.new-tool { flex:none; align-self:center; display:grid; place-items:center; width:30px; height:28px; border:0; border-radius:6px; background:transparent; color:var(--el-text-color-secondary); cursor:pointer; }
.new-tool:hover { background:var(--el-fill-color-light); color:var(--el-text-color-primary); }
</style>
