/**
 * 左侧侧栏（快捷命令栏）拖拽调宽（VS Code 式分隔条）
 * 串口助手 / SSH 终端共用：按下分隔条后整窗拖动，宽度限制 150~460，松手持久化
 */
import { onUnmounted, type Ref } from 'vue'

export function useSidebarDrag(
  /** 宽度（px），由调用方持久化 */
  width: Ref<number>,
  /** 宽度变化时回调（松手后触发一次持久化） */
  onCommit?: (w: number) => void
) {
  const MIN = 150
  const MAX = 460
  let owner: Document | undefined
  let startX = 0
  let startW = 0

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    if (owner) onMouseUp()
    owner = target.ownerDocument
    startX = e.clientX
    startW = width.value
    owner.body.style.cursor = 'col-resize'
    owner.body.style.userSelect = 'none'
    owner.addEventListener('mousemove', onMouseMove)
    owner.addEventListener('mouseup', onMouseUp)
    owner.defaultView?.addEventListener('blur', onMouseUp)
    e.preventDefault()
  }

  function onMouseMove(e: MouseEvent): void {
    if (!(e.buttons & 1)) {
      onMouseUp()
      return
    }
    width.value = Math.min(MAX, Math.max(MIN, startW + (e.clientX - startX)))
  }

  function onMouseUp(): void {
    if (!owner) return
    owner.removeEventListener('mousemove', onMouseMove)
    owner.removeEventListener('mouseup', onMouseUp)
    owner.defaultView?.removeEventListener('blur', onMouseUp)
    owner.body.style.cursor = ''
    owner.body.style.userSelect = ''
    owner = undefined
    onCommit?.(width.value)
  }

  onUnmounted(onMouseUp)

  return { onMouseDown }
}
