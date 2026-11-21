'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig } = require('../src/config')

const missing = path.join(os.tmpdir(), 'crew-config-that-does-not-exist.json')

function tempConfig (data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-config-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify(data))
  return file
}

test('owner is required and has no built-in default', () => {
  const file = tempConfig({})
  assert.throws(() => loadConfig({ env: {}, file }), /owner/i)
})

test('a named config file must exist', () => {
  assert.throws(() => loadConfig({ env: { CREW_OWNER: 'TestOwner' }, file: missing }), /not found/)
})

test('environment overrides the config file', () => {
  const file = tempConfig({ owner: 'FileOwner', host: 'file.example', port: 1111 })
  const config = loadConfig({ env: { CREW_OWNER: 'EnvOwner', CREW_PORT: '2222', CREW_BOTS: 'Alpha1, Beta2' }, file })
  assert.equal(config.owner, 'EnvOwner')
  assert.equal(config.host, 'file.example')
  assert.equal(config.port, 2222)
  assert.deepEqual(config.bots, ['Alpha1', 'Beta2'])
})

test('rejects bad values', () => {
  const file = tempConfig({})
  const base = { CREW_OWNER: 'TestOwner' }
  assert.throws(() => loadConfig({ env: { ...base, CREW_PORT: '70000' }, file }), /Port/)
  assert.throws(() => loadConfig({ env: { ...base, CREW_AUTH: 'guest' }, file }), /Auth/)
  assert.throws(() => loadConfig({ env: { ...base, CREW_VERSION: '1.20.4' }, file }), /1\.21/)
  assert.throws(() => loadConfig({ env: { CREW_OWNER: 'bad name!' }, file }), /valid/)
})

test('a bot cannot share the owner name or another bot name', () => {
  const file = tempConfig({})
  assert.throws(() => loadConfig({ env: { CREW_OWNER: 'TestOwner', CREW_BOTS: 'testowner' }, file }), /unique/)
  assert.throws(() => loadConfig({ env: { CREW_OWNER: 'TestOwner', CREW_BOTS: 'Same1,same1' }, file }), /unique/)
})

test('the example config loads', () => {
  const file = path.join(__dirname, '..', 'crew.config.example.json')
  const config = loadConfig({ env: {}, file })
  assert.equal(config.version, '1.21.4')
  assert.equal(loadConfig({ env: { CREW_OWNER: 'TestOwner' }, file }).owner, 'TestOwner')
})
