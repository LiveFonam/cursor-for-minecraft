// The shared helpers that end a job or a walk.

const test = require('node:test')
const assert = require('node:assert/strict')
const { CancelledError, TimeoutError, isCancelled, isTimeout, throwIfCancelled, withTimeout, sleep } = require('../skills/abort')
const { goTo } = require('../skills/move')

const never = () => new Promise(() => {})

test('withTimeout passes on a value and an error from the work', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7)
  await assert.rejects(withTimeout(Promise.reject(new Error('broke')), 1000), /broke/)
})

test('withTimeout stops the work at the limit and rejects with a TimeoutError', async () => {
  let stopped = 0
  const err = await withTimeout(never(), 10, { message: 'too slow', onTimeout: () => stopped++ }).catch(e => e)
  assert.ok(isTimeout(err))
  assert.ok(err instanceof TimeoutError)
  assert.equal(err.message, 'too slow')
  assert.equal(stopped, 1)
})

test('withTimeout ignores a rejection that arrives after the limit', async () => {
  let fail
  const work = new Promise((resolve, reject) => { fail = reject })
  await assert.rejects(withTimeout(work, 5), TimeoutError)
  fail(new Error('late'))
  await new Promise(resolve => setTimeout(resolve, 5))
})

test('withTimeout does not run onTimeout when the work ends in time', async () => {
  let stopped = 0
  await withTimeout(Promise.resolve(), 10, { onTimeout: () => stopped++ })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(stopped, 0)
})

test('sleep runs its full time without a cancel', async () => {
  const start = Date.now()
  assert.equal(await sleep(30, { cancelled: false }), true)
  assert.ok(Date.now() - start >= 25)
  assert.equal(await sleep(5), true)
})

test('sleep wakes early when the token is cancelled', async () => {
  const token = { cancelled: false }
  const start = Date.now()
  setTimeout(() => { token.cancelled = true }, 20)
  assert.equal(await sleep(5000, token), false)
  assert.ok(Date.now() - start < 1000)
})

test('sleep on a cancelled token returns at once', async () => {
  const start = Date.now()
  assert.equal(await sleep(5000, { cancelled: true }), false)
  assert.ok(Date.now() - start < 50)
})

test('throwIfCancelled throws only for a cancelled token', () => {
  throwIfCancelled(null)
  throwIfCancelled({ cancelled: false })
  assert.throws(() => throwIfCancelled({ cancelled: true }), CancelledError)
  assert.ok(isCancelled(new CancelledError()))
  assert.equal(isCancelled(new Error('other')), false)
})

function walker (goto) {
  const goals = []
  return { goals, pathfinder: { goto, setGoal: g => goals.push(g) } }
}

test('goTo clears the goal and fails when a walk runs out of time', async () => {
  const bot = walker(never)
  await assert.rejects(goTo(bot, {}, { cancelled: false }, 10), /path took too long/)
  assert.deepEqual(bot.goals, [null])
})

test('goTo does not walk on a cancelled token', async () => {
  let walked = false
  await goTo(walker(async () => { walked = true }), {}, { cancelled: true })
  assert.equal(walked, false)
})

test('goTo swallows the error of a walk its job cancelled', async () => {
  const token = { cancelled: false }
  const bot = walker(async () => {
    token.cancelled = true
    throw new Error('goal changed')
  })
  await goTo(bot, {}, token)
})
