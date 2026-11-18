<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { TOOLS } from '@renderer/tools/registry'
import type { ToolDef } from '@renderer/tools/registry'
import { useTabStore } from '@renderer/stores/tabs'

const tabs = useTabStore()
const keyword = ref('')
const connectionTools = ['serial', 'ssh', 'local-terminal', 'tftp', 'net', 'bridge', 'input', 'macro']
const dataTools = ['timestamp', 'endian', 'encoding', 'calc', 'diff', 'color']
const recentSessions = computed(() => tabs.tabs.filter((tab) => ['serial', 'ssh', 'local-terminal'].includes(tab.toolId)))
const groups = computed(() => [
  { label: '连接与硬件调试', ids: connectionTools },
  { label: '数据转换与编码', ids: dataTools }
].map(({ label, ids }) => ({
  label,
  tools: ids.flatMap((id) => filtered.value.filter((tool) => tool.id === id))
})))

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
  <section class="toolbox">
    <header class="page-head">
      <h1>工具箱</h1>
      <el-input v-model="keyword" type="search" aria-label="搜索工具" placeholder="搜索串口、SSH、时间戳、编码…" clearable :prefix-icon="Search" />
    </header>
    <div v-if="recentSessions.length" class="recent-sessions">
      <h2>最近会话</h2>
      <el-button v-for="tab in recentSessions" :key="tab.id" round size="small" @click="tabs.activate(tab.id)">{{ tab.title }}</el-button>
    </div>
    <div class="tool-lists">
      <section v-for="group in groups.filter((group) => group.tools.length)" :key="group.label">
        <h2>{{ group.label }}</h2>
        <div class="tool-list">
          <button v-for="tool in group.tools" :key="tool.id" class="tool-row" type="button" @click="open(tool)">
            <el-icon class="tool-icon" :size="16"><component :is="tool.icon" /></el-icon>
            <span class="tool-copy"><strong>{{ tool.name }}</strong><span>{{ tool.description }}</span></span>
          </button>
        </div>
      </section>
    </div>
    <p v-if="!filtered.length" class="muted">未找到匹配工具，请换个关键词。</p>
  </section>
</template>

<style scoped>
.toolbox { max-width:1120px; margin:auto; padding:clamp(16px, 2.4vw, 26px); container-type:inline-size; }
.page-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
.page-head h1 { margin:0; font-size:19px; font-weight:650; }
.page-head :deep(.el-input) { width:min(300px, 100%); }
.recent-sessions { display:flex; align-items:center; flex-wrap:wrap; gap:8px 10px; padding:10px 12px; margin-bottom:18px; border:1px solid var(--el-border-color-lighter); border-radius:9px; background:var(--el-bg-color-page); }
.recent-sessions .el-button { margin:0; }
.toolbox h2 { margin:0 0 6px; font-size:12px; font-weight:600; color:var(--el-text-color-secondary); }
.recent-sessions h2 { margin:0 4px 0 0; }
.tool-lists { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.tool-list { display:grid; gap:4px; }
.tool-row { display:flex; align-items:center; width:100%; gap:10px; padding:8px 9px; border:1px solid transparent; border-radius:8px; background:transparent; text-align:start; color:inherit; cursor:pointer; }
.tool-row:hover { border-color:var(--el-border-color-lighter); background:var(--el-fill-color-light); }
.tool-icon { flex:none; width:32px; height:32px; border-radius:7px; color:var(--el-color-primary); background:var(--el-color-primary-light-9); }
.tool-copy { display:grid; gap:2px; }
.tool-copy strong { font-size:13px; }
.muted, .tool-copy span { font-size:12px; color:var(--el-text-color-secondary); }
@container (max-width:560px) { .tool-lists { grid-template-columns:minmax(0,1fr); gap:16px; } }
</style>
