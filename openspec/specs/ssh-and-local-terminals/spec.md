# SSH and local terminals

## Purpose

描述 SSH 及本地 PTY 终端的连接、终端仿真、磁盘历史、输入和流控。

### Requirement: SSH 连接

SSH 面板 MUST 支持主机、端口、用户凭据以及受支持的密码和私钥认证。

#### Scenario: 建立连接

- **WHEN** 用户输入正确的 SSH 认证参数
- **THEN** 终端连接后能够交互发送和接收文本。

### Requirement: 标准终端语义

SSH 和本地终端 MUST 提供 VT/ANSI 控制、彩色回滚、复制/粘贴、搜索、字体和窗口尺寸同步。

#### Scenario: 全屏命令

- **WHEN** 用户在 SSH 中运行 vim 或 top 并调整面板大小
- **THEN** 终端尺寸变化传送给远端 PTY，布局能够响应。

### Requirement: 磁盘日志

SSH 和本地终端 MUST 为会话提供可查询及导出的磁盘历史，并限制分页查询大小。

#### Scenario: 查找以前输出

- **WHEN** 会话积累大量打印后用户搜索关键词
- **THEN** 可以按页读取命中结果，无需全量读到渲染内存。

### Requirement: 输出与关闭安全

终端输出 MUST 依 ACK 追踪已显示帧、限制积压；断开或销毁面板 MUST 释放会话资源。

#### Scenario: 网络断开

- **WHEN** 正在输出的 SSH 会话异常关闭
- **THEN** 停止传输、释放资源并保留应保留的已写入日志。

### Requirement: 认证信息风险

持久化 SSH 凭据时 MUST 让用户知道保存敏感信息的风险。

#### Scenario: 保存密码

- **WHEN** 用户选择保存 SSH 会话及密码
- **THEN** 界面明确提示密码可能以明文留在本地配置。
