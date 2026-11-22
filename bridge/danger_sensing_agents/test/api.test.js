// The Claude API path with no network: where the key comes from, the request the SDK sends and the error text.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Translator, loadCredentials } = require('../translator')
const { Designer } = require('../designer')

const KEY = 'test-key-not-real'
const BOTS = ['Agent1', 'Agent2']

function message (text, stopReason = 'end_turn') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }
}

// Answers every request with one reply. The client has to be made inside run so it picks up this fetch
async function withFetch (reply, status, run) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) })
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = real
  }
}

test('the key comes from the environment first, then from a .env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-env-'))
  try {
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, `# local settings\nexport ANTHROPIC_API_KEY="${KEY}"\n`)
    assert.deepEqual(loadCredentials([file], {}), { key: KEY })
    assert.deepEqual(loadCredentials([file], { ANTHROPIC_API_KEY: 'from-env' }), { key: 'from-env' })
    assert.equal(loadCredentials([path.join(dir, 'missing')], {}), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the translator asks Claude Haiku through the SDK and reads one request', async () => {
  await withFetch(message('{"goal": {"item": "wood", "count": 10}}'), 200, async calls => {
    const t = new Translator({ botNames: BOTS, credentials: { key: KEY } })
    const r = await t.translate('get me some wood')
    assert.deepEqual(r.lines, ['!get wood 10'])
    assert.deepEqual(r.parsed[0].command, { name: 'get', args: { item: 'wood', count: 10 } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.model, 'claude-haiku-5-5')
    assert.ok((calls[0].headers.get('x-api-key') || calls[0].headers.get('authorization') || '').includes(KEY))
    assert.equal(calls[0].headers.get('anthropic-beta'), null)
  })
})

test('an API error is reported without the key', async () => {
  const reply = { type: 'error', error: { type: 'authentication_error', message: `invalid key ${KEY}` } }
  await withFetch(reply, 401, async () => {
    const logged = []
    const t = new Translator({ botNames: BOTS, credentials: { key: KEY }, log: l => logged.push(l) })
    const r = await t.translate('get me some wood')
    assert.match(r.error, /^API error 401/)
    assert.ok(!r.error.includes(KEY))
    assert.ok(!logged.join(' ').includes(KEY))
  })
})

test('the designer uses the SDK and reports a refusal', async () => {
  await withFetch(message('', 'refusal'), 200, async calls => {
    const d = new Designer({ credentials: { key: KEY } })
    const r = await d.design('tower', 'a small tower')
    assert.deepEqual(r, { error: 'the model declined' })
    assert.equal(calls[0].body.model, 'claude-sonnet-5-5')
    assert.equal(calls[0].headers.get('anthropic-beta'), null)
  })
})
