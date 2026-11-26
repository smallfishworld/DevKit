import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  APP_LOCALES,
  DEFAULT_APP_LOCALE,
  sanitizeAppLocale,
  sanitizeLocaleSettings
} from '../src/shared/locale.ts'
import { i18n, messages } from '../src/renderer/src/i18n/index.ts'
import { getAppLocale, mainMessages, mainText, setAppLocale } from '../src/main/app-locale.ts'

// 1. Supported locales, default fallback, and settings sanitization
assert.deepEqual(APP_LOCALES, ['zh-CN', 'en'])
assert.equal(DEFAULT_APP_LOCALE, 'zh-CN')
assert.equal(sanitizeAppLocale('zh-CN'), 'zh-CN')
assert.equal(sanitizeAppLocale('en'), 'en')
for (const invalid of [undefined, null, '', 'en-US', 'zh', 1, {}, []]) {
  assert.equal(sanitizeAppLocale(invalid), 'zh-CN')
}
assert.deepEqual(sanitizeLocaleSettings({ language: 'en' }), { language: 'en' })
assert.deepEqual(sanitizeLocaleSettings({ language: 'fr' }), { language: 'zh-CN' })
assert.deepEqual(sanitizeLocaleSettings(null), { language: 'zh-CN' })

// 2. Flatten & verify renderer message catalog parity, non-empty values, and placeholder parity
function flattenLeaves(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(child)) {
      assert.ok(child.length > 0, `Empty array message at ${full}`)
      child.forEach((item, idx) => {
        assert.equal(typeof item, 'string', `Non-string array item at ${full}[${idx}]`)
        assert.ok(item.trim().length > 0, `Blank array item at ${full}[${idx}]`)
      })
      out[full] = child.join('|')
    } else if (child && typeof child === 'object') {
      flattenLeaves(child, full, out)
    } else {
      assert.equal(typeof child, 'string', `Non-string message at ${full}`)
      assert.ok(child.trim().length > 0, `Blank message at ${full}`)
      out[full] = child
    }
  }
  return out
}

function placeholdersOf(text) {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()
}

const zhRenderer = flattenLeaves(messages['zh-CN'])
const enRenderer = flattenLeaves(messages.en)
assert.deepEqual(Object.keys(enRenderer).sort(), Object.keys(zhRenderer).sort())

for (const key of Object.keys(zhRenderer)) {
  assert.deepEqual(
    placeholdersOf(enRenderer[key]),
    placeholdersOf(zhRenderer[key]),
    `Placeholder mismatch for renderer key "${key}": zh=${zhRenderer[key]} | en=${enRenderer[key]}`
  )
}

assert.equal(messages.en.language.zhCN, '简体中文')
assert.equal(messages['zh-CN'].language.en, 'English')

// 3. Verify main-process message catalog parity, non-empty values, and placeholder parity
const zhMain = flattenLeaves(mainMessages['zh-CN'])
const enMain = flattenLeaves(mainMessages.en)
assert.deepEqual(Object.keys(enMain).sort(), Object.keys(zhMain).sort())

for (const key of Object.keys(zhMain)) {
  assert.deepEqual(
    placeholdersOf(enMain[key]),
    placeholdersOf(zhMain[key]),
    `Placeholder mismatch for main key "${key}": zh=${zhMain[key]} | en=${enMain[key]}`
  )
}

// 4. Verify live switching & named-parameter interpolation in both renderer i18n and main-process locale
i18n.global.locale.value = 'zh-CN'
assert.equal(i18n.global.t('shell.version', { version: '0.3.4' }), '版本 0.3.4')
i18n.global.locale.value = 'en'
assert.equal(i18n.global.t('shell.version', { version: '0.3.4' }), 'Version 0.3.4')
// Production fallback to zh-CN when locale is reset or key only exists in fallback
i18n.global.locale.value = 'zh-CN'

assert.equal(setAppLocale('en'), 'en')
assert.equal(getAppLocale(), 'en')
assert.equal(
  mainText('bridgeTcpPortInUse', { port: 10001, cid: 1 }),
  'TCP port 10001 is already used by CH1'
)
assert.equal(setAppLocale('invalid-locale'), 'zh-CN')
assert.equal(getAppLocale(), 'zh-CN')
assert.equal(
  mainText('bridgeTcpPortInUse', { port: 10001, cid: 1 }),
  'TCP 端口 10001 已被 CH1 占用'
)

// 5. Verify bilingual README cross-links exist
const root = path.resolve(process.cwd())
const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8')
assert.ok(readmeZh.includes('(README.en.md)'), 'README.md must link to README.en.md')
assert.ok(readmeEn.includes('(README.md)'), 'README.en.md must link to README.md')

console.log(`locale tests passed (${Object.keys(zhRenderer).length} renderer keys, ${Object.keys(zhMain).length} main keys)`)
