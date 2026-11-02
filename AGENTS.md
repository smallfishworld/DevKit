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

**同步 OpenSpec**：现行能力需求唯一来源是 `openspec/specs/<capability>/spec.md`。功能行为有变化时，按 OpenSpec propose → apply → sync → archive 工作流维护对应 spec 和验收场景；仅修复实现而不改变可见行为时无需改写既有要求，但应补测试。长期设计仅保留在 `docs/terminal-architecture.md` 等少量稳定文档；阶段性计划和 Review 不再逐篇堆入 `docs/`。

**测试要求**：新增/修改可判定的交互逻辑时，先抽成纯函数模块（参照 `termInput.ts`），并在 `tests/` 加对应 `*-entry.js` + `*-test.js`（esbuild 打包后 node 跑，参照 `term-test.js`），再挂进 `package.json` 的 `test` 链。

## OpenSpec 文档约定（新项目基线）

- `openspec/config.yaml`：统一项目背景与产物质量规则；`openspec/specs/`：已交付的现行行为，以 capability 划分，每个 Requirement 必须包含 `#### Scenario` 的 WHEN/THEN。
- 新需求使用 `openspec/changes/<change-name>/proposal.md`、`specs/<capability>/spec.md`（delta）、可选 `design.md`、`tasks.md`；完成后同步主 specs 并移入 `changes/archive/`。不要把已做完的设计计划作为新的 `docs/*.md` 反复创建。
- `docs/` 只保存仍需长期维护的技术设计或验证入口；代码 Review 结论优先放 PR 描述和 Git 历史，避免形成多份过时事实。
- 已将旧 `docs/spec.md` 按能力迁移为主 specs，已完成的串口缓存/历史类设计合并为单一架构文档。维护时先对照真实代码和测试，不能把 P1/P2 未来设想误写为已交付。
- OpenSpec 工作流技能（`openspec-propose`、`openspec-apply-change`、`openspec-archive-change`）由官方 CLI `openspec init` 为指定 AI 工具生成；**仅有目录并不代表已安装 CLI 或技能**。新开发环境按 https://openspec.dev/docs/setup 初始化/刷新。
- 现行 specs 是需求权威，技术细节/限制在 `docs/terminal-architecture.md`，用户操作指引在 `README.md`。有冲突先验证代码，再同步文档。

## 测试套件清单（`npm test` 依次执行）

| 脚本 | 覆盖 |
|---|---|
| `tests/term-test.js` | 终端鼠标复制粘贴 / Ctrl+C/V / 查找模式退出判定（termInput.ts） |
| `tests/termflow-test.js` | 终端显示队列水位与丢旧 / 裸 CR 洪泛提示（termFlow.ts） |
| `tests/vtguard-test.js` | 串口回滚保护：ED3 / RIS 中和、备用屏只识别不改写、跨批拼回、重开复位序列（vtguard.ts） |
| `tests/logtext-test.js` | 日志文本清洗（logtext.ts：剥 ANSI / 换行归一 / 跨批 ESC 切分 / 时间戳 / TX 审计行 / 裸 CR 判定） |
| `tests/diff-test.js` | 文本/十六进制/文件夹 diff 引擎 + io 多编码 |
| `tests/logic-test.js` | hexutil + 程序员计算器 |
| `tests/mobamacro-test.js` | MobaXterm 宏导入解析 |
| `tests/quickcmd-test.js` | 快捷命令拖放插入点判定（term-macro.ts 的 resolveDropInsertion） |
| `tests/net-test.js` | 网络助手 TCP/UDP 回环 |
| `tests/tftp-test.js` / `tests/ymodem-test.js` / `tests/zmodem-test.js` | 传输协议 |
| `tests/bridge-test.js` | 串口TCP桥接协议（bridge-protocol.ts：Telnet IAC 状态机 / JSON 行协议 / 身份派生） |
| `tests/theme-test.js` / `tests/local-terminal-test.js` | 终端主题 / 本地终端 shell profile |
| `tests/terminal-test.js` / `tests/terminal-services-test.js` | 终端流控（terminal-stream.ts：LogFormatter / OutputWindow ACK 背压）与磁盘历史（SessionHistory 积压背压 / 失败上报） |

## 打包与发布流程（走 GitHub CI，不在本机构建上传）

正式发布由 `.github/workflows/release-zip.yml` 完成：**发布 GitHub Release 即自动触发**，GitHub 的 Windows runner 上执行 `npm run dist`，并把 `DevKit-<版本>-portable.exe` 与 `DevKit-<版本>-win-x64.zip` 上传回该 Release（`--clobber` 覆盖），同时刷新发布说明里的下载表。

```bash
# 0. typecheck + npm test 全绿（push 后 ci.yml 会再自动验一遍：typecheck/test/build/pty 冒烟）
# 1. 升 package.json 的 version，提交并推送
# 2. 打 tag
git tag v<版本> && git push origin v<版本>
# 3. 发布 Release：只写说明、不带产物文件（gh release create 触发 release:published → 流水线）
gh release create v<版本> --title "DevKit v<版本>" --latest --notes-file <说明.md>
# 4. 盯流水线（v0.1.9 实测约 7 分钟）
gh run watch $(gh run list --workflow=release-zip.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- **不要 `gh release create` 时携带产物文件**：本机直传 GitHub 大文件易超时（v0.1.10 实测 104MB 上传 408，且上传失败会把整个 Release 回滚掉）；产物一律由 CI 挂载。
- 产物缺失/需重传时手工补跑：`gh workflow run release-zip.yml -f tag=v<版本> -f ref=<分支或tag>`（默认 ref 为 main）。
- 本地构建仅用于开发自测：`npm run dist:dir`（win-unpacked，产物在 `release/`）。运行前确认 DevKit.exe 未运行（`tasklist | grep -i devkit`），运行中先请用户关闭。

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
