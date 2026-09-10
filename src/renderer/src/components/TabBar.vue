<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'
import { useTabStore } from '@renderer/stores/tabs'

const tabs = useTabStore()
</script>

<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab-item"
      :class="{ active: tab.id === tabs.activeId }"
      @click="tabs.activate(tab.id)"
      @auxclick.middle="tabs.close(tab.id)"
    >
      <span class="tab-title" :title="tab.title">{{ tab.title }}</span>
      <span v-if="tab.id !== 'home'" class="tab-close" @click.stop="tabs.close(tab.id)">
        <el-icon :size="12"><Close /></el-icon>
      </span>
    </div>
  </div>
</template>
