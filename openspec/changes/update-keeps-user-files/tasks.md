# Tasks

- [x] 1.1 更新助手：清单以外的条目视为用户文件，随旧目录进备份、新版本确认启动后放回；放不回的留在备份并写 `apply-leftover`，备份里还有非安装包条目时不删除。
- [x] 1.2 更新助手：预检发现占用（`ready=locked`）或与新版本同名（`ready=collision`）时在应用退出前拒绝；旧安装缺文件照常更新。
- [x] 1.3 更新助手：退出后替换失败写 `apply-detail=locked`。
- [x] 1.4 主进程与共享逻辑：`preflightRefusal`、`applyFailureMessage`、`parseLeftover`、`leftoverNotice`、`reportLeftoverFiles`。
- [x] 1.5 隔离测试台 `tests/probes/updater-harness.cjs`（15 个场景：保留、补齐、同名、链接、清单异常、三种占用、瞬时占用、退出后被占用、回滚、遗留、便携版升级与回滚），接入 ci.yml。
- [x] 1.6 单测：拒绝文案、失败原因、遗留标记解析、包名。
- [x] 1.7 Electron 界面冒烟：遗留文件只提示一次，非助手备份目录不提示。
- [x] 2.1 发布包不带版本号：`package.json`、更新模块、品牌检查、测试夹具与探针、CI、README、AGENTS.md。
- [x] 2.2 `tests/probes/windows-updates.cjs` 按新行为改写（共享目录场景改为：链接与占用被拒、解除后更新成功、用户文件原样保留）。
- [ ] 2.3 真实产物的升级 / 回滚探针跑通（需先打包 `release/` 与 `release-update-next/`；push 后 ci.yml 也会跑）。
- [ ] 2.4 用户在应用内实际点一次更新确认，随后归档本变更。
