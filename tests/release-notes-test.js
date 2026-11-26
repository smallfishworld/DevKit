/* 双语 Release 说明、marker 范围更新脚本与双章节更新解析测试 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const {
  START_MARKER,
  END_MARKER,
  updateReleaseDownloadTable
} = require('../scripts/update-release-download-table.cjs')

const ROOT = path.join(__dirname, '..')

// 1. 模板本身必须能通过 marker 更新且保留精确 ## 下载 标题与双语章节
const template = fs.readFileSync(path.join(ROOT, 'docs/release-notes-template.md'), 'utf8')
const updatedTemplate = updateReleaseDownloadTable(template)
assert.ok(updatedTemplate.includes('## 更新内容'))
assert.ok(updatedTemplate.includes("## What's New"))
assert.ok(/^## 下载[ \t]*$/m.test(updatedTemplate))
assert.ok(updatedTemplate.includes('DevKit-portable.exe'))
assert.ok(updatedTemplate.includes('DevKit-win-x64.zip'))
assert.ok(updatedTemplate.includes('文件 / File'))

// 2. 仅替换 marker 之间内容，marker 外人工维护的中文、English 与迁移提示逐字保留
const customBody = [
  '## 更新内容',
  '',
  '- 新增中英文界面切换。',
  '- 迁移提示：旧配置文件自动保留。',
  '',
  "## What's New",
  '',
  '- Added live Simplified Chinese / English switching.',
  '- Migration note: existing configuration files are preserved.',
  '',
  '## 下载',
  '',
  START_MARKER,
  '| old | table |',
  END_MARKER,
  '',
  '> Manual footer note kept verbatim.'
].join('\n')

const updated = updateReleaseDownloadTable(customBody)
assert.ok(updated.startsWith(customBody.slice(0, customBody.indexOf(START_MARKER) + START_MARKER.length)))
assert.ok(updated.endsWith(customBody.slice(customBody.indexOf(END_MARKER))))
assert.ok(!updated.includes('| old | table |'))
assert.ok(updated.includes('| DevKit-portable.exe |'))
assert.ok(updated.includes('| DevKit-win-x64.zip |'))
assert.ok(updated.includes('> Manual footer note kept verbatim.'))

// 3. marker 缺失、重复或顺序错误时必须明确失败
assert.throws(() => updateReleaseDownloadTable('## 更新内容\n\n## 下载\n\n无标记'), /marker/i)
assert.throws(
  () => updateReleaseDownloadTable(`## 下载\n${START_MARKER}\n${START_MARKER}\n${END_MARKER}`),
  /marker/i
)
assert.throws(
  () => updateReleaseDownloadTable(`## 下载\n${END_MARKER}\n${START_MARKER}`),
  /out of order/i
)
assert.throws(
  () => updateReleaseDownloadTable(`## Downloads\n${START_MARKER}\n${END_MARKER}`),
  /## 下载/
)

// 4. 验证更新解析器保留中英文两个章节并正确在 `## 下载` 截断
execSync(
  `npx esbuild "${path.join(ROOT, 'src/main/services/updates/github.ts')}" --bundle --platform=node --outfile="${path.join(__dirname, '.github-release-test.cjs')}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { parseRelease, releaseNotesFromTagPage } = require('./.github-release-test.cjs')

const parsed = parseRelease(
  {
    draft: false,
    prerelease: false,
    tag_name: 'v0.4.0',
    body: updated,
    assets: []
  },
  '0.3.4'
)
assert.equal(parsed.status, 'available')
assert.ok(parsed.update.notes.includes('## 更新内容'))
assert.ok(parsed.update.notes.includes("## What's New"))
assert.ok(!parsed.update.notes.includes('DevKit-portable.exe'))

const tagHtml = `
<div data-test-selector="body-content" class="markdown-body">
  <h2>更新内容</h2>
  <ul><li>新增中英文切换</li></ul>
  <h2>What's New</h2>
  <ul><li>Added live Chinese / English switching</li></ul>
  <h2>下载</h2>
  <table><tr><td>DevKit-portable.exe</td></tr></table>
</div>`
const fallbackNotes = releaseNotesFromTagPage(tagHtml)
assert.ok(fallbackNotes && fallbackNotes.includes('新增中英文切换'))
assert.ok(fallbackNotes.includes('Added live Chinese / English switching'))
assert.ok(!fallbackNotes.includes('DevKit-portable.exe'))

console.log('release-notes tests passed')
