/** 编码转换服务：GBK 编解码（iconv-lite 需 Node Buffer，置于主进程） */
import * as iconv from 'iconv-lite'
import type { ToolService } from '../../ipc'

class CodecService implements ToolService {
  invoke(_panelId: string, action: string, payload: unknown): unknown {
    switch (action) {
      case 'gbk:encode': {
        const { text } = payload as { text: string }
        const bytes = iconv.encode(text, 'gbk')
        return {
          hex: [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
          bytes: bytes.length
        }
      }
      case 'gbk:decode': {
        const { hex } = payload as { hex: string }
        const compact = hex.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '')
        if (compact.length % 2 !== 0) return { ok: false }
        const buf = Buffer.from(compact, 'hex')
        return { ok: true, text: iconv.decode(buf, 'gbk') }
      }
      default:
        throw new Error(`codec 服务未知操作: ${action}`)
    }
  }
}

export const codecService = new CodecService()
