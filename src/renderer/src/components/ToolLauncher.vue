<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { TOOLS } from '@renderer/tools/registry'
import { useTabStore } from '@renderer/stores/tabs'
import { launcherIndex, matchesTool } from './workbench-navigation'

const tabs = useTabStore()
const dialog = ref<HTMLDialogElement>()
const query = ref('')
const selected = ref(0)
const entries = computed(() => [
  ...tabs.tabs.flatMap((tab) => {
    const tool = TOOLS.find((item) => item.id === tab.toolId)
    return tool && ['serial', 'ssh', 'local-terminal'].includes(tool.id)
      ? [{ key: tab.id, name: tab.title, tool, tabId: tab.id }]
      : []
  }),
  ...TOOLS.filter((tool) => tool.ready).map((tool) => ({ key: tool.id, name: tool.name, tool, tabId: '' }))
].filter(({ name, tool }) => matchesTool(query.value, name, tool.name, tool.id, tool.description)))

function open(): void {
  if (!dialog.value || dialog.value.open) return
  query.value = ''
  selected.value = 0
  dialog.value.showModal()
}

function activate(index: number): void {
  const entry = entries.value[index]
  if (!entry) return
  dialog.value?.close()
  if (entry.tabId) tabs.activate(entry.tabId)
  else tabs.openTool(entry.tool)
}

async function onSearchKey(event: KeyboardEvent): Promise<void> {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') {
    event.preventDefault()
    activate(selected.value)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    selected.value = launcherIndex(selected.value, event.key === 'ArrowDown' ? 1 : -1, entries.value.length)
    await nextTick()
    dialog.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
}

function onShortcut(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.isComposing || event.key.toLowerCase() !== 'k') return
  if (document.querySelector('dialog[open], .el-overlay-dialog:not([aria-hidden="true"]) .el-dialog') && !dialog.value?.open) {
    const active = document.activeElement
    if (active?.closest('.el-dialog, dialog[open]')) return
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  open()
}

onMounted(() => window.addEventListener('keydown', onShortcut, true))
onUnmounted(() => window.removeEventListener('keydown', onShortcut, true))
defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="tool-launcher" aria-label="快速打开工具">
      <div class="launcher-search">
        <el-icon aria-hidden="true"><Search /></el-icon>
        <input v-model="query" type="search" role="combobox" aria-expanded="true" aria-controls="launcher-tools"
          :aria-activedescendant="entries[selected] ? 'launcher-option-' + selected : undefined"
          aria-label="搜索工具或切换终端会话" placeholder="搜索工具或切换终端会话…" autofocus
          @input="selected = 0" @keydown="onSearchKey" />
        <kbd>Esc</kbd>
      </div>
      <ul id="launcher-tools" role="listbox" aria-label="工具和会话">
        <li v-for="(entry, index) in entries" :id="'launcher-option-' + index" :key="entry.key"
          role="option" :aria-selected="index === selected" @mousedown.prevent @click="activate(index)">
          <el-icon><component :is="entry.tool.icon" /></el-icon>
          <strong>{{ entry.name }}</strong><small>{{ entry.tabId ? '已打开的会话' : entry.tool.description }}</small>
        </li>
      </ul>
      <p v-if="!entries.length" class="launcher-empty">未找到匹配的工具</p>
      <footer><span>↑↓ 选择 · Enter 打开</span><form method="dialog"><button type="submit">关闭</button></form></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.tool-launcher { width:min(570px, calc(100vw - 32px)); max-height:min(580px, calc(100vh - 32px)); padding:0; color:var(--el-text-color-primary); background:var(--el-bg-color-overlay); border:1px solid var(--el-border-color); border-radius:12px; box-shadow:var(--el-box-shadow-dark); overscroll-behavior:contain; }
.tool-launcher::backdrop { background:#0007; }
.launcher-search, footer { display:flex; align-items:center; gap:10px; padding:10px 14px; }
.launcher-search { border-bottom:1px solid var(--el-border-color-lighter); }
.launcher-search input { flex:1; min-width:0; padding:6px; border:0; border-radius:4px; font:inherit; color:inherit; background:transparent; }
.launcher-search input:focus-visible { outline:1px solid var(--el-color-primary); }
ul { max-height:min(360px, 50vh); margin:0; padding:6px; overflow:auto; list-style:none; }
li { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:6px; cursor:pointer; }
li:hover, li[aria-selected="true"] { background:var(--el-color-primary-light-9); }
li small { margin-inline-start:auto; color:var(--el-text-color-secondary); text-align:end; }
.launcher-empty { margin:10px 16px; }
footer { justify-content:space-between; border-top:1px solid var(--el-border-color-lighter); color:var(--el-text-color-secondary); font-size:12px; }
footer button, kbd { padding:2px 6px; color:inherit; background:var(--el-fill-color-light); border:1px solid var(--el-border-color); border-radius:4px; }
footer button { cursor:pointer; }
</style>
