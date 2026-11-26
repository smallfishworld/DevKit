<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { hostSharesQuickCmds, SPLIT_DEFAULT_PCT, splitGridColumns, splitPctAtPointer, writeStoredSplitPct } from './split-tab'
import { useTabStore, type SplitTab } from '@renderer/stores/tabs'
import SplitQuickCmds from './SplitQuickCmds.vue'
import { providePanelDocument } from '../composables/usePanelWindow'

const props = defineProps<{ split?: SplitTab; ownerDocument?: Document }>()
const { t } = useI18n()
const emit = defineEmits<{ ready: [mount: HTMLElement] }>()
const tabs = useTabStore()
const panels = ref<HTMLElement>()
providePanelDocument(() => props.ownerDocument ?? document)
onMounted(() => { if (panels.value) emit('ready', panels.value) })

/** 内容区恒为四列网格：共享快捷命令栏 | 左成员 | 分隔条 | 右成员；非分屏条目的面板横跨整行 */
const splitGridStyle = computed(() => ({ gridTemplateColumns: splitGridColumns(props.split?.splitPct ?? SPLIT_DEFAULT_PCT) }))
const sharedCmds = computed(() => props.split && hostSharesQuickCmds(props.split) ? props.split.members : undefined)
const sharedCmdsHidden = ref(false)

let dividerDrag = false
function onDividerPointerdown(e: PointerEvent): void {
  // 只响应主键，避免右键/中键在分隔条上误触发拖拽
  if (e.button !== 0) return
  dividerDrag = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onDividerPointermove(e: PointerEvent): void {
  if (!dividerDrag) return
  // 捕获丢失（切窗、系统打断）后不会再有 pointerup：主键已松开就顺手结束，避免悬停即改比例
  if (!(e.buttons & 1)) {
    finishDividerDrag()
    return
  }
  const container = (e.currentTarget as HTMLElement).parentElement
  if (!container || !props.split) return
  const rect = container.getBoundingClientRect()
  // 左侧的共享快捷命令栏不参与两个成员的宽度分配
  const leading = container.querySelector('.split-cmds')?.getBoundingClientRect().width ?? 0
  tabs.resizeSplit(props.split.id, splitPctAtPointer(e.clientX - rect.left, rect.width, leading))
}
function finishDividerDrag(): void {
  if (!dividerDrag) return
  dividerDrag = false
  if (props.split) writeStoredSplitPct(props.split.splitPct)
}
</script>

<template>
  <main class="app-body" :class="{ 'show-term-target': sharedCmds && !sharedCmdsHidden }" :style="splitGridStyle">
    <SplitQuickCmds v-if="sharedCmds" :members="sharedCmds" @hidden-change="sharedCmdsHidden = $event" />
    <div ref="panels" class="tab-pages" />
    <div
      v-if="split"
      class="split-divider"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('workbench.resizeSplitAria')"
      @pointerdown="onDividerPointerdown"
      @pointermove="onDividerPointermove"
      @pointerup="finishDividerDrag"
      @pointercancel="finishDividerDrag"
      @lostpointercapture="finishDividerDrag"
    >
      <span class="split-grip" aria-hidden="true"></span>
    </div>
  </main>
</template>

<style scoped>
/* ---------- 合并分屏（两个面板并排共用一个标签） ---------- */
/* 面板所在网格与落位规则见 global.css 的 .app-body / .tab-page */

/* 分隔条：显式落在第 1 行第 3 列、占满整行高度。必须显式落位——它在 DOM 里排在
   右侧面板之后，靠自动放置会掉到第二行。z-index 1 压过两侧面板整棵子树 */
.split-divider {
  grid-area: 1 / 3;
  position: relative;
  z-index: 1;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

/* 拖拽热区延伸进两侧面板（不占布局）：命中、光标与悬停反馈都落在它上面 */
.split-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -6px;
  right: -6px;
  background: transparent;
  transition: background 0.15s ease;
}

.split-divider:hover::before,
.split-divider:active::before {
  background: color-mix(in srgb, var(--el-color-primary) 25%, transparent);
}

.split-divider::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-50%);
  background: var(--el-border-color);
}

/* 中央把手：常驻可见，标出「这里可以拖」；悬停/拖拽时转为主色（盖住细线） */
.split-grip {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  width: 4px;
  height: 28px;
  transform: translate(-50%, -50%);
  border-radius: 2px;
  background: var(--el-text-color-placeholder);
  transition: background 0.15s ease;
}

.split-divider:hover .split-grip,
.split-divider:active .split-grip {
  background: var(--el-color-primary);
}

</style>
