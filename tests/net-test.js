/* 网络主机独立测试：esbuild 打包 hosts.ts 后用 node 跑回环测试 */
const { execSync } = require('node:child_process')
const path = require('node:path')
const net = require('node:net')
const dgram = require('node:dgram')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(__dirname, '.net-hosts-test.cjs')

execSync(
  `npx esbuild "${path.join(ROOT, 'src/main/services/net/hosts.ts')}" --bundle --platform=node --external:electron --outfile="${OUT}" --log-level=error`,
  { cwd: ROOT, stdio: 'inherit' }
)
const { TcpServerHost, TcpClientHost, UdpHost, createHost } = require(OUT)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}`)
  }
}

const PORT_A = 37801
const PORT_B = 37802
const PORT_U = 37803

async function testTcpServer() {
  console.log('== TCP Server ==')
  const rx = []
  let clients = []
  const server = new TcpServerHost({
    onData: (peer, buf) => rx.push({ peer, text: buf.toString() }),
    onStatus: () => {},
    onClients: (c) => (clients = c),
    onError: (m) => console.log('  srv error:', m)
  })
  const r = await server.start({ mode: 'tcp-server', host: '', port: 0, localPort: PORT_A })
  check('server start', r.ok)
  await sleep(50)

  // 两个客户端连入
  const c1 = net.connect(PORT_A, '127.0.0.1')
  const c2 = net.connect(PORT_A, '127.0.0.1')
  await sleep(100)
  check('2 clients accepted', clients.length === 2)

  // 客户端 -> 服务端
  const fromSrv = []
  c1.on('data', (d) => fromSrv.push(d.toString()))
  c2.on('data', (d) => fromSrv.push(d.toString()))
  c1.write('ping-1')
  await sleep(60)
  check('rx from client1', rx.length >= 1 && rx[0].text === 'ping-1')
  check('peer tagged', /127\.0\.0\.1:\d+ \[c\d+\]/.test(rx[0].peer))

  // 服务端定向发送给 c1
  const id1 = clients.find((c) => c.id !== '').id
  server.send(Buffer.from('hello-c1'), id1)
  await sleep(60)
  check('send to target client', fromSrv.includes('hello-c1'))

  // 广播
  server.send(Buffer.from('broadcast'))
  await sleep(60)
  check('broadcast to all', fromSrv.filter((t) => t === 'broadcast').length === 2)

  // 客户端断开
  c1.destroy()
  c2.destroy()
  await sleep(80)
  check('clients cleaned up', clients.length === 0)
  await server.stop()
}

async function testTcpClient() {
  console.log('== TCP Client ==')
  // 用 node 起一个对端 server
  const srvRx = []
  const srv = net.createServer((sock) => {
    sock.on('data', (d) => srvRx.push(d.toString()))
    sock.write('welcome')
  })
  await new Promise((r) => srv.listen(PORT_B, r))
  const rx = []
  let running = false
  const client = new TcpClientHost({
    onData: (peer, buf) => rx.push({ peer, text: buf.toString() }),
    onStatus: (s) => (running = s),
    onError: () => {}
  })
  const r = await client.start({ mode: 'tcp-client', host: '127.0.0.1', port: PORT_B, localPort: 0 })
  check('client connect', r.ok && running)
  await sleep(60)
  check('client rx welcome', rx.some((x) => x.text === 'welcome'))
  client.send(Buffer.from('req-1'))
  await sleep(60)
  check('server got req-1', srvRx.includes('req-1'))
  await client.stop()
  await sleep(50)
  check('client stopped', !running)
  srv.close()
}

async function testUdp() {
  console.log('== UDP ==')
  const rx = []
  const host = new UdpHost({
    onData: (peer, buf) => rx.push({ peer, text: buf.toString() }),
    onStatus: () => {},
    onError: () => {}
  })
  const r = await host.start({ mode: 'udp', host: '127.0.0.1', port: PORT_U, localPort: PORT_U })
  check('udp bind', r.ok)
  const s = dgram.createSocket('udp4')
  s.send('udp-hello', PORT_U, '127.0.0.1')
  await sleep(80)
  check('udp rx', rx.some((x) => x.text === 'udp-hello'))
  check('udp peer', rx.length > 0 && rx[0].peer === '127.0.0.1:' + s.address().port)
  host.send(Buffer.from('udp-reply'))
  // 发给自己的绑定口
  await sleep(80)
  check('udp tx ok (loopback rx)', rx.some((x) => x.text === 'udp-reply'))
  s.close()
  await host.stop()
}

async function testFactory() {
  console.log('== Factory ==')
  const h = createHost('udp', { onData: () => {}, onStatus: () => {} })
  check('createHost udp', h instanceof UdpHost)
  const s2 = createHost('tcp-server', { onData: () => {}, onStatus: () => {} })
  check('createHost tcp-server', s2 instanceof TcpServerHost)
}

async function main() {
  await testTcpServer()
  await testTcpClient()
  await testUdp()
  await testFactory()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}
main().catch((e) => {
  console.error('test crashed:', e)
  process.exit(1)
})
