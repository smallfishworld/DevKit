// mark.svg is the editable master. Commit generated assets for builds without this tool.
const fs = require('node:fs')
const path = require('node:path')
const { Resvg } = require('@resvg/resvg-js')

const directory = path.join(__dirname, '..', 'resources', 'branding')
const master = fs.readFileSync(path.join(directory, 'mark.svg'), 'utf8')
const body = master.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)?.[1].trim()
if (!body) throw new Error('mark.svg must contain an SVG root')

const mono = master
  .replace(/\s*<linearGradient\b[\s\S]*?<\/linearGradient>/g, '')
  .replace(/fill="url\(#module-(?:green|teal)\)"/g, 'fill="currentColor"')
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="160" y2="256" gradientUnits="userSpaceOnUse">
      <stop stop-color="#03483C"/>
      <stop offset="1" stop-color="#09251E"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#tile)"/>
  <g transform="translate(18 18) scale(0.86)">
    ${body}
  </g>
</svg>
`

function png(size) {
  return new Resvg(app, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false }
  }).render().asPng()
}

// Windows supports PNG frames in ICO. Include native sizes to avoid shell resampling.
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const frames = sizes.map(png)
const directorySize = 6 + 16 * sizes.length
const header = Buffer.alloc(directorySize)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = directorySize
sizes.forEach((size, index) => {
  const entry = 6 + 16 * index
  header[entry] = size === 256 ? 0 : size
  header[entry + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(frames[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += frames[index].length
})

const assets = new Map([
  ['mark-mono.svg', Buffer.from(mono)],
  ['app.svg', Buffer.from(app)],
  ...[256, 512, 1024].map(size => [`app-${size}.png`, png(size)]),
  ['devkit.ico', Buffer.concat([header, ...frames])]
])

const check = process.argv.includes('--check')
let outdated = false
for (const [name, content] of assets) {
  const target = path.join(directory, name)
  if (check) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
      console.error(`Outdated branding asset: ${name}; run npm run icons:generate`)
      outdated = true
    }
  } else {
    fs.writeFileSync(target, content)
    console.log(`Generated ${path.relative(path.join(__dirname, '..'), target)}`)
  }
}
if (outdated) process.exitCode = 1
else if (check) console.log('Branding assets match mark.svg')
