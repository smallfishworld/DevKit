/* 设备动作配置存储测试：esbuild 打包 device-actions-store.ts，验证
   缺失/损坏/超限文件的读取结果，校验失败不覆盖原文件，以及示例配置可被解析。 */
const { execSync } = require('node:child_process')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

function bundle(entry, name) {
  const out = path.join(__dirname, name)
  execSync(
    `npx esbuild "${path.join(ROOT, entry)}" --bundle --platform=node --outfile="${out}" --log-level=error`,
    { cwd: ROOT, stdio: 'inherit' }
  )
  return require(out)
}

const { createDeviceActionsExample } = bundle('src/shared/device-actions.ts', '.device-actions-example-test.cjs')
const { parseDeviceActionsConfig } = bundle('src/main/services/serial/device-actions-config.ts', '.device-actions-config-test.cjs')
const store = bundle('src/main/services/serial/device-actions-store.ts', '.device-config-store-test.cjs')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'devkit-device-config-'))
  const file = store.deviceActionsFilePath(dir)
  try {
    console.log('--- 读取 ---')
    const missing = await store.readDeviceActionsFile(dir)
    check('文件不存在时 exists=false 且不报错', missing.exists === false && missing.error === undefined)

    console.log('--- 示例与写入 ---')
    const example = createDeviceActionsExample()
    const written = await store.writeDeviceActionsFile(example, dir)
    check('示例配置写入成功', written.ok === true && written.path === file)
    const text = await readFile(file, 'utf8')
    check('落盘为格式化 JSON 且带结尾换行', text.includes('\n  "loginUrl"') && text.endsWith('\n'))
    const readBack = await store.readDeviceActionsFile(dir)
    check('写后可读且能解析', readBack.exists === true && readBack.config?.profiles.length === example.profiles.length)
    check('默认包含手动与自动两个动作', readBack.config?.profiles.some((p) => p.trigger === 'manual') === true &&
      readBack.config?.profiles.some((p) => p.trigger === 'auto') === true)

    console.log('--- 校验失败不落盘 ---')
    const before = await readFile(file, 'utf8')
    const invalid = await store.writeDeviceActionsFile({
      ...example, issue: { ...example.issue, body: { challenge: 'missing-placeholder' } }
    }, dir)
    check('缺少 $challenge 的配置被拒绝', invalid.ok === false && /\$challenge/.test(invalid.error))
    check('失败时原文件保持不变', (await readFile(file, 'utf8')) === before)

    console.log('--- 损坏与超限 ---')
    await writeFile(file, '{ not json', 'utf8')
    const broken = await store.readDeviceActionsFile(dir)
    check('JSON 语法错误时保留原文供修复', broken.exists === true && broken.config === undefined &&
      broken.text === '{ not json' && /不是有效 JSON/.test(broken.error))
    await writeFile(file, JSON.stringify({ padding: 'x'.repeat(70_000) }), 'utf8')
    const huge = await store.readDeviceActionsFile(dir)
    check('超过 64 KB 时明确报错', huge.exists === true && /内容超限/.test(huge.error))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log('--- 配置校验入口 ---')
  const normalized = parseDeviceActionsConfig(createDeviceActionsExample())
  check('示例通过主进程解析并补全默认值', normalized.profiles.every((p) => p.newline === 'cr') &&
    normalized.profiles[0].holdInput === false && typeof normalized.profiles[1].holdInput === 'object')

  if (fail > 0) {
    console.log(`\ndevice-config-store-test: ${fail} FAILED, ${pass} passed`)
    process.exit(1)
  }
  console.log(`\ndevice-config-store-test: all ${pass} passed`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
