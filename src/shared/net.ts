/** 网络调试助手共享类型 */

export type NetMode = 'tcp-server' | 'tcp-client' | 'udp'

export interface NetParams {
  mode: NetMode
  /** TCP Client 目标地址 / UDP 发送目标地址 */
  host: string
  /** TCP Client 目标端口 / UDP 发送目标端口 */
  port: number
  /** TCP Server 监听端口 / UDP 本地绑定端口 */
  localPort: number
}

export const DEFAULT_NET_PARAMS: NetParams = {
  mode: 'tcp-server',
  host: '192.168.1.100',
  port: 8080,
  localPort: 8080
}

/** 网络助手配置持久化结构（config.json 的 net 键） */
export interface NetConfig {
  last: NetParams
  displayHex: boolean
  showTimestamp: boolean
}

export const DEFAULT_NET_CONFIG: NetConfig = {
  last: DEFAULT_NET_PARAMS,
  displayHex: false,
  showTimestamp: false
}
