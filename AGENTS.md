# AGENTS.md — DevKit 开发工作流（AI 协作守则）

> 本文件供 AI 助手（Claude Code 等）与后续开发者复用。每次修改代码必须遵守本文流程。

## 项目概览

- **DevKit**：Electron 44 + electron-vite 5 + Vue 3.5 + TS 5.9 + Element Plus 2.14（暗色）+ Pinia 的嵌入式开发工具箱，Windows only。
- 目录：`src/main`（主进程服务）、`src/preload`、`src/renderer`（面板 UI）、`src/shared`（主/渲染共享类型与纯逻辑）、`tests/`（单元测试）、`tests/probes/`（原生能力探针，不在 npm test 内）。

## 架构铁律

1. **IPC 统一走 `window.api.invoke(tool, action, panelId, payload)`** → preload `ipcRenderer.invoke('tool:invoke')` → 主进程 `services.get(tool).invoke()`。新增工具 = 注册表 `registry.ts` + `ToolService` 实现，不自开 IPC 通道。
2. **`externalizeDepsPlugin()` 外置了 main/preload 依赖** → 运行时用到的包必须放 `dependencies`（不是 devDependencies）。
3. **`invoke()` 是同步 switch**（返回 `Promise<unknown> | unknown`）→ case 里不能直接 `await`，需转到 `private async xxx()` 方法。
4. **共享纯逻辑放 `src/shared/` 或组件旁 `*.ts` 纯函数模块** → 渲染组件与 `tests/` 测试共用同一份代码（见 `components/termInput.ts` 模式）。
5. **Electron 44 无 `File.path`** → 拖放路径必须经 preload `webUtils.getPathForFile`（`window.api.dragPath`）。
6. xterm.js 关键机制：
   - 复制监听必须挂在 termBox **捕获阶段**（先于 xterm 清选区）。
   - addon-search 打开时每批输出会**自动重选命中项**（`_updateMatches`，200ms 延时）→ 手动选区会被顶掉；故查找模式下点击终端一律先退出查找。
   - 渲染用 WebGL addon；窗口最小化丢 GPU 上下文需 visibilitychange 重建。

## 每次修改的强制流程

```
改代码
 → npm run typecheck        # node + web 两套都必须过
 → npm test                 # 全部单测必须绿（任何修改都跑，不许跳过）
 → 手工冒烟（npm run dev）：改动涉及 UI 交互时必须实际操作验证
 → 用户确认后打包（见下）
```

**测试要求**：新增/修改可判定的交互逻辑时，先抽成纯函数模块（参照 `termInput.ts`），并在 `tests/` 加对应 `*-entry.js` + `*-test.js`（esbuild 打包后 node 跑，参照 `term-test.js`），再挂进 `package.json` 的 `test` 链。

## 测试套件清单（`npm test` 依次执行）

| 脚本 | 覆盖 |
|---|---|
| `tests/term-test.js` | 终端鼠标复制粘贴 / Ctrl+C/V / 查找模式退出判定（termInput.ts） |
| `tests/diff-test.js` | 文本/十六进制/文件夹 diff 引擎 + io 多编码 |
| `tests/logic-test.js` | hexutil + 程序员计算器 |
| `tests/mobamacro-test.js` | MobaXterm 宏导入解析 |
| `tests/net-test.js` | 网络助手 TCP/UDP 回环 |
| `tests/tftp-test.js` / `tests/ymodem-test.js` / `tests/zmodem-test.js` | 传输协议 |

## 打包流程

```bash
# 0. 确认 DevKit.exe 未运行（tasklist | grep -i devkit），运行中先请用户关闭
npm run dist:dir    # 目录版（win-unpacked）
npm run dist        # portable 单文件版
# 产物在 release/：DevKit-<版本>-portable.exe 与 win-unpacked/DevKit.exe
```

## 网络环境备注

国内网络环境可用 npmmirror 镜像加速依赖下载。npm 11 忽略 `.npmrc` 的 Electron 镜像键 → 必须用环境变量：
```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 行为守则

- 不经用户确认不 commit / 不 push。
- 不杀用户进程（如运行中的 DevKit.exe），先请用户关闭。
- `rm -rf` 前先确认路径与产物状态。
- 编辑前先读文件确认真实字节，禁止凭记忆写 `old_string`（历史教训：多次 Edit 失配、产生残码）。
- `shallowRef` 用于大数组 diff 结果；>8000 行截断提示；防深响应代理卡死。
