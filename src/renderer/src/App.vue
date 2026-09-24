<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useTabStore } from '@renderer/stores/tabs'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { toolById } from '@renderer/tools/registry'
import TabBar from './components/TabBar.vue'
import HomePanel from './components/HomePanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import type { WinInfo } from '../../shared/types'

const tabs = useTabStore()
const appearance = useAppearanceStore()
const settingsOpen = ref(false)

function compFor(toolId: string) {
  if (toolId === 'home') return HomePanel
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
      <span class="app-title">DevKit</span>
      <div class="header-spacer"></div>
      <button class="header-action" title="终端配色（皮肤）" @click="settingsOpen = true">
        <svg
          class="skin-icon"
          :width="16"
          :height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <!-- T恤（皮肤/主题）图标 -->
          <path d="M15 4l6 2v5h-3v8a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-8h-3v-5l6 -2a3 3 0 0 0 6 0" />
        </svg>
      </button>
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

    <TabBar />

    <main class="app-body">
      <section
        v-for="tab in tabs.tabs"
        :key="tab.id"
        v-show="tab.id === tabs.activeId"
        class="tab-page"
      >
        <component :is="compFor(tab.toolId)" :panel-id="tab.id" />
      </section>
    </main>

    <footer class="app-status">
      {{ tabs.active?.title ?? 'DevKit' }}
    </footer>

    <SettingsDialog v-model="settingsOpen" />
  </div>
</template>

<style scoped>
.app-logo,
.header-action,
.win-controls {
  -webkit-app-region: no-drag;
}

.header-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 100%;
  padding: 0;
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
</style>
