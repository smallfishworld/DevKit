/**
 * 左侧会话栏拖拽调宽（VS Code 式分隔条）
 * 串口助手 / SSH 终端共用：按下分隔条后整窗拖动，宽度限制 150~460，松手持久化
 */
import { onMounted, onUnmounted, type Ref } from 'vue'

export function useSidebarDrag(
  /** 宽度（px），由调用方持久化 */
  width: Ref<number>,
  /** 宽度变化时回调（松手后触发一次持久化） */
  onCommit?: (w: number) => void
) {
  const MIN = 150
  const MAX = 460
  let dragging = false
  let startX = 0
  let startW = 0

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    dragging = true
    startX = e.clientX
    startW = width.value
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return
    width.value = Math.min(MAX, Math.max(MIN, startW + (e.clientX - startX)))
  }

  function onMouseUp(): void {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    onCommit?.(width.value)
  }

  onMounted(() => {
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  })
  onUnmounted(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    onMouseUp()
  })

  return { onMouseDown }
}