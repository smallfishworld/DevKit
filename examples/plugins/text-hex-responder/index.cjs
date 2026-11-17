'use strict'

// This is an independent CommonJS plugin. It never imports DevKit or serialport.
exports.activate = async function activate(ctx) {
  const cfg = ctx.config
  let closed = false
  let textBuffer = ''
  let bytesBuffer = Buffer.alloc(0)
  let replies = 0
  const sleepers = new Set()
  const maxBytes = cfg.maxBufferBytes || 8192
  const endings = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' }

  function hex(value, name) {
    const compact = String(value).replace(/\s+/g, '')
    if (!compact || compact.length % 2 || /[^0-9a-f]/i.test(compact))
      throw new Error(name + ' 必须是非空、完整字节的十六进制文本')
    return Buffer.from(compact, 'hex')
  }
  const needle = cfg.mode === 'hex' ? hex(cfg.match, '匹配内容') : null
  const reply = cfg.mode === 'hex'
    ? [...hex(cfg.response, '回复内容')]
    : String(cfg.response) + (endings[cfg.newline] || '')

  async function sleep(ms) {
    if (!ms || closed) return
    await new Promise(resolve => {
      const entry = { timer: null, resolve }
      entry.timer = setTimeout(() => { sleepers.delete(entry); resolve() }, ms)
      sleepers.add(entry)
    })
  }
  async function sendReply() {
    if (closed) return
    await sleep(cfg.replyDelayMs || 0)
    if (closed) return
    await ctx.serial.write(reply)
    replies++
    ctx.state({ replies })
  }
  function trimTextBuffer() {
    if (Buffer.byteLength(textBuffer, 'utf8') > maxBytes) {
      textBuffer = ''
      ctx.log('warn', '未形成完整行的数据超过缓存上限，已清空')
    }
  }

  return {
    async run(actionId) {
      if (closed) return { ok: false, error: '插件已停止' }
      if (actionId === 'reset') {
        textBuffer = ''
        bytesBuffer = Buffer.alloc(0)
        return { ok: true }
      }
      if (actionId !== 'send') return { ok: false, error: '未知动作：' + actionId }
      await sendReply()
      return { ok: true }
    },
    async onData(event) {
      if (closed) return
      let count = 0
      if (cfg.mode === 'hex') {
        bytesBuffer = Buffer.concat([bytesBuffer, Buffer.from(event.bytes)])
        if (bytesBuffer.length > maxBytes) {
          bytesBuffer = bytesBuffer.subarray(-maxBytes)
          ctx.log('warn', '接收缓存超限，保留最新字节')
        }
        let at
        while (!closed && (at = bytesBuffer.indexOf(needle)) !== -1) {
          bytesBuffer = bytesBuffer.subarray(at + needle.length)
          if (++count > 32) {
            bytesBuffer = Buffer.alloc(0)
            throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
          }
          await sendReply()
        }
        // Keep the suffix which could be the beginning of a split match.
        bytesBuffer = bytesBuffer.subarray(-Math.max(needle.length - 1, 0))
        if (needle.length === 1) bytesBuffer = Buffer.alloc(0)
        return
      }
      textBuffer += event.text || ''
      const lines = textBuffer.split(/\r\n|\r|\n/)
      textBuffer = lines.pop() || ''
      trimTextBuffer()
      const wanted = cfg.ignoreCase ? String(cfg.match).toLowerCase() : String(cfg.match)
      for (const line of lines) {
        if (closed) return
        const actual = cfg.ignoreCase ? line.toLowerCase() : line
        if (actual !== wanted) continue
        if (++count > 32) throw new Error('单次接收命中超过 32 次，停止自动应答以避免回复洪泛')
        await sendReply()
      }
    },
    async dispose() {
      closed = true
      textBuffer = ''
      bytesBuffer = Buffer.alloc(0)
      for (const entry of sleepers) { clearTimeout(entry.timer); entry.resolve() }
      sleepers.clear()
    }
  }
}
