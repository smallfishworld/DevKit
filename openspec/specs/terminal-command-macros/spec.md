# Terminal command macros

## Purpose

串口和 SSH 共用的终端快捷命令宏系统，记录命令、键序列与间隔并复用。 其目标是让同一套自动化命令能够跨不同终端稳定执行，并允许用户在界面中维护和迁移这些步骤。

## Requirements

### Requirement: 共享命令宏

串口与 SSH 终端 MUST 使用同一份快捷命令宏库及录制状态。

#### Scenario: 跨终端复用

- **WHEN** 用户在串口录制一个命令宏后打开 SSH
- **THEN** 能在 SSH 中看到并按顺序执行同一个宏。

### Requirement: 多步骤回放

命令宏 MUST 支持文本/HEX 命令、可选换行、特殊按键和延时步骤。

#### Scenario: 组合命令

- **WHEN** 用户编辑一个包含发送命令、等待和按键的宏
- **THEN** 运行时按照定义顺序执行。

### Requirement: 可见且可维护

宏列表 MUST 支持分组、步骤预览、拖拽排序和编辑，不应依赖额外脚本才能维护。

#### Scenario: 调整顺序

- **WHEN** 用户拖动一条命令到另一条上方或下方
- **THEN** 顺序与分组按界面指示更新。

### Requirement: 兼容导入

宏导入 MUST 支持 DevKit JSON 与已适配的 MobaXterm 宏格式，并对不兼容内容给出明确处理结果。

#### Scenario: 迁移 MobaXterm 宏

- **WHEN** 用户选择受支持的 .mxtmacros 文件
- **THEN** 可识别的命令和延时转换为 DevKit 步骤。

### Requirement: 插件动作步骤
快捷命令 SHALL 支持引用插件配置实例 ID 与插件动作 ID。
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
