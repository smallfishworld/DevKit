import { onMounted, onUnmounted, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { OutputFrame } from '../../../shared/terminal-stream'

interface TerminalSink {
  write(text: string, done?: () => void): void
  reset(): void
  resync(): void
}

/** ACK only after xterm has parsed the frame, never merely after IPC receipt. */
export function useTerminalStream(tool: string, panelId: string, terminal: Ref<TerminalSink | null>): void {
  let alive = true
  let unsubscribe: Array<() => void> = []
  onMounted(() => {
    unsubscribe = [
      window.api.on(tool, panelId, 'data', (payload) => {
        const frame = payload as OutputFrame
        terminal.value?.write(frame.text, () => {
          if (alive) void window.api.invoke(tool, 'output:ack', panelId, {
            generation: frame.generation, sequence: frame.sequence
          }).catch(() => {})
        })
      }),
      window.api.on(tool, panelId, 'output:reset', () => terminal.value?.reset()),
      window.api.on(tool, panelId, 'output:resync', () => terminal.value?.resync()),
      window.api.on(tool, panelId, 'output:overflow', (payload) => {
        void ElMessageBox.alert((payload as { message: string }).message, '终端显示已暂停', { type: 'warning' }).catch(() => {})
      })
    ]
  })
  onUnmounted(() => { alive = false; unsubscribe.forEach((dispose) => dispose()) })
}
