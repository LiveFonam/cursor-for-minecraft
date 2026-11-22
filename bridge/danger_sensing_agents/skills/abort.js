// Shared helpers for ending a job cleanly. A job holds a plain token, { cancelled: false }, that its mode sets to true.

const POLL_MS = 100

class CancelledError extends Error {
  constructor (message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

class TimeoutError extends Error {
  constructor (message = 'timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

const isCancelled = err => err?.name === 'CancelledError'
const isTimeout = err => err?.name === 'TimeoutError'

function throwIfCancelled (token) {
  if (token?.cancelled) throw new CancelledError()
}

// Waits for a promise, for at most ms. On the limit it runs onTimeout (to stop the work) and rejects with a
// TimeoutError. A rejection that arrives after the limit is ignored.
function withTimeout (promise, ms, { message, onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let open = true
    const timer = setTimeout(() => {
      if (!open) return
      open = false
      try { onTimeout?.() } catch {}
      reject(new TimeoutError(message))
    }, ms)
    Promise.resolve(promise).then(
      value => { if (open) { open = false; clearTimeout(timer); resolve(value) } },
      err => { if (open) { open = false; clearTimeout(timer); reject(err) } }
    )
  })
}

// Sleeps for ms, waking early once the token is cancelled. Returns true when the full time passed.
async function sleep (ms, token) {
  const until = Date.now() + ms
  while (!token?.cancelled) {
    const left = until - Date.now()
    if (left <= 0) return true
    await new Promise(resolve => setTimeout(resolve, token ? Math.min(left, POLL_MS) : left))
  }
  return false
}

module.exports = { CancelledError, TimeoutError, isCancelled, isTimeout, throwIfCancelled, withTimeout, sleep }
