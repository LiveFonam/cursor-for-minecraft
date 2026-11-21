'use strict'

class AbortedError extends Error {
  constructor (message = 'Aborted') {
    super(message)
    this.name = 'AbortedError'
  }
}

class TimeoutError extends Error {
  constructor (message = 'Timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

function isAbort (err) {
  return err?.name === 'AbortedError'
}

function throwIfAborted (signal) {
  if (signal?.aborted) throw new AbortedError()
}

// Waits for a promise, but gives up early on abort or timeout.
// A late rejection from the original promise is handled and ignored.
function settle (promise, { signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null
    const finish = (fn, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => finish(reject, new AbortedError())

    Promise.resolve(promise).then(value => finish(resolve, value), err => finish(reject, err))

    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs) timer = setTimeout(() => finish(reject, new TimeoutError()), timeoutMs)
  })
}

function sleep (ms, signal) {
  return settle(new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }), { signal })
}

module.exports = { AbortedError, TimeoutError, isAbort, throwIfAborted, settle, sleep }
