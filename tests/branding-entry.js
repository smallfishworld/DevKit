const assert = require('node:assert/strict')
const { win32 } = require('node:path')
const { APP_USER_MODEL_ID, buildWindowsAppDetails, quoteWindowsArgument } = require('../src/shared/windows-branding')

let passed = 0
function check(name, run) {
  run()
  console.log('PASS ' + name)
  passed++
}

const base = {
  isPackaged: true,
  execPath: String.raw`C:\Program Files\DevKit\DevKit.exe`,
  appPath: String.raw`C:\Program Files\DevKit\resources\app.asar`,
  iconPath: String.raw`C:\Program Files\DevKit\resources\app.asar\resources\branding\devkit.ico`
}
const portable = {
  ...base,
  execPath: String.raw`C:\Users\dev\AppData\Local\Temp\abc123\DevKit.exe`,
  portableExecutableFile: String.raw`D:\我的工具\DevKit portable renamed.exe`,
  portableExecutableDir: String.raw`D:\我的工具`,
  isFile: () => true
}

check('Windows quoting: empty, whitespace and Unicode arguments', () => {
  assert.equal(quoteWindowsArgument(''), '""')
  assert.equal(quoteWindowsArgument('DevKit'), '"DevKit"')
  assert.equal(quoteWindowsArgument('D:\\我的工具\\DevKit portable.exe'), '"D:\\我的工具\\DevKit portable.exe"')
})
check('Windows quoting: literal quotes and preceding backslashes', () => {
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"')
  assert.equal(quoteWindowsArgument('a\\"b'), '"a' + '\\'.repeat(3) + '"b"')
  assert.equal(quoteWindowsArgument('a\\\\"b'), '"a' + '\\'.repeat(5) + '"b"')
})
check('Windows quoting: trailing backslashes survive the closing quote', () => {
  assert.equal(quoteWindowsArgument('C:\\folder\\'), '"C:\\folder' + '\\'.repeat(2) + '"')
  assert.equal(quoteWindowsArgument('C:\\folder\\\\'), '"C:\\folder' + '\\'.repeat(4) + '"')
})
check('Windows quoting: no shell expansion and no control-character command truncation', () => {
  assert.equal(quoteWindowsArgument('a&b|c^d%PATH%'), '"a&b|c^d%PATH%"')
  for (const value of ['a\0b', 'a\rb', 'a\nb']) assert.throws(() => quoteWindowsArgument(value), /control characters/)
})
check('ZIP/unpacked uses the real branded EXE, never ASAR or an image as the relaunch target', () => {
  const actual = buildWindowsAppDetails(base)
  assert.deepEqual(actual, {
    appId: APP_USER_MODEL_ID, appIconPath: base.execPath, appIconIndex: 0,
    relaunchCommand: '"C:\\Program Files\\DevKit\\DevKit.exe"', relaunchDisplayName: 'DevKit'
  })
})
check('development uses the source ICO and supplies Electron with the project path', () => {
  const actual = buildWindowsAppDetails({
    ...base, isPackaged: false,
    execPath: String.raw`C:\工作区\Dev Kit\node_modules\electron\dist\electron.exe`,
    appPath: 'C:\\工作区\\Dev Kit\\',
    iconPath: String.raw`C:\工作区\Dev Kit\resources\branding\devkit.ico`
  })
  assert.equal(actual.appIconPath, 'C:\\工作区\\Dev Kit\\resources\\branding\\devkit.ico')
  assert.equal(actual.relaunchCommand, '"C:\\工作区\\Dev Kit\\node_modules\\electron\\dist\\electron.exe" "C:\\工作区\\Dev Kit\\\\"')
  assert.equal(actual.appId, 'com.embedded.devkit')
  assert.equal(actual.relaunchDisplayName, 'DevKit')
})
check('portable uses the stable renamed launcher for both Shell icon and relaunch', () => {
  const inspected = []
  const actual = buildWindowsAppDetails({ ...portable, isFile: (file) => { inspected.push(file); return true } })
  assert.equal(actual.appIconPath, portable.portableExecutableFile)
  assert.equal(actual.relaunchCommand, '"D:\\我的工具\\DevKit portable renamed.exe"')
  assert.deepEqual(inspected, [portable.portableExecutableFile])
  assert.ok(!actual.relaunchCommand.includes('Temp'))
})
check('portable directory comparison follows Windows case and separator rules', () => {
  const actual = buildWindowsAppDetails({ ...portable, portableExecutableDir: 'd:/我的工具/' })
  assert.equal(actual.appIconPath, portable.portableExecutableFile)
})
check('a fully qualified UNC portable launcher is supported', () => {
  const file = String.raw`\\server\share\DevKit portable.exe`
  const actual = buildWindowsAppDetails({ ...portable, portableExecutableFile: file, portableExecutableDir: win32.dirname(file) })
  assert.equal(actual.appIconPath, file)
})
check('development ignores inherited portable environment variables', () => {
  const actual = buildWindowsAppDetails({ ...portable, isPackaged: false })
  assert.equal(actual.appIconPath, portable.iconPath)
  assert.ok(actual.relaunchCommand.startsWith('"' + portable.execPath + '" '))
})
check('invalid portable paths cannot replace the real executable', () => {
  for (const file of [
    'DevKit.exe', 'D:DevKit.exe', '\\DevKit.exe', '/DevKit.exe',
    'D:\\tools\\DevKit.ico', '"D:\\tools\\DevKit.exe"', 'D:\\tools\\bad"\u0000.exe',
    'D:\\tools\\bad\n.exe', 'D:\\tools\\bad\r.exe'
  ]) {
    let inspected = false
    const actual = buildWindowsAppDetails({
      ...portable, portableExecutableFile: file, portableExecutableDir: win32.dirname(file),
      isFile: () => { inspected = true; return true }
    })
    assert.equal(actual.appIconPath, portable.execPath, file)
    assert.equal(inspected, false, file)
  }
})
check('missing or mismatched portable directory does not redirect taskbar pinning', () => {
  for (const directory of [undefined, '', 'D:\\another folder', 'relative']) {
    const actual = buildWindowsAppDetails({ ...portable, portableExecutableDir: directory })
    assert.equal(actual.appIconPath, portable.execPath)
  }
})
check('missing, non-file, inaccessible or unchecked portable launcher fails closed', () => {
  for (const isFile of [undefined, () => false, () => { throw new Error('access denied') }]) {
    const actual = buildWindowsAppDetails({ ...portable, isFile })
    assert.equal(actual.appIconPath, portable.execPath)
    assert.equal(actual.relaunchCommand, '"' + portable.execPath + '"')
  }
})

console.log('Windows branding: ' + passed + ' passed')
