/**
 * 串口「机密值」显示遮蔽：插件用 `write(..., { secret: true })` 写出的内容
 * 在设备回显、终端显示与日志里都要遮掉，跨批拼回也算（口令可能被拆到两批）。
 * 从原设备动作子系统独立出来——插件能力仍需要它。
 */
export class SerialSecretRedactor {
  private secrets = new Map<string, string[]>()
  private count = 0
  private pending = ''
  private pendingAt = 0

  add(secret: string): void {
    const candidates = this.secrets.get(secret[0]) ?? []
    if (candidates.includes(secret)) return
    if (this.count >= 64) throw new Error('本连接登记的口令数达到上限，请重新连接设备')
    this.count++
    candidates.push(secret)
    candidates.sort((a, b) => b.length - a.length)
    this.secrets.set(secret[0], candidates)
  }

  push(text: string, receivedAt: number, emit: (text: string, receivedAt: number) => void): void {
    const input = this.pending + text
    const pendingLength = this.pending.length
    const pendingAt = this.pendingAt
    this.pending = ''
    let cursor = 0
    let output = ''
    let outputAt = pendingLength ? pendingAt : receivedAt
    while (cursor < input.length) {
      if (cursor >= pendingLength && outputAt !== receivedAt) {
        if (output) emit(output, outputAt)
        output = ''
        outputAt = receivedAt
      }
      const secret = this.secrets.get(input[cursor])?.find((value) => input.startsWith(value, cursor) ||
        (input.length - cursor < value.length && value.startsWith(input.slice(cursor))))
      if (!secret) {
        output += input[cursor++]
        continue
      }
      if (input.length - cursor < secret.length) {
        this.pending = input.slice(cursor)
        this.pendingAt = cursor < pendingLength ? pendingAt : receivedAt
        break
      }
      cursor += secret.length
      output += '[口令已隐藏]'
    }
    if (output) emit(output, outputAt)
  }

  finish(): string {
    if (!this.pending) return ''
    this.pending = ''
    return '[可能的口令片段已隐藏]'
  }
}
