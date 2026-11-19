<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Close, Refresh } from '@element-plus/icons-vue'
import { useAppearanceStore } from '@renderer/stores/appearance'
import { relativeLuminance } from '../../../shared/theme'

const visible = defineModel<boolean>({ required: true })
const appearance = useAppearanceStore()
const keyword = ref('')

/** 全部配色一次性铺开成色板栅格（按明暗排序），不再折叠进「更多终端配色」下拉 */
const allThemes = computed(() =>
  appearance.terminalThemes.map((theme) => ({
    ...theme,
    light: relativeLuminance(theme.background) > 0.5
  }))
)
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return kw ? allThemes.value.filter((t) => t.name.toLowerCase().includes(kw)) : allThemes.value
})
/** 浅色配色排在前面（与「由亮到暗」的浏览习惯一致），同组内保持注册顺序 */
const sortedThemes = computed(() => [
  ...filtered.value.filter((t) => t.light),
  ...filtered.value.filter((t) => !t.light)
])
const selectedId = computed(() => appearance.terminalTheme.id)

function choose(id: string): void {
  appearance.setTerminalTheme(id)
}

/** 关闭「跟随系统」时锁定到当前生效的配色，避免界面忽然跳回默认主题 */
function toggleFollow(on: boolean): void {
  if (on) appearance.followSystem()
  else appearance.setTerminalTheme(appearance.terminalTheme.id)
}
</script>

<template>
  <el-popover v-model:visible="visible" placement="bottom-end" :width="404" trigger="click" popper-class="appearance-popper">
    <template #reference><slot /></template>
    <section class="appearance-settings" aria-label="外观与终端配色">
      <header>
        <h2>外观与终端配色</h2>
        <el-button text size="small" :icon="Close" aria-label="关闭外观浮层" @click="visible = false" />
      </header>

      <div class="follow-row">
        <span>
          <strong>跟随系统</strong>
          <small>按 Windows 浅色/深色自动切换（深色用 DevKit 默认，浅色用 Solarized Light）</small>
        </span>
        <el-switch :model-value="appearance.settings.followSystem" size="small" @update:model-value="toggleFollow" />
      </div>

      <div class="theme-filter">
        <el-input v-model="keyword" size="small" clearable placeholder="筛选配色（如 nord、solar）" aria-label="筛选配色" />
      </div>

      <div class="theme-scroll">
        <!-- 全部配色一次性铺开，按明暗排序（浅色在前，与列表卡片观感一致），不再折叠成「更多」 -->
        <div class="theme-grid">
          <button
            v-for="theme in sortedThemes"
            :key="theme.id"
            type="button"
            class="theme-tile"
            :aria-pressed="!appearance.settings.followSystem && selectedId === theme.id"
            :title="`${theme.name}${theme.author ? ' · ' + theme.author : ''}`"
            @click="choose(theme.id)"
          >
            <span class="swatch" :style="{ background: theme.background, color: theme.foreground }">
              <i :style="{ background: theme.ansi.green }"></i>
              <i :style="{ background: theme.ansi.yellow }"></i>
              <i :style="{ background: theme.ansi.blue }"></i>
              <i :style="{ background: theme.ansi.magenta }"></i>
              <em :style="{ background: theme.cursor }"></em>
            </span>
            <span class="tile-name">{{ theme.name }}</span>
            <el-icon v-if="!appearance.settings.followSystem && selectedId === theme.id" class="tile-check"><Check /></el-icon>
          </button>
        </div>
        <p v-if="!sortedThemes.length" class="empty">没有匹配的配色</p>
      </div>

      <footer>
        <span class="current">
          <el-icon><Refresh /></el-icon>
          <template v-if="appearance.settings.followSystem">跟随系统 · 当前 {{ appearance.terminalTheme.name }}</template>
          <template v-else>当前 · {{ appearance.terminalTheme.name }}</template>
        </span>
        <small>配色同时应用到整个界面与终端</small>
      </footer>
    </section>
  </el-popover>
</template>

<style scoped>
.appearance-settings { display:flex; flex-direction:column; gap:10px; }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
h2 { margin:0; font-size:14px; }

.follow-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-fill-color-lighter); cursor:pointer; }
.follow-row strong { display:block; font-size:13px; }
.follow-row small { display:block; margin-top:2px; font-size:11px; line-height:1.45; color:var(--el-text-color-secondary); }

.theme-filter :deep(.el-input) { width:100%; }

.theme-scroll { display:flex; flex-direction:column; gap:8px; max-height:min(56vh, 460px); overflow-y:auto; padding-right:2px; }

/* 三列平铺：18 套配色一屏可见大半，滚动条只负责收尾；不用分组标题占高度 */
.theme-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px; }
/* 每个配色一块：色板条（背景 + 主色点 + 光标位）直观展示观感，不必再单开一个大预览框 */
.theme-tile { position:relative; display:flex; flex-direction:column; align-items:stretch; gap:5px; min-width:0; padding:5px; border:1px solid var(--el-border-color); border-radius:8px; background:var(--el-bg-color); color:inherit; font:inherit; cursor:pointer; transition:border-color .15s ease, background .15s ease; }
.theme-tile:hover { border-color:var(--el-color-primary-light-5); background:var(--el-fill-color-light); }
.theme-tile[aria-pressed="true"] { border-color:var(--el-color-primary); background:var(--el-color-primary-light-9); }
.theme-tile:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:1px; }

.swatch { display:flex; align-items:flex-end; gap:2px; height:30px; padding:5px 6px; border-radius:5px; border:1px solid var(--el-border-color-lighter); }
.swatch i { width:5px; height:10px; border-radius:1px; }
.swatch em { width:4px; height:12px; margin-inline-start:auto; border-radius:1px; }

.tile-name { min-width:0; padding:0 2px; overflow:hidden; font-size:11px; line-height:1.35; text-align:start; text-overflow:ellipsis; white-space:nowrap; }
/* 选中勾落在色板右上角，不挤占名称文字宽度 */
.tile-check { position:absolute; top:2px; right:2px; padding:1px; border-radius:999px; font-size:11px; color:var(--el-color-primary); background:var(--el-bg-color); }

.empty { margin:4px 0; font-size:12px; color:var(--el-text-color-secondary); }

footer { display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:8px; border-top:1px solid var(--el-border-color-lighter); font-size:11px; color:var(--el-text-color-secondary); }
.current { display:inline-flex; align-items:center; gap:5px; color:var(--el-text-color-regular); }
</style>
