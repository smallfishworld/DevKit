/**
 * 拖放文件/文件夹到比对视图（文本/文件夹/十六进制共用）
 * Electron 已移除 File.path，路径经 preload 的 webUtils.getPathForFile 获取。
 * 语义：
 * - 拖 1 个路径 → 落到拖放的目标侧
 * - 拖 2 个路径 → 第 1 个给落点侧，第 2 个给对侧（BC 的"左旧右新"习惯，拖哪边哪个在前）
 */
import { ref } from 'vue'

export type DropSide = 'left' | 'right'

/** 拖入的是否本机文件（忽略组件内部拖拽/文本拖入） */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/** 从 DataTransfer 提取本机文件/文件夹路径列表（走 preload webUtils） */
function extractPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const files = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : []
  const out: string[] = []
  for (const it of files) {
    const f = it.getAsFile()
    if (!f) continue
    try {
      const p = window.api.dragPath(f)
      if (p) out.push(p)
    } catch {
      /* entry 已失效跳过 */
    }
  }
  return out
}

/**
 * 双侧拖放：overLeft/overRight 悬停高亮由调用方绑定到左右落区
 * handle(side, paths)：side = 拖 1 个时的落点侧；拖 2 个时调用方按“首给落点侧、次给对侧”处理
 */
export function useDropSides(handle: (side: DropSide, paths: string[]) => void) {
  const overLeft = ref(false)
  const overRight = ref(false)

  function onDragOver(side: DropSide, e: DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
    if (side === 'left') overLeft.value = true
    else overRight.value = true
  }

  function onDragLeave(side: DropSide): void {
    if (side === 'left') overLeft.value = false
    else overRight.value = false
  }

  function onDrop(side: DropSide, e: DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation() // 防止冒泡到面板级落区造成二次处理
    if (side === 'left') overLeft.value = false
    else overRight.value = false
    const paths = extractPaths(e)
    if (paths.length === 0) return
    handle(side, paths.slice(0, 2))
  }

  return { overLeft, overRight, onDragOver, onDragLeave, onDrop }
}
