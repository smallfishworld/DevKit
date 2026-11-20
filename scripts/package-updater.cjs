const { execFileSync } = require('node:child_process')
const { readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function inventory(root, subdir = '') {
  const entries = readdirSync(join(root, subdir), { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = subdir + entry.name
    if (path === 'resources/devkit-update-files.txt') return []
    if (entry.isDirectory()) return [path + '/', ...inventory(root, path + '/')]
    if (!entry.isFile()) throw new Error('Unexpected entry in the Windows application package: ' + path)
    return [path]
  })
}

module.exports = ({ electronPlatformName, appOutDir }) => {
  if (electronPlatformName !== 'win32' || process.platform !== 'win32') return
  const framework = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const resources = join(appOutDir, 'resources')
  execFileSync(join(framework, 'csc.exe'), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warnaserror+',
    '/reference:' + join(framework, 'System.IO.Compression.dll'),
    '/out:' + join(resources, 'DevKitUpdater.exe'),
    join(__dirname, '..', 'resources', 'updater', 'DevKitUpdater.cs')
  ], { stdio: 'inherit' })
  writeFileSync(join(resources, 'devkit-update-files.txt'), inventory(appOutDir).sort().join('\n') + '\n')
}
