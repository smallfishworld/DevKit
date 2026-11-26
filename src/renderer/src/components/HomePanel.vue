<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, Search, Star, StarFilled } from '@element-plus/icons-vue'
import { TOOLS, toolById } from '@renderer/tools/registry'
import type { ToolDef } from '@renderer/tools/registry'
import { connectionLabels, useTabStore, type TabItem } from '@renderer/stores/tabs'
import { matchesTool } from './workbench-navigation'
import { useI18n } from 'vue-i18n'

const tabs = useTabStore()
const { t } = useI18n()
const keyword = ref('')
const searchInputRef = ref<{ focus: () => void }>()

// 已打开的会话标签数（首页标签不计）
const openSessionCount = computed(() => tabs.tabs.filter((t) => t.id !== 'home').length)

type GroupTone = 'primary' | 'info' | 'warning' | 'success'

interface GroupDef {
  label: string
  tone: GroupTone
  ids: string[]
}

// 按「拿工具做什么」分组，每组配轻语义色，提升宽屏扫视辨识度
const GROUP_DEFS: GroupDef[] = [
  { label: 'home.groups.devices', tone: 'primary', ids: ['serial', 'bridge', 'tftp'] },
  { label: 'home.groups.terminal', tone: 'info', ids: ['ssh', 'local-terminal', 'net'] },
  { label: 'home.groups.data', tone: 'warning', ids: ['timestamp', 'endian', 'encoding', 'calc'] },
  { label: 'home.groups.automation', tone: 'success', ids: ['diff', 'color', 'macro', 'input'] }
]

const openTabIds = computed(() => new Set(tabs.tabs.map((t) => t.id)))

function isSessionOpen(tab: TabItem): boolean {
  return openTabIds.value.has(tab.id)
}

function sessionDotState(tab: TabItem): string {
  if (!isSessionOpen(tab)) return 'closed'
  return tab.connection ?? 'open'
}

const SESSION_TOOLS = new Set(['serial', 'ssh', 'local-terminal'])

function sessionLabel(tab: TabItem): string {
  if (!isSessionOpen(tab)) return t(SESSION_TOOLS.has(tab.toolId) ? 'home.history' : 'home.latest')
  if (tab.toolId === 'local-terminal' && tab.connection === 'connected') return t('home.running')
  return tab.connection ? t(`connection.${tab.connection}`) : t('home.opened')
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
  details.push(t(isSessionOpen(tab) ? 'home.switchTab' : SESSION_TOOLS.has(tab.toolId) ? 'home.reopenSession' : 'home.openTool'))
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
    label: t(label),
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
    ElMessage.info(t('home.planned', { name: tool.name, phase: tool.phase }))
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
        <h1>{{ t('home.title') }}</h1>
        <p class="muted">{{ t('home.subtitle') }}</p>
      </div>
      <el-input
        ref="searchInputRef"
        v-model="keyword"
        type="search"
        :aria-label="t('home.searchAria')"
        :placeholder="t('home.searchPlaceholder')"
        clearable
        :prefix-icon="Search"
        @keydown="onSearchKeydown"
      >
        <template v-if="!keyword" #suffix><kbd :title="t('home.slashHint')">/</kbd></template>
      </el-input>
    </header>

    <!-- 最近会话置顶展示：一键跳转已打开会话或恢复历史会话 -->
    <section v-if="tabs.recent.length" class="recent-sessions" :aria-label="t('home.recent')">
      <header class="group-head recent-head tone-recent">
        <h2>{{ t('home.recent') }}</h2>
        <span class="group-count">{{ tabs.recent.length }}</span>
        <button type="button" class="recent-clear" @click="tabs.clearRecent()">{{ t('home.clear') }}</button>
      </header>
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
            <span class="recent-icon"><el-icon :size="14"><component :is="toolById(tab.toolId)?.icon ?? 'Connection'" /></el-icon></span>
            <span class="recent-title">{{ tab.title }}</span>
            <small class="recent-state" :data-state="sessionDotState(tab)">{{ sessionLabel(tab) }}</small>
          </button>
          <button
            type="button"
            class="recent-remove"
            :aria-label="t('home.removeRecentAria', { title: tab.title })"
            :title="t('home.removeRecent')"
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
          <h2>{{ t('home.pinned') }}</h2>
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
              <span v-if="openCount(tool.id) > 0" class="tool-badge" :title="t('home.openedTabs', { count: openCount(tool.id) })">
                {{ tool.singleton ? t('home.openBadge') : openCount(tool.id) }}
              </span>
              <button
                type="button"
                class="pin-btn pinned"
                :aria-label="t('home.unpin')"
                :title="t('home.unpin')"
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
              <span v-if="openCount(tool.id) > 0" class="tool-badge" :title="t('home.openedTabs', { count: openCount(tool.id) })">
                {{ tool.singleton ? t('home.openBadge') : openCount(tool.id) }}
              </span>
              <button
                type="button"
                class="pin-btn"
                :class="{ pinned: isPinned(tool.id) }"
                :aria-label="t(isPinned(tool.id) ? 'home.unpinAria' : 'home.pinAria', { name: tool.name })"
                :title="t(isPinned(tool.id) ? 'home.unpin' : 'home.pin')"
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

    <p v-if="!filtered.length" class="muted empty-tip">{{ t('home.noMatch') }}</p>

    <footer class="page-foot">
      <span class="muted">{{ t('home.product') }}</span>
      <span class="foot-sep" aria-hidden="true">·</span>
      <span class="muted">{{ t('home.toolCount', { count: TOOLS.length }) }}</span>
      <template v-if="openSessionCount > 0">
        <span class="foot-sep" aria-hidden="true">·</span>
        <span class="muted">{{ t('home.sessionCount', { count: openSessionCount }) }}</span>
      </template>
      <template v-if="tabs.pinnedTools.length > 0">
        <span class="foot-sep" aria-hidden="true">·</span>
        <span class="muted">{{ t('home.pinCount', { count: tabs.pinnedTools.length }) }}</span>
      </template>
      <span class="foot-spacer" />
    </footer>
  </section>
</template>

<style scoped>
/* 全屏吃满宽度：卡片定宽、auto-fill 随容器增减列数，宽屏无大留白 */
.toolbox {
  max-width: 2560px;
  margin: 0 auto;
  padding: clamp(20px, 2.4vw, 48px);
  container-type: inline-size;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px 16px;
  /* 与最近会话区的下边距统一为 24px，整页按 4 的倍数走 */
  margin-bottom: 24px;
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

/* 最近会话：不再包卡片盒子，与工具分组标题同节奏（色条 + 标题 + 计数） */
/* 最近会话：与工具分组标题同节奏（色条 + 标题 + 计数） */
.recent-sessions {
  margin-bottom: 0;
}

.recent-head {
  margin-top: 0;
}

/* “清空”推到行尾，与分组计数并排 */
.recent-head .recent-clear {
  margin-left: auto;
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
  /* 与工具栅格同款列宽：chip 与工具卡同宽对齐，页面左右边缘齐平 */
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  margin-top: 12px;
  /* 与工具分组之间的 22px 区块间距一致（首个分组标题 first-child 上距为 0） */
  margin-bottom: 22px;
}

.recent-chip-wrap {
  display: flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
}

.recent-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 100%;
  min-width: 0;
  /* 高度约为工具卡（~64px）的 2/3 */
  min-height: 38px;
  padding: 7px 14px;
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

/* 状态点与图标纵向光学对齐 */
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

.recent-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--el-text-color-secondary);
}

.recent-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  line-height: 18px;
}

/* 状态标签：与标题间加分隔点，弱化视觉竞争 */
.recent-state {
  flex: none;
  padding-left: 8px;
  border-left: 1px solid var(--el-border-color-lighter);
  font-size: 11px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.recent-state[data-state="connected"] {
  color: var(--el-color-success);
}

.recent-state[data-state="connecting"] {
  color: var(--el-color-warning);
}

/* 移除键在 chip 外侧，hover 时展开占位，避免绝对定位压住文字 */
.recent-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  width: 0;
  margin-left: 2px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  opacity: 0;
  overflow: hidden;
  cursor: pointer;
  transition: opacity 0.15s ease, width 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.recent-chip-wrap:hover .recent-remove,
.recent-remove:focus-visible {
  opacity: 1;
  width: 18px;
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
/* 最近会话专属紫（固定色值，两组分类色未占用），与背景轻微混合保证深浅主题均成立 */
.tone-recent { --group-accent: color-mix(in srgb, #9d7bea 88%, var(--el-bg-color) 12%); }

.tool-lists {
  display: grid;
  gap: 14px;
  /* 卡片最小 280px 自动填充列数：约 800px 起 2 列，2K 屏 6 列，4K(150%缩放) 7 列 */
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.group-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 分组标题与上一组卡片隔一档（首个分组由 grid 自带 14px，与最近会话→标题间距一致） */
  margin-top: 22px;
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

/* 页脚：全屏时内容不足一屏，把提示性文字推到底部收尾，避免下方大片空白 */
.page-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
}

/* 中缝撑开：左侧品牌信息、右侧版本号各贴一边 */
.foot-spacer {
  flex: 1;
}


</style>
