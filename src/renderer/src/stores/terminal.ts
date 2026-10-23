import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_SCROLLBACK, normalizeScrollback } from '../../../shared/terminal-stream'

export const useTerminalSettings = defineStore('terminal-settings', () => {
  const scrollback = ref(DEFAULT_SCROLLBACK)
  let initializing: Promise<void> | undefined
  function init(): Promise<void> {
    return initializing ??= window.api.invoke('settings', 'terminal:get', 'global').then((value) => {
      scrollback.value = normalizeScrollback((value as { scrollback?: number })?.scrollback)
    }).catch((error) => console.warn('[terminal settings]', error))
  }
  async function save(value: number): Promise<void> {
    await window.api.invoke('settings', 'terminal:set', 'global', { scrollback: normalizeScrollback(value) })
    scrollback.value = normalizeScrollback(value)
  }
  return { scrollback, init, save }
})
