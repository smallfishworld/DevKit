<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useTabStore } from '@renderer/stores/tabs'
import { toolById } from '@renderer/tools/registry'
import TabBar from './components/TabBar.vue'
import HomePanel from './components/HomePanel.vue'
import type { WinInfo } from '../../shared/types'

const tabs = useTabStore()

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
  </div>
</template>

<style scoped>
.app-logo,
.win-controls {
  -webkit-app-region: no-drag;
}
</style>
