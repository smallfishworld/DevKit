<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, Search, Star, StarFilled } from '@element-plus/icons-vue'
import { TOOLS, toolById } from '@renderer/tools/registry'
import type { ToolDef } from '@renderer/tools/registry'
import { connectionLabels, useTabStore, type TabItem } from '@renderer/stores/tabs'
import { matchesTool } from './workbench-navigation'

const tabs = useTabStore()
const keyword = ref('')
const searchInputRef = ref<{ focus: () => void }>()

type GroupTone = 'primary' | 'info' | 'warning' | 'success'

interface GroupDef {
  label: string
  tone: GroupTone
  ids: string[]
}

// 按「拿工具做什么」分组，每组配轻语义色，提升宽屏扫视辨识度
const GROUP_DEFS: GroupDef[] = [
  { label: '串口与设备调试', tone: 'primary', ids: ['serial', 'bridge', 'tftp'] },
  { label: '终端与网络', tone: 'info', ids: ['ssh', 'local-terminal', 'net'] },
  { label: '数据转换与计算', tone: 'warning', ids: ['timestamp', 'endian', 'encoding', 'calc'] },
  { label: '文本、屏幕与自动化', tone: 'success', ids: ['diff', 'color', 'macro', 'input'] }
]

const openTabIds = computed(() => new Set(tabs.tabs.map((t) => t.id)))

function isSessionOpen(tab: TabItem): boolean {
  return openTabIds.value.has(tab.id)
}

function sessionDotState(tab: TabItem): string {
  if (!isSessionOpen(tab)) return 'closed'
  return tab.connection ?? 'open'
}

function sessionLabel(tab: TabItem): string {
  if (!isSessionOpen(tab)) return '历史'
  if (tab.toolId === 'local-terminal' && tab.connection === 'connected') return '运行中'
  return tab.connection ? connectionLabels[tab.connection] : '已打开'
}

function sessionTooltip(tab: TabItem): string {
  const details: string[] = [tab.title]
  if (tab.serialParams?.path) {
    const p = tab.serialParams
    details.push(`${p.path} · ${p.baudRate} ${p.dataBits}${p.parity[0]?.toUpperCase() ?? 'N'}${p.stopBits}`)
  } else if (tab.sshParams?.host) {
    const s = tab.sshParams
    details.push(`${s.username ? s.username + '@' : ''}${s.host}:${s.port ?? 22}`)
  } else if (tab.shell?.cwd) {
    details.push(tab.shell.cwd)
  }
  details.push(isSessionOpen(tab) ? '点击切换到该标签' : '点击重新打开会话')
  return details.join('\n')
}

function reopen(tab: TabItem): void {
  if (tabs.tabs.some((item) => item.id === tab.id)) {
    tabs.activate(tab.id)
    return
  }
  const tool = TOOLS.find((item) => item.id === tab.toolId)
  if (tool) tabs.openTool(tool, tab)
}

const filtered = computed<ToolDef[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return TOOLS
  return TOOLS.filter((tool) => matchesTool(kw, tool.name, tool.id, tool.description))
})

const pinnedList = computed<ToolDef[]>(() =>
  tabs.pinnedTools
    .map((id) => filtered.value.find((tool) => tool.id === id))
    .filter((tool): tool is ToolDef => Boolean(tool))
)

const groups = computed(() =>
  GROUP_DEFS.map(({ label, tone, ids }) => ({
    label,
    tone,
    tools: ids.flatMap((id) => filtered.value.filter((tool) => tool.id === id))
  })).filter((group) => group.tools.length > 0)
)

function isPinned(toolId: string): boolean {
  return tabs.pinnedTools.includes(toolId)
}

function openCount(toolId: string): number {
  return tabs.openCountByTool[toolId] ?? 0
}

function open(tool: ToolDef): void {
  if (!tool.ready) {
    ElMessage.info(`「${tool.name}」计划于 ${tool.phase} 阶段提供`)
    return
  }
  tabs.openTool(tool)
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && filtered.value.length > 0) {
    e.preventDefault()
    open(filtered.value[0])
  } else if (e.key === 'Escape' && keyword.value) {
    keyword.value = ''
  }
}

function onSlashFocus(e: KeyboardEvent): void {
  if (tabs.activeId !== 'home') return
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable="true"], dialog[open], .el-dialog')) return
  e.preventDefault()
  searchInputRef.value?.focus()
}

onMounted(() => window.addEventListener('keydown', onSlashFocus))
onUnmounted(() => window.removeEventListener('keydown', onSlashFocus))
</script>

<template>
  <section class="toolbox">
    <header class="page-head">
      <div class="page-title">
        <h1>工具箱</h1>
        <p class="muted">选择连接会话或独立开发工具</p>
      </div>
      <el-input
        ref="searchInputRef"
        v-model="keyword"
        type="search"
        aria-label="搜索工具"
        placeholder="搜索串口、SSH、时间戳…（回车打开）"
        clearable
        :prefix-icon="Search"
        @keydown="onSearchKeydown"
      >
        <template v-if="!keyword" #suffix><kbd title="按 / 快速聚焦搜索">/</kbd></template>
      </el-input>
    </header>

    <!-- 最近会话置顶展示：一键跳转已打开会话或恢复历史会话 -->
    <section v-if="tabs.recent.length" class="recent-sessions" aria-label="最近会话">
      <div class="recent-head">
        <h2>最近会话</h2>
        <button type="button" class="recent-clear" @click="tabs.clearRecent()">清空</button>
      </div>
      <div class="recent-list">
        <div v-for="tab in tabs.recent" :key="tab.id" class="recent-chip-wrap">
          <button
            type="button"
            class="recent-chip"
            :class="{ 'is-open': isSessionOpen(tab) }"
            :title="sessionTooltip(tab)"
            @click="reopen(tab)"
          >
            <span class="session-dot" :data-state="sessionDotState(tab)" aria-hidden="true" />
            <el-icon :size="14"><component :is="toolById(tab.toolId)?.icon ?? 'Connection'" /></el-icon>
            <span class="recent-title">{{ tab.title }}</span>
            <small :data-state="sessionDotState(tab)">{{ sessionLabel(tab) }}</small>
          </button>
          <button
            type="button"
            class="recent-remove"
            :aria-label="'移除最近会话 ' + tab.title"
            title="从最近会话移除"
            @click.stop="tabs.removeRecent(tab.id)"
          >
            <el-icon :size="11"><Close /></el-icon>
          </button>
        </div>
      </div>
    </section>

    <!-- 全部分类共用一个栅格：列宽由整页统一决定，卡片永远等宽等高 -->
    <div class="tool-lists">
      <template v-if="pinnedList.length">
        <header class="group-head tone-pin">
          <h2>常用置顶</h2>
          <span class="group-count">{{ pinnedList.length }}</span>
        </header>
        <div
          v-for="tool in pinnedList"
          :key="'pin-' + tool.id"
          class="tool-card tool-row tone-pin"
          role="button"
          tabindex="0"
          :title="tool.description"
          @click="open(tool)"
          @keydown.enter.prevent="open(tool)"
          @keydown.space.prevent="open(tool)"
        >
          <span class="tool-icon"><el-icon :size="18"><component :is="tool.icon" /></el-icon></span>
          <div class="tool-body">
            <div class="tool-head">
              <strong class="tool-name">{{ tool.name }}</strong>
              <span v-if="openCount(tool.id) > 0" class="tool-badge" :title="'已打开 ' + openCount(tool.id) + ' 个标签'">
                {{ tool.singleton ? '已开' : openCount(tool.id) }}
              </span>
              <button
                type="button"
                class="pin-btn pinned"
                aria-label="取消置顶"
                title="取消置顶"
                @click.stop="tabs.togglePin(tool.id)"
              >
                <el-icon :size="14"><StarFilled /></el-icon>
              </button>
            </div>
            <span class="tool-desc">{{ tool.description }}</span>
          </div>
        </div>
      </template>

      <template v-for="group in groups" :key="group.label">
        <header class="group-head" :class="'tone-' + group.tone">
          <h2>{{ group.label }}</h2>
          <span class="group-count">{{ group.tools.length }}</span>
        </header>
        <div
          v-for="tool in group.tools"
          :key="tool.id"
          class="tool-card tool-row"
          :class="'tone-' + group.tone"
          role="button"
          tabindex="0"
          :title="tool.description"
          @click="open(tool)"
          @keydown.enter.prevent="open(tool)"
          @keydown.space.prevent="open(tool)"
        >
          <span class="tool-icon"><el-icon :size="18"><component :is="tool.icon" /></el-icon></span>
          <div class="tool-body">
            <div class="tool-head">
              <strong class="tool-name">{{ tool.name }}</strong>
              <span v-if="openCount(tool.id) > 0" class="tool-badge" :title="'已打开 ' + openCount(tool.id) + ' 个标签'">
                {{ tool.singleton ? '已开' : openCount(tool.id) }}
              </span>
              <button
                type="button"
                class="pin-btn"
                :class="{ pinned: isPinned(tool.id) }"
                :aria-label="isPinned(tool.id) ? '取消置顶 ' + tool.name : '置顶常用 ' + tool.name"
                :title="isPinned(tool.id) ? '取消置顶' : '置顶到常用'"
                @click.stop="tabs.togglePin(tool.id)"
              >
                <el-icon :size="14">
                  <StarFilled v-if="isPinned(tool.id)" />
                  <Star v-else />
                </el-icon>
              </button>
            </div>
            <span class="tool-desc">{{ tool.description }}</span>
          </div>
        </div>
      </template>
    </div>

    <p v-if="!filtered.length" class="muted empty-tip">未找到匹配工具，请换个关键词或按 Esc 清空。</p>
  </section>
</template>

<style scoped>
/* 宽屏放宽至 1400px，配合 4 列栅格既舒展又不会过度留白 */
.toolbox {
  max-width: 1400px;
  margin: 0 auto;
  padding: clamp(20px, 2.4vw, 32px);
  container-type: inline-size;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 16px;
  margin-bottom: 20px;
}

.page-title h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}

.page-title p {
  margin: 4px 0 0;
}

.page-head :deep(.el-input) {
  width: min(340px, 100%);
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 16px;
  font-family: inherit;
  white-space: nowrap;
}

/* 最近会话置顶区 */
.recent-sessions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 20px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color-page);
}

.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.recent-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.recent-clear {
  padding: 2px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.recent-clear:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.recent-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.recent-chip-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  max-width: 260px;
}

.recent-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 26px 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color-overlay);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.recent-chip.is-open {
  border-color: var(--el-border-color);
}

.recent-chip:hover {
  border-color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}

.recent-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.recent-chip small {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.recent-chip small[data-state="connected"] {
  color: var(--el-color-success);
}

.recent-chip small[data-state="connecting"] {
  color: var(--el-color-warning);
}

.session-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.session-dot[data-state="connected"] {
  background: var(--el-color-success);
}

.session-dot[data-state="connecting"] {
  background: var(--el-color-warning);
}

.session-dot[data-state="open"] {
  background: var(--el-color-primary);
}

.session-dot[data-state="closed"] {
  background: transparent;
  border: 1px solid var(--el-text-color-placeholder);
}

.recent-remove {
  position: absolute;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.15s ease, color 0.15s ease;
}

.recent-chip-wrap:hover .recent-remove,
.recent-remove:focus-visible {
  opacity: 1;
}

.recent-remove:hover {
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-primary);
}

/* 分类语义色（均派生自当前主题变量，深浅主题自适应） */
.tone-primary { --group-accent: var(--el-color-primary); }
.tone-info { --group-accent: var(--el-color-info); }
.tone-warning { --group-accent: var(--el-color-warning); }
.tone-success { --group-accent: var(--el-color-success); }
.tone-pin { --group-accent: var(--el-color-warning); }

.tool-lists {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.group-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.group-head:first-child {
  margin-top: 0;
}

.group-head::before {
  content: '';
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--group-accent, var(--el-color-primary));
}

.group-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-text-color-primary);
}

.group-count {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
}

/* 工具卡片：图标与内容块光学居中，标题/角标/星标同一行 flex 排布，彻底避免重叠 */
.tool-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.tool-card:hover {
  border-color: color-mix(in srgb, var(--group-accent, var(--el-color-primary)) 48%, var(--el-border-color));
  background: var(--el-fill-color-light);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.tool-card:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}

.tool-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  color: var(--group-accent, var(--el-color-primary));
  background: color-mix(in srgb, var(--group-accent, var(--el-color-primary)) 14%, transparent);
}

.tool-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-badge {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--el-color-success) 16%, transparent);
  color: var(--el-color-success);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
}

.pin-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-placeholder);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.14s ease, color 0.15s ease, background 0.15s ease;
}

.tool-card:hover .pin-btn,
.pin-btn.pinned,
.pin-btn:focus-visible {
  opacity: 1;
}

.pin-btn.pinned {
  color: var(--el-color-warning);
}

.pin-btn:hover {
  background: var(--el-fill-color-dark);
  color: var(--el-color-warning);
}

.muted,
.tool-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tool-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 18px;
}

.empty-tip {
  margin-top: 16px;
}

@container (max-width: 1100px) {
  .tool-lists {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@container (max-width: 760px) {
  .tool-lists {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container (max-width: 560px) {
  .tool-lists {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
