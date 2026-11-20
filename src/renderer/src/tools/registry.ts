import { defineAsyncComponent, markRaw } from 'vue'
import type { Component } from 'vue'

/** 工具定义：渲染端注册表，主进程侧服务以同 id 注册 */
export interface ToolDef {
  id: string
  name: string
  /** Element Plus 图标组件名（已在 main.ts 全局注册） */
  icon: string
  description: string
  /** 面板组件；未开发的工具为 null */
  component: Component | null
  /** true = 同时只开一个实例 */
  singleton: boolean
  /** 所属里程碑（展示用） */
  phase: string
  ready: boolean
  /** true = 仅开发模式显示（正式版隐藏） */
  devOnly?: boolean
  /** 限定运行的操作系统平台；缺省表示跨平台可用 */
  platforms?: string[]
}

const lazy = (loader: () => Promise<Component>): Component => markRaw(defineAsyncComponent(loader))

const ALL_TOOLS: ToolDef[] = [
  {
    id: 'input',
    name: '键鼠输入测试',
    icon: 'Pointer',
    description: '全局键鼠捕获与注入验证（M1 去风险演示）',
    component: lazy(() => import('@renderer/panels/InputTestPanel.vue')),
    singleton: true,
    phase: 'M1',
    ready: true,
    devOnly: true,
    platforms: ['win32']
  },
  {
    id: 'calc',
    name: '程序员计算器',
    icon: 'Cpu',
    description: '进制同步转换 / 位运算 / 64 位 bit 编辑器',
    component: lazy(() => import('@renderer/panels/CalculatorPanel.vue')),
    singleton: true,
    phase: 'M2',
    ready: true
  },
  {
    id: 'tftp',
    name: 'TFTP 服务器',
    icon: 'Upload',
    description: '固件传输：RFC1350 + blksize/tsize 扩展，多实例',
    component: lazy(() => import('@renderer/panels/TftpPanel.vue')),
    singleton: false,
    phase: 'M2',
    ready: true
  },
  {
    id: 'macro',
    name: '键鼠宏',
    icon: 'VideoPlay',
    description: '录制 / 事件编辑 / 回放 / 宏库 / 等待颜色',
    component: lazy(() => import('@renderer/panels/MacroPanel.vue')),
    singleton: true,
    phase: 'M3',
    ready: true,
    platforms: ['win32']
  },
  {
    id: 'serial',
    name: '串口助手',
    icon: 'Connection',
    description: '串口调试：参数预设 / 终端视图 / HEX 收发 / 文件传输',
    component: lazy(() => import('@renderer/panels/SerialPanel.vue')),
    singleton: false,
    phase: 'M4',
    ready: true
  },
  {
    id: 'ssh',
    name: 'SSH 终端',
    icon: 'Lock',
    description: 'xterm 终端 + ssh2：密码 / 私钥认证，参数预设，自动日志',
    component: lazy(() => import('@renderer/panels/SshPanel.vue')),
    singleton: false,
    phase: 'M4',
    ready: true
  },
  {
    id: 'local-terminal',
    name: '本地终端',
    icon: 'Monitor',
    description: '本地 Shell 多实例 PTY 终端',
    component: lazy(() => import('@renderer/panels/LocalTerminalPanel.vue')),
    singleton: false,
    phase: 'M4',
    ready: true
  },
  {
    id: 'net',
    name: '网络调试助手',
    icon: 'Link',
    description: 'TCP Server / TCP Client / UDP 调试',
    component: lazy(() => import('@renderer/panels/NetPanel.vue')),
    singleton: true,
    phase: 'M4',
    ready: true
  },
  {
    id: 'timestamp',
    name: '时间戳转换',
    icon: 'Timer',
    description: 'Unix 时间戳 ↔ 日期互转（s/ms/µs/ns/HEX 自动识别）',
    component: lazy(() => import('@renderer/panels/TimestampPanel.vue')),
    singleton: true,
    phase: 'M5',
    ready: true
  },
  {
    id: 'encoding',
    name: '编码转换',
    icon: 'MagicStick',
    description: 'UTF-8 / GBK / UTF-16 / Base64 / URL 互转',
    component: lazy(() => import('@renderer/panels/EncodingPanel.vue')),
    singleton: true,
    phase: 'M5',
    ready: true
  },
  {
    id: 'endian',
    name: '大小端转换',
    icon: 'Sort',
    description: '字节序列 LE/BE 多宽度解释与字节交换',
    component: lazy(() => import('@renderer/panels/EndianPanel.vue')),
    singleton: true,
    phase: 'M5',
    ready: true
  },
  {
    id: 'diff',
    name: '文本对比',
    icon: 'DocumentCopy',
    description: '文件 / 文件夹 / 十六进制对比，多编码，文件夹同步',
    component: lazy(() => import('@renderer/panels/DiffPanel.vue')),
    singleton: true,
    phase: 'M5',
    ready: true
  },
  {
    id: 'color',
    name: '取色器',
    icon: 'View',
    description: '截屏取色 / 坐标拾取',
    component: lazy(() => import('@renderer/panels/ColorPanel.vue')),
    singleton: true,
    phase: 'M5',
    ready: true,
    platforms: ['win32']
  },
  {
    id: 'bridge',
    name: '串口TCP桥接',
    icon: 'Switch',
    description: '8 通道串口 ⇄ TCP 透传 + 远程管理',
    component: lazy(() => import('@renderer/panels/BridgePanel.vue')),
    singleton: false,
    phase: 'M6',
    ready: true
  }
]

const currentPlatform = typeof window !== 'undefined' && window.api?.platform ? window.api.platform : 'win32'

/** 正式版隐藏 devOnly 工具，同时按当前操作系统过滤平台专属工具 */
export const TOOLS: ToolDef[] = ALL_TOOLS.filter((t) => {
  if (!import.meta.env.DEV && t.devOnly) return false
  if (t.platforms && !t.platforms.includes(currentPlatform)) return false
  return true
})

export function toolById(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id)
}
