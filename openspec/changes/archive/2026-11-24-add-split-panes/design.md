# 合并分屏设计

## 模型

分屏不是两栏布局，而是「合并标签」：两个面板并排塞进**同一个标签条目**。

```
tabs: WorkTab[]                  // 标签条条目（扁平）
WorkTab = TabItem | SplitTab
SplitTab = {
  id: 'split#N'
  kind: 'split'
  members: [TabItem, TabItem]    // 完整会话标签（panelId 不变，IPC 隔离天然成立）
}
```

- 标签条仅显示一个条目：标题 `A | B`（`splitTabTitle`）、每成员一枚连接状态点、单个 X（关闭 = 释放全部成员）。
- 成员标题保持短技术标识（串口=端口号、SSH=user@host、本地终端=profile 名），保证合并标题放得下；串口「备注名」功能随本变更移除（见 serial-terminal 增量）。
- 成员面板仍以各自 panelId 挂载，主进程与 preload 零改动。
- 关闭分屏标签 = 逐成员 dispose + 按身份记入最近会话；拆分 = 成员还原为独立标签（面板/连接保留）。

## 交互

1. **发起**：普通标签右键「合并分屏」或 `Ctrl+\` → 工具选择器进入分屏模式（锚点 = 发起标签）→ 选中已开会话直接并入，选中未开工具则新开实例后并入；取消选择则无任何变化。
2. **拆分**：分屏标签右键「拆分为独立标签」或 `Ctrl+Shift+\`。
3. **宽度**：两成员间 4px 分隔条拖拽（左成员 20–80%），持久化 `devkit:split-width:v1`。
4. **排序**：分屏标签整体拖拽移动，复用 reorderTabIds；home 恒在首位不可合并/移动。
5. **启动器**：会话条目来自 flatSessions（含分屏成员），排除「当前正在显示」的条目；分屏模式下排除锚点自身。

## 组件

- `split-tab.ts`（纯逻辑）：`splitTabTitle / memberTabIds / planMerge / reorderWorkTabIds`；配套 `tests/workbench-review-entry.js` 单测。
- `tabs.ts`：`WorkTab` 联合类型 + `mergeIntoSplit / unsplit`；`close / setConnection / rename / activate` 均按「宿主或成员」解析；getter `flatSessions / activeTitle / activeToolId / sessionById`。
- `TabBar.vue`：单实例渲染 `tabs.tabs`，分屏条目合并标题与多点、单 X；选择器经 `splitAnchorId` 进入分屏模式，`@closed` 复位。
- `ToolLauncher.vue`：`splitAnchorId` prop——选中即 `mergeIntoSplit`；普通模式行为不变。
- `App.vue`：`tab-page` 内按条目分支渲染，分屏条目为 `.split-view` grid + 分隔条（宽度记忆复用）。
- 主进程与 preload：零改动。
