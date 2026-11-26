import { i18n } from '../i18n'
import { nextTick, onUnmounted, ref, shallowReactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useTabStore } from '@renderer/stores/tabs'
import type { TabWindowCommand } from '../../../shared/types'
import { registerDetachedOverlayEvents } from './panelOverlays'
import { setPanelOverlayTarget } from './usePanelWindow'

export interface DetachedTab {
  name: string
  popup: Window
  root: HTMLElement
  mount?: HTMLElement
  pending: 'show' | 'focus' | 'hide'
  wasActive: boolean
  cleanup: () => void
}

let nextWindowId = 0
type DragOffset = { offsetX: number; offsetY: number }

/** Include lazy tool styles in popups opened before their chunks finish loading. */
function copyWorkbenchStyles(target: Document): () => void {
  const base = target.createElement('base')
  base.href = document.baseURI
  target.head.appendChild(base)
  const copies = new Map<Element, { html: string; node: Node }>()
  function sync(): void {
    const source = document.documentElement
    const root = target.documentElement
    root.className = source.className
    root.style.cssText = source.style.cssText
    root.lang = source.lang
    root.dataset.uiTheme = source.dataset.uiTheme
    for (const [style, copy] of copies) {
      if (!document.head.contains(style)) {
        target.head.removeChild(copy.node)
        copies.delete(style)
      }
    }
    for (const style of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const previous = copies.get(style)
      const html = style.outerHTML
      if (previous?.html === html) continue
      const node = style.cloneNode(true)
      if (previous) target.head.replaceChild(node, previous.node)
      else target.head.appendChild(node)
      copies.set(style, { html, node })
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang', 'data-ui-theme'] })
  return () => observer.disconnect()
}

export function sendTabWindow(name: string, command: TabWindowCommand): void {
  window.api.win.tabWindow(name, command)
}

export function useDetachedTabs() {
  const tabs = useTabStore()
  const windows = shallowReactive(new Map<string, DetachedTab>())
  const workbenchAvailable = ref(true)

  function openTab(id: string, offset?: DragOffset): DetachedTab | undefined {
    if (id === 'home' || !tabs.workbenchTabs.some((tab) => tab.id === id)) return
    const name = `devkit-tab-${++nextWindowId}`
    const popup = window.open('about:blank', name, 'popup')
    if (!popup) return

    try {
      const doc = popup.document
      // These nodes are adopted from the workbench document, like Vue's own nodes.
      const root = document.createElement('div')
      const overlays = document.createElement('div')
      doc.body.append(root, overlays)
      root.id = 'app'
      setPanelOverlayTarget(doc, overlays)
      const stopStyles = copyWorkbenchStyles(doc)
      const stopOverlayEvents = registerDetachedOverlayEvents(doc)
      const entry = shallowReactive<DetachedTab>({
        name, popup, root, pending: offset ? 'show' : 'focus',
        wasActive: tabs.activeId === id,
        cleanup: () => {
          stopOverlayEvents()
          stopStyles()
        }
      })
      windows.set(id, entry)
      tabs.markDetached(id)
      return entry
    } catch (error) {
      popup.close()
      console.error('[tab-window]', error)
      return
    }
  }

  function windowMounted(entry: DetachedTab): void {
    void nextTick(() => sendTabWindow(entry.name, { action: entry.pending }))
  }

  function previewTab(id: string, offset: DragOffset): void {
    const entry = windows.get(id) ?? openTab(id, offset)
    if (!entry) return
    const needsShow = entry.pending !== 'show'
    entry.pending = 'show'
    sendTabWindow(entry.name, { action: 'move', ...offset })
    if (entry.mount && needsShow) sendTabWindow(entry.name, { action: 'show' })
  }

  function hidePreview(id: string): void {
    const entry = windows.get(id)
    if (!entry || entry.pending === 'hide') return
    entry.pending = 'hide'
    sendTabWindow(entry.name, { action: 'hide' })
  }

  function detachTab(id: string): void {
    const entry = windows.get(id) ?? openTab(id)
    if (!entry) {
      ElMessage.error(i18n.global.t('miscUi.detachWindowFailed'))
      return
    }
    entry.pending = 'focus'
    if (entry.mount) sendTabWindow(entry.name, { action: 'focus' })
  }

  function attachTab(id: string, activate = true): void {
    const entry = windows.get(id)
    if (!entry || !tabs.detachedIds.includes(id)) return
    tabs.markAttached(id)
    if (activate || entry.wasActive) tabs.activate(id)
    // Let Teleport move the live panels before disposing their old container.
    void nextTick(async () => {
      if (windows.get(id) !== entry) return
      windows.delete(id)
      entry.cleanup()
      await nextTick()
      sendTabWindow(entry.name, { action: activate ? 'attach' : 'close' })
    })
  }

  const stopClose = window.api.win.onTabWindowClosed((name, closeWorkbench) => {
    for (const [id, entry] of windows) {
      if (entry.name !== name) continue
      windows.delete(id)
      entry.cleanup()
      if (tabs.detachedIds.includes(id)) tabs.close(id)
      break
    }
    if (closeWorkbench) window.api.win.close()
  })
  const stopVisibility = window.api.win.onWorkbenchVisibility((visibility) => {
    workbenchAvailable.value = visibility === 'shown'
    if (visibility === 'closed') tabs.closeAll()
  })

  tabs.$onAction(({ name, args }) => {
    if (name !== 'activate') return
    const id = tabs.hostId(args[0] as string)
    const entry = id && tabs.detachedIds.includes(id) ? windows.get(id) : undefined
    if (entry) sendTabWindow(entry.name, { action: 'focus' })
  })

  onUnmounted(() => {
    stopClose()
    stopVisibility()
    for (const entry of windows.values()) {
      entry.cleanup()
      entry.popup.close()
    }
  })

  return { windows, workbenchAvailable, detachTab, attachTab, previewTab, hidePreview, windowMounted }
}
