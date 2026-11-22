// The agents' settings: defaults, the config file, AGENTS_ overrides and the checks on them.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { loadConfig, requireOwner, DEFAULTS } = require('../config')

const EXAMPLE = path.join(__dirname, '..', 'agents.config.example.json')
const REPO = path.join(__dirname, '..', '..', '..')

function tempFile (content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

test('the example config is valid and holds every setting', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'))
  assert.deepEqual(Object.keys(example).sort(), Object.keys(DEFAULTS).sort())
  const c = loadConfig({ env: {}, file: EXAMPLE })
  assert.equal(c.owner, 'YourName')
  assert.deepEqual(c.bots, ['Agent1', 'Agent2'])
})

test('the file overrides the defaults and the environment overrides the file', () => {
  const file = tempFile({ owner: 'FileOwner', bots: ['FileBot'], port: 25570 })
  const fromFile = loadConfig({ env: {}, file })
  assert.equal(fromFile.owner, 'FileOwner')
  assert.equal(fromFile.port, 25570)
  assert.equal(fromFile.rcon_port, DEFAULTS.rcon_port)

  const env = { AGENTS_OWNER: 'EnvOwner', AGENTS_BOTS: 'BotOne, BotTwo', AGENTS_FRIENDS: 'PalOne,PalTwo', AGENTS_PORT: '25596', AGENTS_RCON_PORT: '25597', AGENTS_HUMAN: 'off', AGENTS_KILL_RADIUS: '30' }
  const c = loadConfig({ env, file })
  assert.equal(c.owner, 'EnvOwner')
  assert.deepEqual(c.bots, ['BotOne', 'BotTwo'])
  assert.deepEqual(c.friends, ['PalOne', 'PalTwo'])
  assert.equal(c.port, 25596)
  assert.equal(c.rcon_port, 25597)
  assert.equal(c.human, 'off')
  assert.equal(c.kill_radius, 30)
})

test('AGENTS_CONFIG picks the file and must exist', () => {
  const file = tempFile({ owner: 'NamedFile' })
  assert.equal(loadConfig({ env: { AGENTS_CONFIG: file } }).owner, 'NamedFile')
  assert.throws(() => loadConfig({ env: { AGENTS_CONFIG: `${file}.missing` } }), /not found/)
})

test('an empty AGENTS_FRIENDS clears the list from the file', () => {
  const file = tempFile({ owner: 'FileOwner', friends: ['PalOne'] })
  assert.deepEqual(loadConfig({ env: { AGENTS_FRIENDS: '' }, file }).friends, [])
})

test('a missing owner fails only when the run needs one', () => {
  const file = tempFile({})
  assert.throws(() => loadConfig({ env: {}, file }), /owner name/i)
  assert.equal(loadConfig({ env: {}, file, ownerRequired: false }).owner, null)
  assert.throws(() => requireOwner(null), /owner name/i)
  assert.throws(() => requireOwner('no spaces allowed'), /valid Minecraft name/)
  assert.equal(requireOwner('GoodName'), 'GoodName')
})

for (const [label, content, pattern] of [
  ['broken JSON', '{ nope', /not valid JSON/],
  ['a list instead of an object', '[]', /one JSON object/],
  ['an unknown setting', { owner: 'GoodName', ownr: 'Typo' }, /Unknown setting.*ownr/],
  ['a bad owner name', { owner: 'x' }, /Owner name/],
  ['a bad bot name', { owner: 'GoodName', bots: ['has space'] }, /Bot name/],
  ['no bots', { owner: 'GoodName', bots: [] }, /at least one bot/],
  ['a bot named like the owner', { owner: 'GoodName', bots: ['goodname'] }, /differ from the owner/],
  ['two bots with one name', { owner: 'GoodName', bots: ['BotOne', 'BOTONE'] }, /unique/],
  ['a bad friend name', { owner: 'GoodName', friends: ['?'] }, /Friend name/],
  ['a port out of range', { owner: 'GoodName', port: 70000 }, /Port must/],
  ['one port for both', { owner: 'GoodName', port: 25576 }, /must differ/],
  ['another game version', { owner: 'GoodName', version: '1.21.4' }, /Version must be 1\.21\.11/],
  ['a bad memory value', { owner: 'GoodName', server_memory: 'lots' }, /server_memory/],
  ['a bad human level', { owner: 'GoodName', human: 'extra' }, /human must/],
  ['a bad radius', { owner: 'GoodName', kill_radius: -1 }, /kill_radius/]
]) {
  test(`config check refuses ${label}`, () => {
    const file = tempFile(content)
    assert.throws(() => loadConfig({ env: {}, file }), pattern)
  })
}

test('a port from the environment that is not a number is refused', () => {
  const file = tempFile({ owner: 'GoodName' })
  assert.throws(() => loadConfig({ env: { AGENTS_PORT: 'abc' }, file }), /Port must/)
})

test('the local config file is ignored by git', t => {
  try {
    const out = execFileSync('git', ['-C', REPO, 'check-ignore', '--no-index', 'bridge/danger_sensing_agents/agents.config.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    assert.equal(out.trim(), 'bridge/danger_sensing_agents/agents.config.json')
  } catch (err) {
    if (err.status === undefined || err.status > 1) return t.skip('no git checkout here')
    throw err
  }
})
