# Tasks

- [x] 纯逻辑模块 `split-tab.ts`：合并标题、成员 ids、planMerge 位置计划、分屏整体重排；配套 `tests/workbench-review-entry.js` 单测。
- [x] `tabs.ts`：`WorkTab = TabItem | SplitTab` 联合模型；`mergeIntoSplit`（已有会话并入 / 新开工具并入 / 单例复用）、`unsplit`（拆分保留面板与连接）；`close/activate/setConnection/rename/moveTab/closeOthers/closeRight/closeAll` 按宿主或成员解析；getter `flatSessions/activeTitle/activeToolId/sessionById`。
- [x] `TabBar.vue`：单实例标签条渲染合并条目（合并标题 "A | B"、每成员状态点、单 X）；右键「合并分屏」「拆分为独立标签」；`Ctrl+\` / `Ctrl+Shift+\`；分屏标签整体拖拽。
- [x] `ToolLauncher.vue`：`splitAnchorId` 分屏模式（选中即并入，排除锚点自身），会话条目改源 `flatSessions` 并排除正在显示的条目，`@closed` 复位锚点。
- [x] `App.vue`：按条目分支渲染，分屏条目 `.split-view` grid + 分隔条拖宽（20–80% 持久化）；面板改用 `sessionById` 读取自身参数。
- [x] typecheck + 全量单测绿。
- [x] 移除串口标签备注功能（用户要求精简）：备注名输入框、`config.portLabels`、预设名回退标题、`portRemark/portTabTitle`；`serial-title.ts` 只留 `normalizePortPath`；标签标题回归纯端口号；分屏分隔线对比度提升（`--el-border-color`）；补 serial-terminal 变更增量。
- [x] `npm run dev` 手工冒烟：合并两个已开会话并排、选择器新开工具并入、单 X 关闭全部成员、拆分回独立标签、分隔条拖宽（热区层叠修复后用户验证）、分屏标签整体拖拽排序、双串口并排收发互不串扰。
- [x] 同步 workbench 主 spec 与 serial-terminal 主 spec（移除备注要求），归档 change。
