# DevKit 嵌入式开发套件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![平台](https://img.shields.io/badge/platform-Windows-blue) ![技术栈](https://img.shields.io/badge/Electron%20%2B%20Vue3%20%2B%20TS-44.x-green)

面向嵌入式软件开发的集成工具箱：一个程序，面板化集成日常零散小工具，重点是**键鼠操作录制回放**，把重复的界面操作自动化。

English summary: DevKit is an all-in-one toolbox for embedded developers (Windows only, Electron + Vue 3 + TypeScript). It integrates a programmer's calculator, TFTP server, serial/SSH terminals, network debugging, diff tools and more — plus a distinctive **mouse & keyboard macro recorder** to automate repetitive UI operations.

> 截图待补：主界面 / 键鼠宏回放 / 串口终端（欢迎在 PR 中补充）

## 工具一览

| 工具 | 说明 |
|---|---|
| **键鼠宏** | 全局录制 / 回放 / 事件编辑 / 宏库 / 全局热键 / 等待颜色 / 截屏取点 |
| 串口助手 | xterm 终端仿真（ANSI 彩色 / VT100 / 直接键入）、会话管理、快捷命令录制/编辑/分组、YMODEM/ZMODEM 文件收发、定时发送、DTR/RTS、自动日志 |
| **SSH 终端** | xterm 终端 + ssh2：密码 / 私钥认证、会话管理、终端尺寸同步（vim/top 正常）、自动日志 |
| TFTP 服务器 | RFC1350 + blksize/timeout/tsize 扩展，多实例，传输记录 |
| 程序员计算器 | 表达式求值、进制同步转换、64 位 bit 编辑器、字节序布局 |
| 网络调试助手 | TCP Server（多客户端） / TCP Client / UDP，ASCII/HEX、定时发送 |
| 文本对比 | 文本 / 文件夹 / 十六进制对比（jsdiff 引擎）、多编码、文件夹同步与过滤 |
| 时间戳转换 | s/ms/µs/ns/0xHEX/日期文本自动识别互转 |
| 编码转换 | UTF-8 / GBK / UTF-16BE / Unicode 转义 / Base64 / URL |
| 大小端转换 | 字节序列 u16/u32/u64 LE/BE 解释、16/32/64 位字节交换 |
| 取色器 | 截屏取点取色，HEX/RGB 复制 |
| 键鼠输入测试 | 全局键鼠捕获 / 注入自检（SendInput + uiohook），仅开发模式显示 |

窗口为 VS Code 风格无边框：标题栏可拖拽，左上角图标点击显示版本信息（Electron / Chromium / Node 版本）。

## 快速开始

### 从源码运行

```bash
npm install
npm run dev
```

> npm 11 不再从 .npmrc 读取 `electron_mirror`，若 Electron 二进制下载失败（国内网络），执行：
>
> ```bash
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
> ```

### 打包（portable 单文件 + 免安装目录）

```bash
npm run dist:dir   # 目录版 → release/win-unpacked/DevKit.exe
npm run dist       # portable 单文件 → release/DevKit-<版本>-portable.exe
```

国内网络可用镜像拉取打包器二进制：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run dist
```

无代码签名证书，首次运行会有 SmartScreen 提示，点「更多信息 → 仍要运行」即可。

原生模块（serialport / uiohook-napi / koffi）均为 N-API 预编译产物，免 node-gyp、免重建；打包配置已设 `npmRebuild: false`。

## 键鼠宏使用要点

- 全局热键：`F9` 开始/停止录制，`F10` 回放当前宏，`F11` 急停（可在「设置」中改，冲突会提示）。
- 录制默认屏蔽本程序自身热键，不会把 F9/F10 录进宏；鼠标移动默认不录。
- 录完的宏载入编辑器：可改延时、启停任意步骤、按段启停、插入**延时 / 文本 / 等待颜色**步骤。
- **等待颜色**步骤：在指定物理像素坐标等待某颜色出现/消失（容差可配），用于同步异步界面（如等烧录完成标志变色），超时自动判失败终止回放。
- 「截屏取点」帮助选定坐标和颜色。多显示器 / DPI 缩放已按物理像素统一处理。
- 宏以人类可读 JSON 存于 `%APPDATA%/dev-kit/macros/`，可进 git、可导入导出；每个宏可绑定独立全局热键。
- 回放支持 0.1~10 倍速与循环（0 = 无限），急停保证已按下按键统一抬起，避免按键卡死。
- ⚠️ 宏文件包含键盘输入内容，**勿在录制中输入密码**。

## 串口助手要点

- 终端基于 xterm.js（与 VS Code 终端同内核）：ANSI 颜色与 VT100 光标控制完整解析。**使用 WebGL 渲染器**，刷屏高吞吐日志时不卡顿（GPU 不可用时自动回退 DOM 渲染）。
- **复制粘贴**：选中文本后**左键点击**自动复制；终端内**右键**直接粘贴（不弹菜单）。
- **终端搜索**：`Ctrl+F` 打开搜索条，所有命中高亮，`Enter` / `Shift+Enter` 上/下一个，Esc 关闭。串口 / SSH 共用。
- **终端直接键入**：打开串口后在终端区直接敲命令；设备不回显的裸模块勾选「本地回显」。**终端控制键已适配**：`Ctrl+C` 中断、`Ctrl+Z` 挂起、`Ctrl+D` EOF、`Ctrl+\` 退出、`Ctrl+U` 删行、`Ctrl+L` 清屏等，即使焦点不在终端上也会发给设备。
- 字体 / 字号可选，`Ctrl+滚轮` / `Ctrl+=` / `Ctrl+-` 缩放，`Ctrl+0` 复位；设置持久化。
- 波特率下拉可手输 1200 ~ 12M；数据位/校验/停止位/RTS-CTS 流控可配。接收为批量合并推送，高波特率不卡 UI。
- **自动保存日志**：会话期间所有收发自动落盘 `%APPDATA%/dev-kit/serial-logs/<COM>-<日期>.log`（带毫秒时间戳与 RX/TX 方向标记），可开关。
- DTR/RTS 一键拉高拉低（部分板子进 Bootloader 用），CTS/DSR/DCD 信号灯 2s 轮询。
- 会话（端口参数组合）保存后一键载入；发送历史下拉；定时发送（周期 ≥20ms）。
- **快捷命令（宏式多步骤，串口 / SSH 全局共享）**：每条宏由步骤序列组成——**命令**（ASCII/HEX）、**延时等待**、**按键**，按顺序回放；支持分组、拖拽排序、复制、终端内无弹窗录制。
- **导入 / 导出配置**：导出为 DevKit JSON；导入自动识别 DevKit JSON 或 **MobaXterm 宏文件**（`.mxtmacros` / `.ini`，GBK 编码），同名覆盖、其余追加。
- **文件收发（YMODEM / ZMODEM）**：设备端运行 `ry`/`rz`（收）或 `sy`/`sz`（发）即可互传文件，进度条实时显示、可中途取消，重名自动加后缀。

## SSH 终端要点

- 与串口助手共用同一终端组件：ANSI 彩色、终端直接键入、复制粘贴、搜索、缩放、本地回显。
- 认证方式：密码 / 私钥文件（OpenSSH pem 等）；兼容 keyboard-interactive 认证；15s 连接超时。
- 终端尺寸变化自动同步远端 pty，`vim` / `top` 等全屏程序布局正确。
- **自动日志**：`%APPDATA%/dev-kit/ssh-logs/<主机>-<端口>-<日期>.log`。
- ⚠️ 密码以明文保存在本机 config.json，请勿保存生产环境密码。
- ⚠️ 远端主机防火墙需放行 SSH 端口（默认 22）入站。

## 配置与数据位置

- 全局配置：`%APPDATA%/dev-kit/config.json`（工具参数、会话、终端字体；快捷命令宏在独立 `quickCmds` 节）
- 宏库：`%APPDATA%/dev-kit/macros/*.json`
- 串口自动日志：`%APPDATA%/dev-kit/serial-logs/`
- SSH 自动日志：`%APPDATA%/dev-kit/ssh-logs/`
- TFTP 默认根目录：`文档/DevKit-TFTP/`

设备连不上 TFTP 时放行防火墙（管理员）：

```
netsh advfirewall firewall add rule name="DevKit-TFTP" dir=in action=allow protocol=UDP localport=69
```

## 项目结构

```
src/
├── main/                 # 主进程
│   ├── ipc.ts            # 通用 tool:invoke / tool:event 通道
│   └── services/
│       ├── codec/        # 编码转换（UTF-8/GBK/UTF-16/Base64/URL）
│       ├── color/        # 截屏取点
│       ├── diff/         # 文本/十六进制/文件夹对比引擎 + 多编码 IO
│       ├── input/        # SendInput 注入 + uiohook 捕获 + 键码映射
│       ├── macro/        # 录制 / 回放 / 热键 / 宏库 / 等待颜色 / HUD / 取点 / 配置存取
│       ├── net/           # TCP/UDP 主机（纯 Node 可独立测试）
│       ├── quickcmds/    # 终端快捷命令宏（串口/SSH 共享，导入导出）
│       ├── serial/       # 串口会话（批量推送）+ YMODEM/ZMODEM 文件传输
│       ├── ssh/          # SSH 终端会话（ssh2）
│       └── tftp/         # TFTP 服务器（RFC1350 + 2347/2348/2349）
├── preload/              # contextBridge 暴露 window.api
├── renderer/
│   └── src/
│       ├── components/   # 共享组件（TerminalView 终端、QuickCmdManager：串口/SSH 复用）
│       ├── composables/  # useTermMacros（全局共享宏库与录制状态）
│       ├── panels/       # 各工具面板（Vue3 + Element Plus 暗色）
│       ├── tools/        # registry.ts 工具注册表
│       └── stores/       # 标签页状态
├── shared/               # 主/渲染共享类型与纯逻辑（测试与渲染端共用）
scripts/                   # 单元测试与探针脚本
docs/spec.md               # 需求文档（设计目标与决策记录）
```

## 开发与测试

```bash
npm run typecheck   # node + web 两套类型检查
npm test            # 全部单测（终端交互判定 / diff / 计算器 / MobaXterm 宏解析 / TCP-UDP / TFTP / YMODEM / ZMODEM）
```

协议与原生能力探针（可选，验证环境用）：

```bash
node scripts/net-test.js       # 网络主机回环测试（17 项）
node scripts/tftp-test.js      # TFTP 协议测试（8 项）
node scripts/ymodem-test.js    # YMODEM 协议回环测试（11 项）
node scripts/zmodem-test.js    # ZMODEM 包装层回环测试（11 项）
npx electron scripts/probe-serial.js   # serialport 在 Electron 中加载探针
npx electron scripts/probe-color.js    # desktopCapturer 像素读取探针
```

## 贡献

欢迎 issue / PR。改动请保证 `npm run typecheck` 与 `npm test` 通过；涉及 UI 交互的改动请附操作说明或截图。

## License

[MIT](LICENSE) © 2026 smallfishworld
