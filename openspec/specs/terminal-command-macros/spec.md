# Terminal command macros

## Purpose

串口和 SSH 共用的终端快捷命令宏系统，记录命令、键序列与间隔并复用。

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
