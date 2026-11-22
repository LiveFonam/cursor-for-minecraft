// The client of the fighting network process: a process that keeps failing must not be restarted in a loop.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { PolicyClient, RETRY_FIRST_MS, RETRY_MAX_MS, MAX_FAILURES, HEALTHY_MS } = require('../skills/policy')

class FakeProcess extends EventEmitter {
  constructor () {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
  }

  say (msg) { this.stdout.write(JSON.stringify(msg) + '\n') }

  die (code = 1) {
    this.exitCode = code
    this.emit('exit', code)
  }

  kill () { this.die(null) }
}

function makeClient () {
  const clock = { t: 1000 }
  const spawned = []
  const client = new PolicyClient('run', () => {}, {
    now: () => clock.t,
    spawnProcess: () => {
      const proc = new FakeProcess()
      spawned.push(proc)
      return proc
    }
  })
  return { client, clock, spawned }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

async function failOnce (client, spawned) {
  const running = client.start()
  spawned[spawned.length - 1].die(1)
  await assert.rejects(running)
}

test('a failed process is not restarted while its wait runs, however often a fight asks', async () => {
  const { client, spawned } = makeClient()
  await failOnce(client, spawned)
  for (let i = 0; i < 1000; i++) await assert.rejects(client.start(), /off for/)
  assert.equal(spawned.length, 1)
})

test('the wait doubles after each failure and stays under the cap', async () => {
  const { client, clock, spawned } = makeClient()
  const waits = []
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    await failOnce(client, spawned)
    waits.push(client.retryAt - clock.t)
    clock.t = client.retryAt - 1
    await assert.rejects(client.start(), /off for/)
    assert.equal(spawned.length, i + 1)
    clock.t = client.retryAt
  }
  assert.equal(waits[0], RETRY_FIRST_MS)
  assert.equal(waits[1], RETRY_FIRST_MS * 2)
  assert.ok(waits.every(w => w <= RETRY_MAX_MS))
  assert.equal(waits[waits.length - 1], RETRY_MAX_MS)
})

test('repeated failures stop the process for good', async () => {
  const { client, clock, spawned } = makeClient()
  for (let i = 0; i < MAX_FAILURES; i++) {
    await failOnce(client, spawned)
    clock.t += RETRY_MAX_MS
  }
  assert.equal(spawned.length, MAX_FAILURES)
  clock.t += 24 * 3600 * 1000
  await assert.rejects(client.start(), /stays off/)
  assert.equal(spawned.length, MAX_FAILURES)
})

test('a process that loaded and then failed at once still counts as a failure', async () => {
  const { client, clock, spawned } = makeClient()
  for (let i = 0; i < MAX_FAILURES; i++) {
    const running = client.start()
    const proc = spawned[spawned.length - 1]
    proc.say({ hello: { name: 'net', rate: 10 } })
    await running
    proc.die(1)
    await settle()
    clock.t += RETRY_MAX_MS
  }
  await assert.rejects(client.start(), /stays off/)
  assert.equal(spawned.length, MAX_FAILURES)
})

test('a process that ran long enough clears the failure count', async () => {
  const { client, clock, spawned } = makeClient()
  await failOnce(client, spawned)
  clock.t = client.retryAt
  await failOnce(client, spawned)
  clock.t = client.retryAt
  const running = client.start()
  const proc = spawned[spawned.length - 1]
  proc.say({ hello: { name: 'net', rate: 10 } })
  await running
  clock.t += HEALTHY_MS
  proc.die(1)
  await settle()
  assert.equal(client.failures, 1)
  assert.equal(client.retryAt, clock.t + RETRY_FIRST_MS)
})

test('a launch error counts once and does not throw', async () => {
  const { client, spawned } = makeClient()
  const running = client.start()
  const proc = spawned[0]
  proc.emit('error', new Error('spawn failed'))
  proc.die(-2)
  await assert.rejects(running, /could not start/)
  assert.equal(client.failures, 1)
})

test('a spawn that throws counts as a failure and leaves no pending start', async () => {
  const clock = { t: 1000 }
  let calls = 0
  const client = new PolicyClient('run', () => {}, {
    now: () => clock.t,
    spawnProcess: () => { calls++; throw new Error('spawn failed') }
  })
  await assert.rejects(client.start(), /could not start/)
  assert.equal(client.ready, null)
  await assert.rejects(client.start(), /off for/)
  assert.equal(calls, 1)
})

test('a normal close is not a failure', async () => {
  const { client, spawned } = makeClient()
  const running = client.start()
  spawned[0].say({ hello: { name: 'net', rate: 10 } })
  await running
  client.close()
  spawned[0].die(0)
  await settle()
  assert.equal(client.failures, 0)
  assert.equal(client.retryAt, 0)
})

test('a real process that exits at once is started only one time', async () => {
  const saved = process.env.AGENTS_POLICY_PYTHON
  process.env.AGENTS_POLICY_PYTHON = process.execPath  // node cannot run the Python file, so it exits with an error
  try {
    const clock = { t: 1000 }
    const client = new PolicyClient('run', () => {}, { now: () => clock.t })
    let launches = 0
    const realSpawn = client.spawnProcess
    client.spawnProcess = (...args) => { launches++; return realSpawn(...args) }
    await assert.rejects(client.start())
    for (let i = 0; i < 50; i++) await assert.rejects(client.start(), /off for/)
    assert.equal(launches, 1)
  } finally {
    if (saved === undefined) delete process.env.AGENTS_POLICY_PYTHON
    else process.env.AGENTS_POLICY_PYTHON = saved
  }
})
