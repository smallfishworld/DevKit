# Tasks

- [x] `github.ts`：`RateLimitError` 类型化两处限流抛点；`fallbackLatest`（302 解析 tag → 直链 Content-Length → `.sha256` 边车 → 复用 `readPendingUpdate` 校验）；`probeContentLength`。
- [x] `updates/index.ts`：`resolveUpdate()`（API → 限流时回退 → 双失败给手动下载提示）；`CHECK_INTERVAL` 6h → 12h。
- [x] `release-zip.yml`：构建后为 portable/zip 生成 `.sha256` 并随 Release 上传（--clobber）。
- [x] `tests/app-updates-entry.js`：限流错误类型、回退成功（含元数据直接驱动校验下载闭环）、只读同形、未 newer、非法 tag、无边车、边车损坏。
- [x] typecheck + 全量单测绿。
- [x] 用户确认后 commit + push（ci.yml 全绿，run 45313157285）。
- [x] v0.3.1 发布验证：流水线 45314561880 成功，portable/zip 及两份 `.sha256` 边车全部上传，边车为 64 位 hex、直链 Content-Length 与包体一致，下载表已自动刷新。
