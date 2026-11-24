import { ElDialog, ElDropdown, ElMessage, ElMessageBox, ElPopover, ElSelect, ElTooltip, type ElMessageBoxOptions, type MessageOptions } from 'element-plus'
import { defineComponent, h, inject, mergeProps, nextTick, provide, shallowRef, useId, watchEffect, type App, type Component, type InjectionKey } from 'vue'
import { usePanelDocument, usePanelOverlayTarget } from './usePanelWindow'

interface OverlayHandle {
  $el?: Node
  blur?: () => void
  hide?: () => void
  handleClose?: () => void
  visible?: boolean
  dialogContentRef?: { $el: HTMLElement }
}

interface OverlayDismissal {
  element: () => HTMLElement | undefined
  outside?: (event: PointerEvent, element: HTMLElement) => void
  escape?: (element: HTMLElement) => void
}

const dismissalsByDocument = new WeakMap<Document, Set<OverlayDismissal>>()
const popperAncestors: InjectionKey<string[]> = Symbol('popperAncestors')

/** Element Plus installs its global dismissal handlers in the opener document. */
export function registerDetachedOverlayEvents(doc: Document): () => void {
  const dismissals = new Set<OverlayDismissal>()
  dismissalsByDocument.set(doc, dismissals)

  const onPointerDown = (event: PointerEvent): void => {
    for (const overlay of dismissals) {
      if (!overlay.outside) continue
      const element = overlay.element()
      if (element?.getClientRects().length) overlay.outside(event, element)
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    let top: { overlay: OverlayDismissal; element: HTMLElement; z: number } | undefined
    for (const overlay of dismissals) {
      const element = overlay.element()
      if (!element?.getClientRects().length) continue
      const z = Number(element.style.zIndex)
      if (!top || z >= top.z) top = { overlay, element, z }
    }
    if (!top) return
    event.preventDefault()
    top.overlay.escape?.(top.element)
  }

  doc.addEventListener('pointerdown', onPointerDown)
  doc.addEventListener('keydown', onKeyDown)
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown)
    doc.removeEventListener('keydown', onKeyDown)
    dismissalsByDocument.delete(doc)
  }
}

function triggerFor(element: HTMLElement): HTMLElement | null {
  if (!element.id) return null
  const id = CSS.escape(element.id)
  return element.ownerDocument.querySelector(`[aria-describedby~="${id}"], [aria-controls="${id}"]`)
}

/** Keep teleported Element Plus content in the same native window as its panel. */
export function installPanelOverlays(app: App): void {
  const overlays: Record<string, Component> = {
    'el-dialog': ElDialog,
    'el-dropdown': ElDropdown,
    'el-popover': ElPopover,
    'el-select': ElSelect,
    'el-tooltip': ElTooltip
  }
  for (const [name, component] of Object.entries(overlays)) {
    app.component(name, defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        const owner = usePanelDocument()
        const target = usePanelOverlayTarget()
        const instance = shallowRef<OverlayHandle>()
        const marker = `devkit-popper-${useId()}`
        const ancestors = inject(popperAncestors, [])
        const isDialog = name === 'el-dialog'
        const managesPopper = name === 'el-select' || name === 'el-dropdown' || name === 'el-popover'
        if (managesPopper) provide(popperAncestors, [...ancestors, marker])
        let dialogInvoker: HTMLElement | null = null

        function closePopper(): void {
          if (name === 'el-select') instance.value?.blur?.()
          else if (name === 'el-popover') instance.value?.hide?.()
          else instance.value?.handleClose?.()
        }

        watchEffect((cleanup) => {
          const doc = owner.value
          const dismissals = dismissalsByDocument.get(doc)
          if (!dismissals || (!isDialog && !managesPopper)) return
          const dismissal: OverlayDismissal = isDialog ? {
            element: () => instance.value?.visible
              ? instance.value.dialogContentRef?.$el.closest<HTMLElement>('.el-overlay') ?? undefined
              : undefined,
            escape: () => {
              if (attrs['close-on-press-escape'] === false || attrs.closeOnPressEscape === false) return
              instance.value?.handleClose?.()
            }
          } : {
            element: () => doc.querySelector<HTMLElement>(`.el-popper.${marker}`) ?? undefined,
            outside: (event, element) => {
              const node = event.target as Node | null
              if (!node || instance.value?.$el?.contains(node) ||
                triggerFor(element)?.contains(node) ||
                (node as Element).closest?.(`.${marker}, .${marker}-child`)) return
              closePopper()
            },
            escape: (element) => {
              closePopper()
              triggerFor(element)?.focus({ preventScroll: true })
            }
          }
          dismissals.add(dismissal)
          cleanup(() => dismissals.delete(dismissal))
        })

        return () => {
          const props = { appendTo: target.value, ...attrs, ref: instance }
          if (!target.value) return h(component, props, slots)
          if (isDialog) {
            return h(component, mergeProps(props, {
              closeOnPressEscape: false,
              onOpen: () => { dialogInvoker = owner.value.activeElement as HTMLElement | null },
              onClosed: () => {
                if (owner.value.activeElement === owner.value.body) dialogInvoker?.focus({ preventScroll: true })
                dialogInvoker = null
              }
            }), slots)
          }
          if (!managesPopper) return h(component, props, slots)
          const popperClass = [attrs['popper-class'] ?? attrs.popperClass, marker,
            ...ancestors.map((ancestor) => `${ancestor}-child`)].filter(Boolean).join(' ')
          return h(component, { ...props, popperClass }, slots)
        }
      }
    }))
  }
}

export function usePanelMessage() {
  const target = usePanelOverlayTarget()
  const send = (options: string | MessageOptions) =>
    ElMessage({ ...(typeof options === 'string' ? { message: options } : options), appendTo: target.value })
  return Object.assign(send, {
    success: (message: string) => send({ type: 'success', message }),
    warning: (message?: string) => send({ type: 'warning', message }),
    error: (message?: string) => send({ type: 'error', message }),
    info: (message: string) => send({ type: 'info', message })
  })
}

export function usePanelMessageBox() {
  const owner = usePanelDocument()
  const target = usePanelOverlayTarget()
  const id = useId()
  let sequence = 0
  return {
    confirm(message: string, title: string, options: ElMessageBoxOptions) {
      const doc = owner.value
      const dismissals = dismissalsByDocument.get(doc)
      if (!dismissals) return ElMessageBox.confirm(message, title, options)
      const invoker = doc.activeElement as HTMLElement | null
      const marker = `devkit-message-box-${id}-${++sequence}`
      let close: (() => void) | undefined
      const dismissal: OverlayDismissal = {
        element: () => target.value?.querySelector<HTMLElement>(`.${marker}`)?.closest<HTMLElement>('.el-overlay') ?? undefined,
        escape: () => { if (options.closeOnPressEscape !== false) close?.() }
      }
      dismissals.add(dismissal)
      return ElMessageBox.confirm((actions) => {
        close = actions.close
        return h('span', message)
      }, title, {
        ...options,
        appendTo: target.value,
        customClass: [options.customClass, marker].filter(Boolean).join(' '),
        closeOnPressEscape: false,
        lockScroll: false
      }).finally(() => {
        dismissals.delete(dismissal)
        void nextTick(() => invoker?.focus({ preventScroll: true }))
      })
    }
  }
}
