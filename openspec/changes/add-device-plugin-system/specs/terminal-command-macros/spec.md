## ADDED Requirements

### Requirement: 插件动作步骤
快捷命令 SHALL 支持引用配置实例 ID 与插件动作 ID，同时保持既有 device-action 步骤兼容。
#### Scenario: 插件动作成功后继续
- WHEN 宏运行到有效插件动作步骤
- THEN 等待该动作完成后才执行下一步骤。
#### Scenario: 缺失、禁用或跨会话引用
- WHEN 插件缺失、配置禁用或实例已绑定另一串口
- THEN 执行前明确提示原因并停止，不静默跳过或夺取其他会话。
#### Scenario: 动作失败或连接变化
- WHEN 插件动作失败、取消或执行期间串口连接代际改变
- THEN 不再发送宏后续步骤。
#### Scenario: 导入外部宏
- WHEN 导入包含插件动作的宏
- THEN 只保留稳定动作引用，不导入嵌入代码、凭证或额外配置。
