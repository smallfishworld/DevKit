/**
 * TX 审计行回归探针（tests/probes/，不在 npm test 内）
 * 对比「旧路径 cleanLogBody().split('\n')」与「新路径 txAuditLine」在日志里各产生几行。
 * 用法：node tests/probes/txaudit-probe.js（需先 esbuild 打包，见文件末尾说明）
 */
const { cleanLogBody, txAuditLine } = require('../../src/shared/logtext')

const CASES = ['\r', '\r\n', 'd', 'debug', '\r\n\r\n', '\x03', '\x15', 'reboot\r']

function oldLines(text) {
  // 旧实现：write() 把 text+newline 交给 appendLog，appendLog 再 cleanLogBody(...).split('\n')
  return cleanLogBody(text).split('\n')
}

console.log('输入                旧路径行数  旧路径内容            新路径（txAuditLine）')
for (const s of CASES) {
  const old = oldLines(s)
  const neu = txAuditLine(s)
  console.log(
    JSON.stringify(s).padEnd(18),
    String(old.length).padEnd(11),
    JSON.stringify(old).padEnd(21),
    JSON.stringify(neu)
  )
}
console.log('\n新路径恒为 1 行且不含控制符：', CASES.every((s) => !/[\r\n]/.test(txAuditLine(s))))
