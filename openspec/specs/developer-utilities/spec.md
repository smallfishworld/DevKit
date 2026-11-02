# Developer utilities

## Purpose

提供常用嵌入式工程工具，包含计算、编码、大小端、文本/文件比较、时间戳和取色。

### Requirement: 程序员计算器

计算器 MUST 支持 HEX/DEC/OCT/BIN 多进制、8/16/32/64 位宽与位运算，并提供可点击的位编辑视图。

#### Scenario: 位操作

- **WHEN** 用户切换位宽并点击某个位
- **THEN** 数字和各进制显示同步更新。

### Requirement: 编码及大小端转换

转换工具 MUST 支持既定文本编码、Base64/URL 与多字节大小端解释，并保留输入供用户复制。

#### Scenario: 查看数据

- **WHEN** 用户输入一段 UTF-8/GBK 文本或十六进制字节序列
- **THEN** 可获得对应编码或 LE/BE 解释结果。

### Requirement: 时间戳转换

时间戳工具 MUST 识别秒、毫秒、微秒、纳秒及常见十六进制时间输入。

#### Scenario: 解析时间戳

- **WHEN** 用户粘贴毫秒级 Unix 时间戳
- **THEN** 显示对应可读日期时间及其他单位。

### Requirement: 比较工具

Diff 工具 MUST 支持文本、十六进制和文件夹比较，并在结果过大时限制渲染。

#### Scenario: 大型差异

- **WHEN** 用户比较较大文件并超过界面安全展示阈值
- **THEN** 界面给出截断或受限展示提示而非无限渲染。

### Requirement: 取色与坐标

取色器 MUST 支持屏幕像素取色和坐标拾取，并允许复制结果。

#### Scenario: 采样屏幕

- **WHEN** 用户通过截屏点选像素
- **THEN** 显示并可复制颜色值或位置。
