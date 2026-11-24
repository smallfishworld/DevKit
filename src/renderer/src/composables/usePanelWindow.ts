import { computed, inject, provide, type InjectionKey } from 'vue'

const panelDocument: InjectionKey<() => Document> = Symbol('panelDocument')
const overlayTargets = new WeakMap<Document, HTMLElement>()

export function providePanelDocument(getDocument: () => Document): void {
  provide(panelDocument, getDocument)
}

export function usePanelDocument() {
  const getDocument = inject(panelDocument, () => document)
  return computed(getDocument)
}

export function setPanelOverlayTarget(doc: Document, target: HTMLElement): void {
  overlayTargets.set(doc, target)
}

export function usePanelOverlayTarget() {
  const owner = usePanelDocument()
  return computed(() => overlayTargets.get(owner.value))
}
