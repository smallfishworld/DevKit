<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Brush } from '@element-plus/icons-vue'
import { PLUGIN_CATALOG_PANEL, useDevicePlugins } from '@renderer/stores/devicePlugins'
import { useTabStore } from '@renderer/stores/tabs'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { toolById, type ToolDef } from '@renderer/tools/registry'
import TabBar from './components/TabBar.vue'
import HomePanel from './components/HomePanel.vue'
import ExtensionCenter from './components/ExtensionCenter.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import type { WinInfo } from '../../shared/types'

const tabs = useTabStore()
const devicePlugins = useDevicePlugins()
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
  id: 'extensions', name: '扩展中心', icon: 'Box', description: '内置模块目录',
  component: ExtensionCenter, singleton: true, phase: '', ready: true
}

function compFor(toolId: string) {
  if (toolId === 'home') return HomePanel
  if (toolId === extensions.id) return ExtensionCenter
  return toolById(toolId)?.component ?? HomePanel
}

// ---------- 自绘标题栏（无边框窗口） ----------
const winInfo = ref<WinInfo>({ version: '', electron: '', chrome: '', node: '' })
const maximized = ref(false)

// 模板里拿不到 window 全局，经 setup 暴露
const winMinimize = (): void => window.api.win.minimize()
const winToggleMax = (): void => window.api.win.toggleMaximize()
const winClose = (): void => window.api.win.close()

onMounted(() => {
  void appearance.init()
  pluginSubscriptions = ['changed', 'status', 'log'].map((type) =>
    window.api.on('plugins', PLUGIN_CATALOG_PANEL, type, schedulePluginRefresh))
  void devicePlugins.refresh()
  window.api.win.info().then((i) => (winInfo.value = i)).catch(() => {})
  window.api.win.onMaxChange((m) => (maximized.value = m))
})
</script>

<template>
  <div class="app-shell">
    <!-- 无边框标题栏：整条可拖动，交互元素 no-drag；Windows 下双击拖动区原生最大化/还原 -->
    <header class="app-header">
      <el-popover placement="bottom-start" :width="264" trigger="click">
        <template #reference>
          <button class="app-logo" title="版本信息">
            <el-icon :size="19" color="var(--el-color-primary)"><Cpu /></el-icon>
            <span>DevKit</span>
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
          <div class="about-copy">Windows only · 离线可用</div>
        </div>
      </el-popover>
      <span class="header-divider" aria-hidden="true"></span>
      <TabBar />
      <button class="header-action" title="扩展中心" @click="tabs.openTool(extensions)">
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


    <main class="app-body">
      <section
        v-for="tab in tabs.tabs"
        :key="tab.id"
        v-show="tab.id === tabs.activeId"
        class="tab-page"
      >
        <component :is="compFor(tab.toolId)" :panel-id="tab.id" @open-extensions="tabs.openTool(extensions)" />
      </section>
    </main>

    <footer v-if="tabs.active?.toolId !== 'serial'" class="app-status">
      {{ tabs.active?.title ?? 'DevKit' }}
    </footer>

  </div>
</template>

<style scoped>
.app-logo,
.header-action,
:deep(.tab-bar),
.win-controls {
  -webkit-app-region: no-drag;
}

.header-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  align-self: center;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.header-action:hover {
  background: var(--el-fill-color-dark);
  color: var(--el-color-primary);
}
.app-header { height:40px; align-items:stretch; gap:4px; padding:5px 0 0 8px; }
.app-logo { align-self:center; width:auto; height:28px; margin-bottom:5px; gap:6px; padding:4px 8px; color:inherit; font-size:13px; font-weight:700; }
.header-divider { align-self:center; width:1px; height:16px; margin:0 4px 5px 2px; background:var(--el-border-color); }
:deep(.tab-bar) { flex:1; min-width:0; height:auto; padding:0; gap:3px; border:0; background:transparent; }
:deep(.tab-item) { height:34px; border-radius:8px 8px 0 0; }
:deep(.tab-item.active) { background:var(--el-bg-color-overlay); }
.win-controls { margin-top:-5px; }
.win-btn { width:40px; }
</style>
