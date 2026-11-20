'use strict'
exports.activate = async function activate(ctx) {
  return {
    async run(actionId) {
      if (actionId !== 'query') return { ok: false, error: '未知动作' }
      const command = String(ctx.config.command).replace(/\\r/g, '\r').replace(/\\n/g, '\n')
      const result = await ctx.stream.exchange(command, {
        match: String(ctx.config.expected),
        timeoutMs: Number(ctx.config.timeoutMs)
      })
      ctx.log('info', '收到响应，共 ' + result.bytes.length + ' 字节')
      return { ok: true, response: result.text }
    },
    async dispose() {}
  }
}
