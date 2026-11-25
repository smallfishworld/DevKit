<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { Brush, Download, Refresh } from '@element-plus/icons-vue'
import brandMark from '../../../resources/branding/mark.svg'
import { PLUGIN_CATALOG_PANEL, useDevicePlugins } from '@renderer/stores/devicePlugins'
import type { PluginLogEntry, PluginRuntimeStatus } from '../../shared/plugins'
import { downloadPercent, downloadSourceLabel, updateNotice, type UpdateState } from '../../shared/app-updates'
import { useTabStore, tabIsSplit } from '@renderer/stores/tabs'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { toolById, type ToolDef } from '@renderer/tools/registry'
import { hostSharesQuickCmds, type HostSlot } from './components/split-tab'
import { pickTermMacroTarget } from './composables/useTermMacroTargets'
import TabBar from './components/TabBar.vue'
import DetachedTabWindow from './components/DetachedTabWindow.vue'
import WorkbenchBody from './components/WorkbenchBody.vue'
import WorkbenchPanel from './components/WorkbenchPanel.vue'
import { useDetachedTabs } from './composables/useDetachedTabs'
import HomePanel from './components/HomePanel.vue'
import ExtensionCenter from './components/ExtensionCenter.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import AppUpdateDialog from './components/AppUpdateDialog.vue'
import type { WinInfo } from '../../shared/types'

const tabs = useTabStore()
const devicePlugins = useDevicePlugins()
const tabBarRef = ref<InstanceType<typeof TabBar>>()
const updateDialogRef = ref<InstanceType<typeof AppUpdateDialog>>()
const aboutOpen = ref(false)
const updateState = ref<UpdateState>({ phase: 'idle' })
const mainBody = shallowRef<HTMLElement>()
const { windows, workbenchAvailable, detachTab, attachTab, previewTab, hidePreview, windowMounted } = useDetachedTabs()
const detachedEntries = computed(() => tabs.tabs.flatMap((tab) => {
  const entry = windows.get(tab.id)
  return entry ? [{ tab, window: entry }] : []
}))
const activeSplit = computed(() => tabs.active && tabIsSplit(tabs.active) ? tabs.active : undefined)
const renderedPanels = computed(() => {
  const main = mainBody.value
  if (!main) return []
  return tabs.tabs.flatMap((tab) => {
    const detached = tabs.detachedIds.includes(tab.id) ? windows.get(tab.id)?.mount : undefined
    const target = detached ?? main
    const visible = Boolean(detached) || tab.id === tabs.activeId
    if (!tabIsSplit(tab)) return [{ item: tab, target, slot: (visible ? 'full' : 'hidden') as HostSlot, termTarget: false }]
    const termTarget = hostSharesQuickCmds(tab) ? pickTermMacroTarget(tab.members.map((member) => member.id))?.panelId : undefined
    return tab.members.map((item, index) => ({
      item, target, slot: (visible ? (index === 0 ? 'left' : 'right') : 'hidden') as HostSlot,
      termTarget: item.id === termTarget
    }))
  })
})

function attachAt(id: string, x: number, y: number): boolean {
  return workbenchAvailable.value && (tabBarRef.value?.attachAt(id, x, y) ?? false)
}

/** 串口面板自带状态栏，避免与全局状态栏重复 */
const isSerialActive = computed(() => {
  const active = tabs.active
  if (!active) return false
  const list = tabIsSplit(active) ? active.members : [active]
  return list.some((m) => m.toolId === 'serial')
})

/** 有新版本、下载中、已就绪：右上角的更新入口都要在——下载时用户关掉对话框，进度就看这里 */
const hasUpdateHighlight = computed(
  () => updateState.value.phase === 'available' || updateState.value.phase === 'downloading' || updateState.value.phase === 'ready'
)

const updateStatusLabel = computed(() => {
  const s = updateState.value
  if (s.phase === 'ready') return `v${s.release.version} 已下载 · 重启更新`
  if (s.phase === 'available') return `发现新版本 v${s.release.version}`
  if (s.phase === 'checking') return '检查更新中…'
  if (s.phase === 'downloading') {
    const via = downloadSourceLabel(s.source)
    return updateNotice(s) + (via ? ` · ${via}` : '')
  }
  if (s.phase === 'preparing') return '准备更新…'
  return winInfo.value.version ? `v${winInfo.value.version}` : '检查更新'
})

/** 右上角按钮上的短文案：下载中直接给百分比 */
const updateHeaderLabel = computed(() => {
  const s = updateState.value
  if (s.phase === 'ready') return '重启更新'
  if (s.phase === 'downloading') {
    const percent = downloadPercent(s.received, s.release.bytes)
    return percent === undefined ? '下载中' : `下载 ${percent}%`
  }
  return '有新版本'
})

/** 右上角按钮底部那条进度线的宽度 */
const downloadProgress = computed(() => {
  const s = updateState.value
  return s.phase === 'downloading' && s.release.bytes > 0 ? `${Math.min(100, (s.received / s.release.bytes) * 100)}%` : '0%'
})

const aboutUpdateHint = computed(() => updateNotice(updateState.value) || '检查 GitHub 最新版本')

function openUpdateDialog(): void {
  aboutOpen.value = false
  updateDialogRef.value?.show()
}

let pluginSubscriptions: (() => void)[] = []
let pluginRefreshTimer: ReturnType<typeof setTimeout> | undefined

function schedulePluginRefresh(): void {
  if (pluginRefreshTimer !== undefined) return
  pluginRefreshTimer = setTimeout(() => {
    pluginRefreshTimer = undefined
    void devicePlugins.refresh()
  }, 60)
}

onUnmounted(() => {
  pluginSubscriptions.forEach((stop) => stop())
  clearTimeout(pluginRefreshTimer)
})

const appearance = useAppearanceStore()
const settingsOpen = ref(false)
const extensions: ToolDef = {
  id: 'extensions',
  name: '扩展中心',
  icon: 'Box',
  description: '内置模块目录',
  component: ExtensionCenter,
  singleton: true,
  phase: '',
  ready: true
}

const activeConnectionsText = computed(() => {
  const list = tabs.connectedSessions
  if (!list.length) return ''
  const labels: Record<string, string> = { serial: '串口', ssh: 'SSH', 'local-terminal': '终端' }
  const counts = new Map<string, number>()
  for (const tab of list) {
    const label = labels[tab.toolId] ?? tab.toolId
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ')
})

function compFor(toolId: string) {
  if (toolId === 'home') return HomePanel
  if (toolId === extensions.id) return ExtensionCenter
  return toolById(toolId)?.component ?? HomePanel
}

// ---------- 自绘标题栏（无边框窗口） ----------
const winInfo = ref<WinInfo>({ version: '', electron: '', chrome: '', node: '', platform: window.api?.platform ?? 'win32' })
const maximized = ref(false)

// 模板里拿不到 window 全局，经 setup 暴露
const winMinimize = (): void => window.api.win.minimize()
const winToggleMax = (): void => window.api.win.toggleMaximize()
const winClose = (): void => window.api.win.close()

onMounted(() => {
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (favicon) favicon.href = brandMark
  void appearance.init()
  pluginSubscriptions = [
    window.api.on('plugins', PLUGIN_CATALOG_PANEL, 'changed', schedulePluginRefresh),
    window.api.on('plugins', PLUGIN_CATALOG_PANEL, 'status', (payload) => {
      devicePlugins.applyStatus(payload as PluginRuntimeStatus)
    }),
    window.api.on('plugins', PLUGIN_CATALOG_PANEL, 'log', (payload) => {
      devicePlugins.appendLog(payload as PluginLogEntry)
    })
  ]
  void devicePlugins.refresh()
  window.api.win.info().then((i) => (winInfo.value = i)).catch(() => {})
  window.api.win.onMaxChange((m) => (maximized.value = m))
})
</script>

<template>
  <div class="app-shell">
    <!-- 无边框标题栏：整条可拖动，交互元素 no-drag；Windows 下双击拖动区原生最大化/还原 -->
    <header class="app-header">
      <el-popover v-model:visible="aboutOpen" placement="bottom-start" :width="276" trigger="click">
        <template #reference>
          <button class="app-logo" :title="hasUpdateHighlight ? updateStatusLabel : '版本信息与检查更新'">
            <img :src="brandMark" class="app-brand-mark" width="22" height="18" alt="" aria-hidden="true" draggable="false" />
            <span>DevKit</span>
            <span v-if="hasUpdateHighlight" class="logo-update-dot" aria-label="有可用更新" />
          </button>
        </template>
        <div class="about-box">
          <div class="about-name">DevKit 嵌入式开发套件</div>
          <div class="about-ver">版本 {{ winInfo.version || '…' }}</div>
          <el-divider style="margin: 10px 0" />
          <div class="about-row"><span>Electron</span><span class="mono">{{ winInfo.electron }}</span></div>
          <div class="about-row"><span>Chromium</span><span class="mono">{{ winInfo.chrome }}</span></div>
          <div class="about-row"><span>Node.js</span><span class="mono">{{ winInfo.node }}</span></div>
          <el-divider style="margin: 10px 0" />
          <div class="about-update-row">
            <span class="about-copy" :class="{ 'is-highlight': hasUpdateHighlight }">{{ aboutUpdateHint }}</span>
            <el-button size="small" :type="hasUpdateHighlight ? 'primary' : undefined" @click="openUpdateDialog">
              {{ hasUpdateHighlight ? '查看更新' : '检查更新' }}
            </el-button>
          </div>
        </div>
      </el-popover>
      <span class="header-divider" aria-hidden="true"></span>
      <TabBar
        ref="tabBarRef"
        @detach="detachTab"
        @preview="previewTab"
        @hide-preview="hidePreview"
        @cancel-preview="attachTab($event, false)"
      />
      <button
        v-if="hasUpdateHighlight"
        type="button"
        class="header-action header-update"
        :class="{ 'is-downloading': updateState.phase === 'downloading' }"
        :style="{ '--download-progress': downloadProgress }"
        :title="updateStatusLabel"
        @click="openUpdateDialog"
      >
        <el-icon><Refresh v-if="updateState.phase === 'ready'" /><Download v-else /></el-icon>
        <span>{{ updateHeaderLabel }}</span>
      </button>
      <button
        class="header-action"
        :class="{ active: tabs.activeToolId === extensions.id }"
        title="扩展中心"
        @click="tabs.openTool(extensions)"
      >
        <el-icon><Box /></el-icon><span>扩展</span>
      </button>
      <SettingsDialog v-model="settingsOpen">
        <button class="header-action" title="外观与终端配色" :aria-expanded="settingsOpen">
          <el-icon><Brush /></el-icon><span>外观</span>
        </button>
      </SettingsDialog>
      <div class="win-controls">
        <button class="win-btn" title="最小化" @click="winMinimize">
          <el-icon :size="15"><Minus /></el-icon>
        </button>
        <button class="win-btn" :title="maximized ? '还原' : '最大化'" @click="winToggleMax">
          <el-icon :size="13"><CopyDocument v-if="maximized" /><FullScreen v-else /></el-icon>
        </button>
        <button class="win-btn close" title="关闭" @click="winClose">
          <el-icon :size="15"><Close /></el-icon>
        </button>
      </div>
    </header>

    <WorkbenchBody :split="activeSplit" @ready="mainBody = $event" />

    <DetachedTabWindow
      v-for="entry in detachedEntries"
      :key="entry.tab.id"
      :entry="entry.window"
      :tab="entry.tab"
      :attach-at="attachAt"
      @attach="attachTab(entry.tab.id)"
      @ready="entry.window.mount = $event; windowMounted(entry.window)"
    />

    <WorkbenchPanel
      v-for="panel in renderedPanels"
      :key="panel.item.id"
      :target="panel.target"
      :slot-name="panel.slot"
      :term-target="panel.termTarget"
    >
      <component :is="compFor(panel.item.toolId)" :panel-id="panel.item.id" @open-extensions="tabs.openTool(extensions)" />
    </WorkbenchPanel>

    <footer v-if="!isSerialActive" class="app-status">
      <div class="status-left">
        <span class="status-title">{{ tabs.activeTitle }}</span>
        <span v-if="activeConnectionsText" class="status-pill">
          <i class="status-dot" aria-hidden="true"></i>
          {{ activeConnectionsText }}
        </span>
      </div>
      <div class="status-right">
        <button type="button" class="status-btn" title="快速打开工具或切换会话" @click="tabBarRef?.openLauncher()">
          <kbd>Ctrl+K</kbd> 快速切换
        </button>
        <button type="button" class="status-btn" title="切换外观与终端配色" @click="settingsOpen = !settingsOpen">
          {{ appearance.terminalTheme.name }}
        </button>
        <button
          type="button"
          class="status-btn status-version update-entry"
          :class="{ 'has-update': hasUpdateHighlight }"
          :title="hasUpdateHighlight ? updateStatusLabel : '点击检查应用更新'"
          @click="openUpdateDialog"
        >
          {{ updateStatusLabel }}
        </button>
      </div>
    </footer>

    <AppUpdateDialog
      ref="updateDialogRef"
      :current-version="winInfo.version"
      @state-change="updateState = $event"
    />
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: stretch;
  gap: 6px;
  height: 42px;
  padding: 0 0 0 10px;
  background: var(--el-bg-color-page);
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
  user-select: none;
  -webkit-app-region: drag;
}

.app-logo,
.header-action,
.win-controls {
  -webkit-app-region: no-drag;
}

/* 标签栏顶部留白 6px、标签高 36px（中轴距顶 24px）；左右按钮微沉 3px 与标签文字严格齐平 */
.app-logo {
  position: relative;
  align-self: center;
  margin-top: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease;
}

.app-logo:hover {
  background: var(--el-fill-color);
}

.logo-update-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-warning);
}

.app-brand-mark {
  display: block;
  width: 22px;
  height: 18px;
  flex: none;
  object-fit: contain;
}

.header-divider {
  align-self: center;
  margin-top: 3px;
  width: 1px;
  height: 16px;
  margin-inline: 2px 4px;
  background: var(--el-border-color);
}

.header-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  align-self: center;
  margin-top: 3px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.header-action:hover,
.header-action.active,
.header-action[aria-expanded="true"] {
  background: var(--el-fill-color-dark);
  color: var(--el-color-primary);
}

.header-update {
  position: relative;
  overflow: hidden;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 35%, transparent);
  font-weight: 600;
}

.header-update:hover {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 20%, transparent);
}

/* 下载中：按钮底部一条进度线，扫一眼就知道到哪了 */
.header-update.is-downloading::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: var(--download-progress);
  height: 2px;
  background: var(--el-color-warning);
  transition: width 0.2s ease;
}

.win-controls {
  display: flex;
  align-self: stretch;
}

.win-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 100%;
  padding: 2px 0 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.win-btn:hover {
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-primary);
}

.win-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.app-status {
  justify-content: space-between;
  gap: 12px;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.status-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 16px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-success);
}

.status-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.status-btn:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.status-btn.has-update {
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  font-weight: 600;
}

.status-btn.has-update:hover {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 20%, transparent);
}

.status-btn kbd {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
  background: var(--el-fill-color-light);
  font-size: 11px;
  line-height: 14px;
  font-family: inherit;
}
</style>

<style>
.about-box .about-update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.about-box .about-copy.is-highlight {
  color: var(--el-color-warning);
  font-weight: 600;
}
</style>
