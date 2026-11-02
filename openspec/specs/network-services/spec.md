# Network services and transfers

## Purpose

覆盖 TFTP、TCP/UDP 网络调试和多串口 TCP 桥接等独立网络服务。 这些服务在并发、配置冲突、远程控制、协议兼容和会话日志方面应表现出清晰可验证的结果。

## Requirements

### Requirement: TFTP 服务

TFTP 工具 MUST 支持 RFC 1350 读写请求、二进制模式和既有 blksize/timeout/tsize 扩展。

#### Scenario: 设备获取固件

- **WHEN** 嵌入式设备向选定 TFTP 服务目录发起 RRQ
- **THEN** 服务端按所选目录和协议选项传输文件并记录结果。

### Requirement: TFTP 实例与并发

TFTP 工具 MUST 支持配置监听地址、端口、根目录及多个独立传输会话。

#### Scenario: 并发传输

- **WHEN** 两个客户端并行读写文件
- **THEN** 各传输独立处理，错误不会使其他会话无故中断。

### Requirement: TCP/UDP 调试

网络助手 MUST 支持 TCP Server、TCP Client、UDP 数据收发及 ASCII/HEX 查看。

#### Scenario: 网络报文调试

- **WHEN** 用户建立 TCP 连接或 UDP 监听并发送字节
- **THEN** 界面显示收发结果、连接状态和日志。

### Requirement: 串口到 TCP 桥接

桥接器 MUST 支持最多八路独立串口与 TCP 端口的双向透传，并拒绝冲突占用。

#### Scenario: 远程连接设备

- **WHEN** 用户启用一条串口桥接通道并让 TCP 客户端连接
- **THEN** 串口设备与客户端按配置交换数据，重复端口不能同时占用。

### Requirement: Telnet 兼容

桥接 TCP 输入 MUST 正确识别已支持的 Telnet IAC 协商和转义，避免把协议控制字节无条件转发至串口。

#### Scenario: 网络终端连接

- **WHEN** 使用 Telnet 客户端向桥接通道发送协商序列
- **THEN** 协商字节按桥接设置处理，真实负载才进入串口。

### Requirement: 远程通道管理

桥接 MUST 支持受支持的 JSON 行协议远程管理命令与状态广播，并按身份隔离配置。

#### Scenario: 远程运维

- **WHEN** 管理客户端建立连接并查询通道状态
- **THEN** 得到通道列表并能执行其权限范围内的启停操作。

### Requirement: 可追溯记录

网络和桥接工具 MUST 记录连接、传输及错误事件，并提供对应的本地日志。

#### Scenario: 传输失败

- **WHEN** 网络连接或文件传输出错
- **THEN** 用户能够在界面或日志中定位发生时间与结果。
