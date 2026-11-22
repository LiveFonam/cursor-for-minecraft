// How the live checks end: the bot hands the result to the owner stand-in, and only what the server counts in the
// stand-in's bag passes. A fake server here, the real one in livetest.js.

const test = require('node:test')
const assert = require('node:assert')
const { handOver, testerComesClose, playerTotal } = require('../livetest')

function fakeSession ({ bag = {}, afterGive = {}, result = 'done', botAt = [0, 64, 0], testerAt = [3, 64, 0] } = {}) {
  const sent = []
  const lines = []
  const s = {
    settleMs: 0,
    sent,
    def: {},
    tester: {
      chat: text => {
        sent.push(`chat ${text}`)
        if (text !== '!Agent1 give') return
        for (const [k, n] of Object.entries(afterGive)) bag[k] = (bag[k] || 0) + n
        lines.push({ bot: 'Agent1', job: 'give', result })
      }
    },
    metrics: {
      mark: () => lines.length,
      since: i => lines.slice(i),
      waitJob: async (_s, bot, job, _ms, since) => lines.slice(since).find(l => l.bot === bot && l.job === job) || null
    },
    rcon: {
      send: async c => {
        sent.push(c)
        const count = c.match(/^clear AgentTester minecraft:(\w+) 0$/)
        if (count) return bag[count[1]] ? `Found ${bag[count[1]]} matching items on player AgentTester` : 'No items were found on player AgentTester'
        const pos = c.match(/^data get entity (\w+) Pos$/)
        if (pos) {
          const p = pos[1] === 'Agent1' ? botAt : testerAt
          return `${pos[1]} has the following entity data: [${p[0]}.5d, ${p[1]}.0d, ${p[2]}.5d]`
        }
        return ''
      }
    }
  }
  return s
}

test('the server count in the stand-in bag passes a handover', async () => {
  const s = fakeSession({ afterGive: { oak_log: 5, birch_log: 3 } })
  const step = await handOver(s, [{ items: ['oak_log', 'birch_log'], want: 8 }], { pickupMs: 0 })
  assert.equal(step.handed_over, true)
  assert.deepEqual(step.delivered, [{ item: 'oak_log', want: 8, got: 8 }])
  assert.equal(step.owner_came_closer, false)
})

test('what the stand-in already held does not count', async () => {
  const s = fakeSession({ bag: { raw_iron: 9 }, afterGive: { raw_iron: 2 } })
  const step = await handOver(s, [{ items: ['raw_iron'], want: 3 }], { pickupMs: 0 })
  assert.equal(step.delivered[0].got, 2)
  assert.equal(step.handed_over, false)
})

test('a give that says done with nothing in the stand-in bag fails', async () => {
  const s = fakeSession()
  const step = await handOver(s, [{ items: ['coal'], want: 1 }], { pickupMs: 0 })
  assert.equal(step.result, 'done')
  assert.equal(step.handed_over, false)
})

test('a give that did not end done fails even with the items delivered', async () => {
  const s = fakeSession({ afterGive: { coal: 5 }, result: 'far' })
  const step = await handOver(s, [{ items: ['coal'], want: 5 }], { pickupMs: 0 })
  assert.equal(step.handed_over, false)
})

test('every item kind must arrive', async () => {
  const s = fakeSession({ afterGive: { raw_iron: 5, coal: 4 } })
  const step = await handOver(s, [{ items: ['raw_iron'], want: 5 }, { items: ['coal'], want: 10 }], { pickupMs: 0 })
  assert.equal(step.handed_over, false)
  assert.deepEqual(step.delivered.map(d => d.got), [5, 4])
})

test('the stand-in moves closer only when the bot is out of range', async () => {
  const near = fakeSession({ botAt: [0, 64, 0], testerAt: [20, 64, 0] })
  assert.equal(await testerComesClose(near), false)
  assert.ok(!near.sent.some(c => c.startsWith('spreadplayers')))
  const far = fakeSession({ botAt: [100, 70, -40], testerAt: [0, 64, 0] })
  assert.equal(await testerComesClose(far), true)
  // the bot stands at z -40.5, which is block -41
  assert.ok(far.sent.includes('spreadplayers 100 -41 4 16 false AgentTester'), far.sent.join(' | '))
})

test('playerTotal adds the kinds up from the server replies', async () => {
  const s = fakeSession({ bag: { coal: 3, raw_iron: 2 } })
  assert.equal(await playerTotal(s, 'AgentTester', ['coal', 'raw_iron', 'diamond']), 5)
})
