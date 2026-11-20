## ADDED Requirements

### Requirement: 默认官方扩展源

扩展源管理 MUST 预置 DevKit-Plugins 的官方安装索引并默认启用。用户可停用该源，停用状态在重启后保留。已添加相同地址的配置 MUST 合并到预置源并保留原有启用状态。

#### Scenario: 首次刷新官方源

- **WHEN** 用户首次打开扩展源管理并刷新预置官方源
- **THEN** 工作台从固定的 HTTPS 安装索引展示正式发布的插件，使用原有校验和安装流程。
