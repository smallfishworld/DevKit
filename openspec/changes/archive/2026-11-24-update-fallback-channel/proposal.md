# Proposal: update-fallback-channel

## 为什么

应用内「检查更新」走 `api.github.com`（匿名 60 次/小时/IP）。企业 NAT 出口下该配额被整栋出口共享，随机耗尽 → 用户看到「GitHub 请求受限」，但浏览器访问 github.com 网页正常（网页不占 API 配额），观感矛盾。

## 变更内容

1. **API 匿名配额受限时的零配额回退通道**：
   - `releases/latest` 网页跳转（302 Location）解析最新稳定版 tag；
   - 包大小取发布直链 Content-Length；
   - SHA-256 取随包上传的 `<包名>.sha256` 边车附件；
   - 三者齐全时走与正常路径**完全相同**的应用内校验下载与重启更新（无感）；无边车（旧版本发布）则提示手动下载。
2. **CI 发布产物**：`release-zip.yml` 为 portable/zip 生成并上传 `.sha256` 边车（自下一版本起可用）。
3. **降频**：自动检查间隔 6h → 12h，降低共享配额消耗。
4. **错误类型化**：限流错误抛 `RateLimitError`，调用方据此触发回退；文案区分「受限且无法回退」与普通网络失败。

## 影响

- 主进程 `services/updates/github.ts`、`index.ts`；`.github/workflows/release-zip.yml`。
- 渲染层/IPC 协议零改动（`UpdateState` 不变）。
- v0.3.0 及更早发布无边车，限流时仅提示；从下一版本起全流程可用。
