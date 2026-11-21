'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'setup-server.sh')
const FAKE_JAR = Buffer.from('not a real server, only test bytes')

// Serves fake build metadata and a fake jar on a local port.
async function fakeApi ({ checksum, fileName = 'paper-test-1.jar' } = {}) {
  const sha256 = checksum ?? crypto.createHash('sha256').update(FAKE_JAR).digest('hex')
  const server = http.createServer((req, res) => {
    const { port } = server.address()
    if (req.url.endsWith('/builds/latest')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        downloads: {
          'server:default': {
            name: fileName,
            checksums: { sha256 },
            url: `http://127.0.0.1:${port}/file.jar`
          }
        }
      }))
    } else if (req.url === '/file.jar') {
      res.end(FAKE_JAR)
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

// Runs without blocking, because the fake API lives in this same process.
function runScript (api, serverDir) {
  return new Promise(resolve => {
    const child = spawn('bash', [SCRIPT], {
      env: { ...process.env, CREW_PAPER_API: api, CREW_SERVER_DIR: serverDir }
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', status => resolve({ status, output }))
  })
}

function tempDir () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-setup-')), 'server')
}

test('installs the jar and never accepts the EULA', async () => {
  const api = await fakeApi()
  const dir = tempDir()
  try {
    const result = await runScript(api.url, dir)
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'paper-test-1.jar')), FAKE_JAR)
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt')), false)
    assert.match(result.output, /aka\.ms\/MinecraftEULA/)
    assert.match(result.output, /did not accept the EULA/)
    const leftovers = fs.readdirSync(dir).filter(name => name.startsWith('.download'))
    assert.deepEqual(leftovers, [])
  } finally {
    await api.close()
  }
})

test('the start script refuses to run until the person accepts', async () => {
  const api = await fakeApi()
  const dir = tempDir()
  try {
    const setup = await runScript(api.url, dir)
    assert.equal(setup.status, 0, setup.output)
    const start = await new Promise(resolve => {
      const child = spawn('bash', [path.join(dir, 'start.sh')])
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.on('close', status => resolve({ status, output }))
    })
    assert.equal(start.status, 1)
    assert.match(start.output, /has not been accepted/)
    assert.equal(fs.existsSync(path.join(dir, 'eula.txt')), false)
  } finally {
    await api.close()
  }
})

test('the script text never writes an accepted EULA', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  assert.equal(/(echo|printf|cat|tee|sed).*eula=true.*>/.test(text), false)
  assert.equal(/>\s*\S*eula\.txt/.test(text), false)
})

test('rejects a download with the wrong checksum', async () => {
  const api = await fakeApi({ checksum: 'a'.repeat(64) })
  const dir = tempDir()
  try {
    const result = await runScript(api.url, dir)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /Checksum mismatch/)
    assert.equal(fs.existsSync(path.join(dir, 'paper-test-1.jar')), false)
  } finally {
    await api.close()
  }
})

test('rejects a file name that could leave the server folder', async () => {
  const api = await fakeApi({ fileName: '../evil.jar' })
  const dir = tempDir()
  try {
    const result = await runScript(api.url, dir)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /Unexpected file name/)
    assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.jar')), false)
  } finally {
    await api.close()
  }
})

test('keeps server properties the person already set', async () => {
  const api = await fakeApi()
  const dir = tempDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=mine\n')
  try {
    const setup = await runScript(api.url, dir)
    assert.equal(setup.status, 0, setup.output)
    assert.equal(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), 'motd=mine\n')
  } finally {
    await api.close()
  }
})

test('default properties keep an offline server on this computer', async () => {
  const api = await fakeApi()
  const dir = tempDir()
  try {
    const setup = await runScript(api.url, dir)
    assert.equal(setup.status, 0, setup.output)
    const text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')
    assert.match(text, /^server-ip=127\.0\.0\.1$/m)
    assert.match(text, /^online-mode=false$/m)
  } finally {
    await api.close()
  }
})
