/** 取色器服务：复用宏的截屏取点器 */
import type { ToolService } from '../../ipc'
import { pickPoint } from '../macro/picker'

class ColorService implements ToolService {
  invoke(_panelId: string, action: string): unknown {
    switch (action) {
      case 'pick':
        return pickPoint()
      default:
        throw new Error(`color 服务未知操作: ${action}`)
    }
  }
}

export const colorService = new ColorService()
