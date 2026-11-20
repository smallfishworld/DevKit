<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { TOOLS } from '@renderer/tools/registry'
import type { ToolDef } from '@renderer/tools/registry'
import { connectionLabels, useTabStore, type TabItem } from '@renderer/stores/tabs'
import { matchesTool } from './workbench-navigation'

const tabs = useTabStore()
const keyword = ref('')
// 按「拿工具做什么」分组，顺序即竖向排列顺序；每组 3–4 个，避免一大类里塞 7 个、另一类只有几个。
// 串口桥接与 TFTP 都属于设备侧（固件/串口通路）调试，故与串口助手同组；
// SSH/本地终端/网络助手都是「开会话」类，同组；键鼠宏与取色器都是屏幕侧辅助，与文本对比同属最后一组。
const GROUP_DEFS = [
  { label: '串口与设备调试', ids: ['serial', 'bridge', 'tftp'] },
  { label: '终端与网络', ids: ['ssh', 'local-terminal', 'net'] },
  { label: '数据转换与计算', ids: ['timestamp', 'endian', 'encoding', 'calc'] },
  { label: '文本、屏幕与自动化', ids: ['diff', 'color', 'macro', 'input'] }
]
const sessionLabel = (tab: TabItem): string | undefined =>
  tab.toolId === 'local-terminal' && tab.connection === 'connected' ? '运行中' :
    tab.connection ? connectionLabels[tab.connection] : undefined

function reopen(tab: TabItem): void {
  if (tabs.tabs.some((item) => item.id === tab.id)) {
    tabs.activate(tab.id)
    return
  }
  const tool = TOOLS.find((item) => item.id === tab.toolId)
  if (tool) tabs.openTool(tool, tab)
}
const groups = computed(() => GROUP_DEFS.map(({ label, ids }) => ({
  label,
  tools: ids.flatMap((id) => filtered.value.filter((tool) => tool.id === id))
})))

const filtered = computed<ToolDef[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return TOOLS
  return TOOLS.filter((tool) => matchesTool(kw, tool.name, tool.id, tool.description))
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
      <div><h1>工具箱</h1><p class="muted">选择连接会话或独立开发工具</p></div>
      <el-input v-model="keyword" type="search" aria-label="搜索工具" placeholder="搜索串口、SSH、时间戳、编码…" clearable :prefix-icon="Search">
        <template #suffix><kbd>Ctrl+K</kbd></template>
      </el-input>
    </header>
    <div v-if="tabs.recent.length" class="recent-sessions">
      <h2>最近会话</h2>
      <button v-for="tab in tabs.recent" :key="tab.id" type="button" class="recent-chip" @click="reopen(tab)">
        <el-icon><component :is="TOOLS.find((tool) => tool.id === tab.toolId)?.icon" /></el-icon>
        {{ tab.title }}
        <small v-if="sessionLabel(tab)" :data-state="tab.connection">{{ sessionLabel(tab) }}</small>
      </button>
    </div>
    <!-- 全部分类共用一个栅格：列宽由整页统一决定，卡片不会因为「这一组有 3 个、那一组有 4 个」而时宽时窄；
         分类标题横跨整行，作为栅格里的分隔行 -->
    <div class="tool-lists">
      <template v-for="group in groups.filter((group) => group.tools.length)" :key="group.label">
        <header class="group-head">
          <h2>{{ group.label }}</h2>
          <span class="group-count">{{ group.tools.length }}</span>
        </header>
        <button v-for="tool in group.tools" :key="tool.id" class="tool-row" type="button" @click="open(tool)">
          <!-- 图标与标题同一行：用两行栅格让图标对齐标题，而不是对齐「标题 + 两行描述」整块 -->
          <el-icon class="tool-icon" :size="16"><component :is="tool.icon" /></el-icon>
          <strong class="tool-name">{{ tool.name }}</strong>
          <span class="tool-desc">{{ tool.description }}</span>
        </button>
      </template>
    </div>
    <p v-if="!filtered.length" class="muted">未找到匹配工具，请换个关键词。</p>
  </section>
</template>

<style scoped>
/* 铺满可用宽度：原先 max-width:1120px 在 1440/1920 屏上两侧留下大片空白。
   宽度足够时每组内部再分栏，工具按容器自适应排列，不再固定两列。 */
.toolbox { padding:clamp(18px, 2.6vw, 30px); container-type:inline-size; }
.page-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
.page-head p { margin:4px 0 0; }
kbd { font-size:11px; white-space:nowrap; }
.page-head h1 { margin:0; font-size:19px; font-weight:650; }
.page-head :deep(.el-input) { width:min(300px, 100%); }
.recent-sessions { display:flex; align-items:center; flex-wrap:wrap; gap:8px 10px; padding:10px 12px; margin-bottom:18px; border:1px solid var(--el-border-color-lighter); border-radius:9px; background:var(--el-bg-color-page); }
.recent-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border-radius:999px; border:1px solid var(--el-border-color); background:var(--el-bg-color-overlay); color:inherit; font:inherit; cursor:pointer; }
.recent-chip:hover { border-color:var(--el-color-primary); }
.recent-chip small { color:var(--el-text-color-secondary); }
.recent-chip small[data-state="connected"] { color:var(--el-color-success); }
.toolbox h2 { margin:0; font-size:13px; font-weight:650; color:var(--el-text-color-regular); }
.recent-sessions h2 { margin:0 4px 0 0; font-size:12px; color:var(--el-text-color-secondary); }
/* 整页一个栅格：所有分类共用同一组列宽，卡片永远等宽等高；
   分类标题横跨整行（grid-column:1/-1）充当分组分隔，不再每类各套一个框 */
.tool-lists { display:grid; gap:8px; grid-template-columns:repeat(4, minmax(0, 1fr)); }
.group-head { grid-column:1/-1; display:flex; align-items:center; gap:8px; margin-top:10px; padding-bottom:1px; }
.group-head:first-child { margin-top:0; }
/* 分类色条：替代原先每个分类的卡片外框 */
.group-head::before { content:''; width:3px; height:13px; border-radius:2px; background:var(--el-color-primary); }
.group-count { padding:0 6px; border-radius:999px; font-size:11px; line-height:17px; color:var(--el-text-color-secondary); background:var(--el-fill-color); }
/* 卡片是两行栅格：图标横跨两行并居中于标题行，标题与描述各占一行。
   原先整块文字与图标各自居中，图标落在「标题+描述」的中点、标题在其上方，看着没对齐 */
.tool-row { display:grid; grid-template-columns:32px minmax(0, 1fr); grid-template-rows:auto auto; align-items:start; column-gap:12px; row-gap:3px; width:100%; min-width:0; padding:11px 13px; border:1px solid var(--el-border-color-lighter); border-radius:9px; background:var(--el-bg-color-overlay); text-align:start; color:inherit; cursor:pointer; transition:border-color .15s ease, background .15s ease, transform .15s ease; }
.tool-row:hover { border-color:var(--el-color-primary-light-7); background:var(--el-fill-color-light); }
.tool-row:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:1px; }
/* 图标与标题首行同高（19px），不再用固定 32px 方块去对齐整段文字 */
.tool-icon { grid-column:1; grid-row:1; width:19px; height:19px; border-radius:5px; color:var(--el-color-primary); background:var(--el-color-primary-light-9); font-size:12px; }
.tool-name { grid-column:2; grid-row:1; min-width:0; overflow:hidden; font-size:13px; line-height:19px; text-overflow:ellipsis; white-space:nowrap; }
.muted, .tool-desc { font-size:12px; color:var(--el-text-color-secondary); }
/* 描述固定占两行高度：一两行描述都撑成同一张卡片，栅格里不再出现高矮不齐 */
.tool-desc { grid-column:2; grid-row:2; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:3em; line-height:1.5; }
@container (max-width:1100px) { .tool-lists { grid-template-columns:repeat(3, minmax(0, 1fr)); } }
@container (max-width:760px) { .tool-lists { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
@container (max-width:560px) { .tool-lists { grid-template-columns:minmax(0,1fr); } }
</style>
