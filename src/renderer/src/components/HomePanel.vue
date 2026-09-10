<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { TOOLS } from '@renderer/tools/registry'
import type { ToolDef } from '@renderer/tools/registry'
import { useTabStore } from '@renderer/stores/tabs'

const tabs = useTabStore()
const keyword = ref('')

const filtered = computed<ToolDef[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return TOOLS
  return TOOLS.filter(
    (t) => t.name.toLowerCase().includes(kw) || t.description.toLowerCase().includes(kw)
  )
})

function open(tool: ToolDef): void {
  if (!tool.ready) {
    ElMessage.info(`「${tool.name}」计划于 ${tool.phase} 阶段提供`)
    return
  }
  tabs.openTool(tool)
}
</script>

<template>
  <div class="panel">
    <div class="panel-row">
      <el-input
        v-model="keyword"
        placeholder="搜索工具（名称或描述）"
        clearable
        :prefix-icon="Search"
        style="width: 320px"
      />
      <span style="color: var(--el-text-color-secondary); font-size: 12px">
        共 {{ filtered.length }} 个工具
      </span>
    </div>

    <div class="tool-grid">
      <div
        v-for="tool in filtered"
        :key="tool.id"
        class="tool-card"
        :class="{ disabled: !tool.ready }"
        @click="open(tool)"
      >
        <div class="tool-card-head">
          <el-icon :size="26" class="tool-icon">
            <component :is="tool.icon" />
          </el-icon>
          <el-tag v-if="!tool.ready" size="small" type="info">{{ tool.phase }}</el-tag>
        </div>
        <div class="tool-name">{{ tool.name }}</div>
        <div class="tool-desc">{{ tool.description }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.tool-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 0.15s,
    box-shadow 0.15s;
}

.tool-card:hover:not(.disabled) {
  border-color: var(--el-color-primary);
  box-shadow: var(--el-box-shadow-light);
  transform: translateY(-2px);
}

.tool-card.disabled {
  opacity: 0.55;
  cursor: default;
}

.tool-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}

.tool-icon {
  color: var(--el-color-primary);
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}

.tool-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
</style>
