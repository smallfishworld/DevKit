/** SSH 终端共享类型与默认值 */

export type SshAuthType = 'password' | 'key'

export interface SshParams {
  host: string
  port: number
  username: string
  authType: SshAuthType
  password: string
  /** 私钥文件路径（authType = key 时使用） */
  privateKeyPath: string
}

export const DEFAULT_SSH_PARAMS: SshParams = {
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: ''
}

/** 保存的会话（可快速载入参数重连） */
export interface SshSessionInfo {
  name: string
  params: SshParams
}

/** SSH 配置持久化结构（config.json 的 ssh 键） */
export interface SshConfig {
  last: SshParams
  sessions: SshSessionInfo[]
  /** 终端字体族 */
  termFont: string
  /** 终端字号 */
  termFontSize: number
  /** 手动「存日志」的保存目录（重启记忆；空则用默认自动日志目录） */
  logDir: string
  /** 自动日志开关（连接期间收发自动落盘；默认开启） */
  autoLog: boolean
  /** 左侧会话栏宽度（拖动分隔条调整，重启记忆） */
  sidebarWidth: number
}

export const DEFAULT_SSH_CONFIG: SshConfig = {
  last: DEFAULT_SSH_PARAMS,
  sessions: [],
  termFont: 'Consolas',
  termFontSize: 13,
  logDir: '',
  autoLog: true,
  sidebarWidth: 210
}
