/**
 * 标签拖拽共享状态：分屏时左右两个 TabBar 实例共用，
 * 使标签可以跨栏拖放（drop 目标在另一栏时由 moveTab 翻转 pane）。
 */
import { ref } from 'vue'

export const draggingId = ref<string | null>(null)
export const overId = ref<string | null>(null)
export const overSide = ref<'before' | 'after'>('before')
