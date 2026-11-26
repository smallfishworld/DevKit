/*
 * 仅替换 GitHub Release 正文中受显式 marker 保护的双语下载表区段：
 * - marker 缺失、重复或顺序错误时直接抛错，避免误改人工维护的中英文发布说明
 * - 保留精确标题 `## 下载` 与稳定附件名（DevKit-portable.exe / DevKit-win-x64.zip）
 */
const fs = require('node:fs')

const START_MARKER = '<!-- devkit:download-table:start -->'
const END_MARKER = '<!-- devkit:download-table:end -->'

function buildBilingualDownloadTable(
  portableName = 'DevKit-portable.exe',
  zipName = 'DevKit-win-x64.zip'
) {
  return [
    '| 文件 / File | 说明 / Description |',
    '|---|---|',
    `| ${portableName} | 单文件便携版，无需安装，下载后直接运行 / Single-file portable edition — download and run directly |`,
    `| ${zipName} | Windows x64 解压版，解压后运行 DevKit.exe，推荐长期使用 / Windows x64 ZIP edition — extract and run DevKit.exe (recommended) |`
  ].join('\n')
}

function countOccurrences(text, needle) {
  let count = 0
  let pos = 0
  while (true) {
    const idx = text.indexOf(needle, pos)
    if (idx === -1) return count
    count += 1
    pos = idx + needle.length
  }
}

function updateReleaseDownloadTable(body, options = {}) {
  const source = typeof body === 'string' ? body : ''
  const startCount = countOccurrences(source, START_MARKER)
  const endCount = countOccurrences(source, END_MARKER)

  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `Release notes must contain exactly one ${START_MARKER} and one ${END_MARKER} marker (found start=${startCount}, end=${endCount}).`
    )
  }

  const startIndex = source.indexOf(START_MARKER)
  const endIndex = source.indexOf(END_MARKER)
  if (startIndex >= endIndex) {
    throw new Error(
      `Release notes download-table markers are out of order: ${START_MARKER} must appear before ${END_MARKER}.`
    )
  }

  const beforeStart = source.slice(0, startIndex)
  if (!/^## 下载[ \t]*$/m.test(beforeStart)) {
    throw new Error('Release notes must keep an exact "## 下载" heading before the download-table markers.')
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const table = buildBilingualDownloadTable(options.portableName, options.zipName).replace(/\n/g, eol)
  const prefix = source.slice(0, startIndex + START_MARKER.length)
  const suffix = source.slice(endIndex)
  return `${prefix}${eol}${table}${eol}${suffix}`
}

if (require.main === module) {
  const inputPath = process.argv[2]
  const outputPath = process.argv[3] || inputPath
  if (!inputPath) {
    console.error('Usage: node scripts/update-release-download-table.cjs <input.md> [output.md]')
    process.exit(1)
  }
  const raw = fs.readFileSync(inputPath, 'utf8')
  const updated = updateReleaseDownloadTable(raw)
  fs.writeFileSync(outputPath, updated, 'utf8')
}

module.exports = {
  START_MARKER,
  END_MARKER,
  buildBilingualDownloadTable,
  updateReleaseDownloadTable
}
