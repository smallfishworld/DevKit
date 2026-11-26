const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const outfile = path.join(__dirname, '.ssh-secret-test.cjs')
buildSync({
  entryPoints: [path.join(__dirname, '../src/main/services/ssh/secret.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'error'
})

const {
  encryptSshPassword,
  decryptSshPassword,
  encodeSshConfigForStorage,
  decodeSshConfigFromStorage
} = require(outfile)

let count = 0
function check(name, run) {
  run()
  count++
  console.log('  [PASS] ' + name)
}

function makeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from('ENC:' + Buffer.from(plainText, 'utf8').toString('hex'), 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('bad cipher')
      return Buffer.from(text.slice(4), 'hex').toString('utf8')
    }
  }
}

const sampleConfig = {
  last: {
    host: '192.168.1.10',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 's3cr3t-password!中文',
    privateKeyPath: ''
  },
  sessions: [
    {
      name: 'board-a',
      params: {
        host: '10.0.0.2',
        port: 2222,
        username: 'admin',
        authType: 'password',
        password: 'preset-secret-password',
        privateKeyPath: ''
      }
    },
    {
      name: 'key-only',
      params: {
        host: '10.0.0.3',
        port: 22,
        username: 'ubuntu',
        authType: 'key',
        password: '',
        privateKeyPath: '/tmp/id_rsa'
      }
    }
  ],
  termFont: 'Consolas',
  termFontSize: 13,
  logDir: '/tmp/ssh-logs',
  autoLog: true,
  showTime: false,
  sidebarWidth: 210
}

check('encrypts last and session passwords and never writes plaintext password to storage', () => {
  const storage = makeStorage(true)
  const stored = encodeSshConfigForStorage(sampleConfig, storage)
  const serialized = JSON.stringify(stored)

  assert.equal('password' in stored.last, false)
  assert.equal(typeof stored.last.passwordEncrypted, 'string')
  assert.equal('password' in stored.sessions[0].params, false)
  assert.equal(typeof stored.sessions[0].params.passwordEncrypted, 'string')
  assert.equal('password' in stored.sessions[1].params, false)
  assert.equal(stored.sessions[1].params.passwordEncrypted, undefined)

  assert.equal(serialized.includes('s3cr3t-password!中文'), false)
  assert.equal(serialized.includes('preset-secret-password'), false)

  const decoded = decodeSshConfigFromStorage(stored, storage)
  assert.equal(decoded.last.password, 's3cr3t-password!中文')
  assert.equal(decoded.sessions[0].params.password, 'preset-secret-password')
  assert.equal(decoded.sessions[1].params.password, '')
  assert.equal(decoded.sessions[1].params.privateKeyPath, '/tmp/id_rsa')
})

check('ignores legacy plaintext password fields without backward compatibility', () => {
  const storage = makeStorage(true)
  const legacyRaw = {
    last: {
      host: '192.168.1.20',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'old-plaintext-password',
      privateKeyPath: ''
    },
    sessions: [
      {
        name: 'legacy',
        params: {
          host: '192.168.1.21',
          port: 22,
          username: 'root',
          authType: 'password',
          password: 'legacy-preset-password',
          privateKeyPath: ''
        }
      }
    ]
  }
  const decoded = decodeSshConfigFromStorage(legacyRaw, storage)
  assert.equal(decoded.last.password, '')
  assert.equal(decoded.sessions[0].params.password, '')
})

check('returns empty password when ciphertext is corrupted or undecryptable', () => {
  const storage = makeStorage(true)
  const corrupted = {
    last: {
      host: '192.168.1.30',
      port: 22,
      username: 'root',
      authType: 'password',
      passwordEncrypted: Buffer.from('not-valid-cipher', 'utf8').toString('base64'),
      privateKeyPath: ''
    },
    sessions: []
  }
  const decoded = decodeSshConfigFromStorage(corrupted, storage)
  assert.equal(decoded.last.password, '')
  assert.equal(decryptSshPassword('***invalid***', storage), '')
})

check('never falls back to plaintext when safeStorage encryption is unavailable', () => {
  const unavailable = makeStorage(false)
  let warned = 0
  const stored = encodeSshConfigForStorage(sampleConfig, unavailable, () => {
    warned++
  })
  const serialized = JSON.stringify(stored)
  assert.equal(warned > 0, true)
  assert.equal('password' in stored.last, false)
  assert.equal(stored.last.passwordEncrypted, undefined)
  assert.equal(stored.sessions[0].params.passwordEncrypted, undefined)
  assert.equal(serialized.includes('s3cr3t-password!中文'), false)
  assert.equal(serialized.includes('preset-secret-password'), false)
  assert.equal(encryptSshPassword('abc', unavailable), undefined)
  assert.equal(decryptSshPassword('YWJj', unavailable), '')
})

console.log('ssh-secret-test: all ' + count + ' passed')
