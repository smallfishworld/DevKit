#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const MAX_BYTES = 4 * 1024 * 1024
function pack(source, destination) {
  const root = fs.realpathSync(source)
  const out = path.resolve(destination)
  const relative = path.relative(root, out)
  if (!relative.startsWith('..') && !path.isAbsolute(relative))
    throw new Error('输出文件须在插件目录之外')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  if (manifest.apiVersion !== 2 || typeof manifest.id !== 'string') throw new Error('manifest须声明id和apiVersion:2')
  const files = {}
  let size = 0
  function visit(dir, prefix) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (['.git','node_modules'].includes(item.name)) continue
      const name = prefix ? prefix + '/' + item.name : item.name
      if (name === 'manifest.json') continue
      const file = path.join(dir, item.name)
      if (item.isSymbolicLink()) throw new Error('插件包不可包含符号链接')
      if (item.isDirectory()) visit(file, name)
      else if (item.isFile()) {
        const bytes = fs.readFileSync(file)
        if (bytes.includes(0)) throw new Error('API v2 JSON包仅包含文本文件：' + name)
        size += bytes.length
        if (size > MAX_BYTES || Object.keys(files).length >= 127) throw new Error('插件包过大')
        files[name] = bytes.toString('utf8')
      } else throw new Error('插件包包含不支持的文件类型')
    }
  }
  visit(root, '')
  if (!Object.prototype.hasOwnProperty.call(files, manifest.entry)) throw new Error('缺少插件入口文件')
  const bundle = JSON.stringify({ manifest, files }, null, 2) + '\n'
  if (Buffer.byteLength(bundle) > MAX_BYTES) throw new Error('JSON插件包超过4MiB')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, bundle)
  return { id: manifest.id, files: Object.keys(files).length, path: out }
}
if (require.main === module) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/package-device-plugin.cjs <plugin-directory> <output.json>')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(pack(process.argv[2], process.argv[3]))) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
module.exports = { pack }
