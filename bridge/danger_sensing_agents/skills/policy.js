// Talks to agents_policy.py, the Python process that runs the trained fighting network for every agent.
// One JSON line per decision each way: {"id", "key", "obs", "mask"} out, {"id", "action"} back.

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const readline = require('readline')

const ROOT = path.join(__dirname, '..', '..', '..')
const REPLY_MS = 100  // two game ticks: a decision slower than this is dropped and the bot idles for that step
const RETRY_FIRST_MS = 1000  // the wait after the first failure, doubled after each further one
const RETRY_MAX_MS = 30000  // the longest wait between two starts
const MAX_FAILURES = 8  // after this many failures in a row the process is not started again
const HEALTHY_MS = 60000  // a process that loaded and ran this long clears the failure count

class PolicyClient {
  // args replaces the command line after agents_policy.py (the mob network passes --mob and its file)
  constructor (run, log = () => {}, { spawnProcess = spawn, now = Date.now, args = null } = {}) {
    this.run = run
    this.args = args
    this.log = log
    this.spawnProcess = spawnProcess
    this.now = now
    this.nextId = 1
    this.waiting = new Map()
    this.ready = null
    this.info = null
    this.failed = null
    this.failures = 0
    this.retryAt = 0
    this.gaveUp = false
    this.closing = null
  }

  python () {
    if (process.env.AGENTS_POLICY_PYTHON) return process.env.AGENTS_POLICY_PYTHON
    // Windows keeps the venv's Python in Scripts
    const win = process.platform === 'win32'
    const inVenv = dir => win ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python')
    for (const dir of [ROOT, path.join(ROOT, 'fighter')]) if (fs.existsSync(inVenv(dir))) return inVenv(dir)
    return win ? 'python' : 'python3'
  }

  // Why a start is refused right now, or null when the process may start
  blocked () {
    if (this.gaveUp) return `the fighter network failed ${this.failures} times in a row and stays off: ${this.failed}`
    const wait = this.retryAt - this.now()
    if (wait > 0) return `the fighter network is off for ${Math.ceil(wait / 1000)} s more: ${this.failed}`
    return null
  }

  // Counts one stopped process and sets how long the next start has to wait
  noteFailure (helloAt) {
    const now = this.now()
    if (helloAt !== null && now - helloAt >= HEALTHY_MS) this.failures = 0
    this.failures++
    if (this.failures >= MAX_FAILURES) {
      this.gaveUp = true
      this.log(`fighter network failed ${this.failures} times in a row, not starting it again: ${this.failed}`)
      return
    }
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (this.failures - 1))
    this.retryAt = now + wait
    this.log(`fighter network stopped (failure ${this.failures} of ${MAX_FAILURES}), next start in ${wait / 1000} s: ${this.failed}`)
  }

  // Starts the Python side on first use. Resolves with {name, rate} once the network is loaded.
  // A process that keeps failing is started again only after a growing wait, then not at all
  start () {
    if (this.ready) return this.ready
    const refused = this.blocked()
    if (refused) return Promise.reject(new Error(refused))
    this.failed = null
    let proc
    try {
      proc = this.spawnProcess(this.python(), [path.join(ROOT, 'agents_policy.py'), ...(this.args || ['--run', this.run])], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      this.failed = `could not start the fighter network: ${err.message}`
      this.noteFailure(null)
      return Promise.reject(new Error(this.failed))
    }
    this.proc = proc
    this.ready = new Promise((resolve, reject) => {
      let helloAt = null
      let stopped = false
      // A process that failed to launch can report both an error and an exit, and it counts once
      const onStopped = () => {
        if (stopped) return
        stopped = true
        for (const w of this.waiting.values()) { clearTimeout(w.timer); w.resolve(null) }
        this.waiting.clear()
        this.ready = null
        this.proc = null
        if (this.closing === proc) this.closing = null
        else this.noteFailure(helloAt)
        reject(new Error(this.failed))
      }
      proc.stdin.on('error', () => {})  // a write to a process that just died is handled by its exit
      const lines = readline.createInterface({ input: proc.stdout })
      lines.on('line', line => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.hello) {
          helloAt = this.now()
          this.info = msg.hello
          this.log(`fighter network ${msg.hello.name} loaded, ${msg.hello.rate} decisions a second`)
          resolve(msg.hello)
          return
        }
        if (msg.error && msg.id == null) {
          this.failed = msg.error
          reject(new Error(msg.error))
          return
        }
        const w = this.waiting.get(msg.id)
        if (!w) return
        this.waiting.delete(msg.id)
        clearTimeout(w.timer)
        if (msg.error) w.resolve(null)
        else w.resolve(msg.action)
      })
      proc.stderr.on('data', d => {
        const text = String(d).trim()
        if (text) this.log(`[policy] ${text.split('\n').slice(-3).join(' | ')}`)
      })
      proc.on('error', err => {
        this.failed = this.failed || `could not start the fighter network: ${err.message}`
        onStopped()
      })
      proc.on('exit', code => {
        this.failed = this.failed || `the fighter network stopped (exit ${code})`
        onStopped()
      })
    })
    this.ready.catch(() => {})
    return this.ready
  }

  // One decision for one bot. Resolves with the action, or null when the network is slow or gone
  async act (key, obs, mask) {
    await this.start()
    if (!this.proc) return null
    const id = this.nextId++
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null) }, REPLY_MS)
      this.waiting.set(id, { resolve, timer })
      this.proc.stdin.write(JSON.stringify({ id, key, obs, mask: mask.map(Number) }) + '\n')
    })
  }

  close () {
    if (!this.proc) return
    const proc = this.proc
    this.closing = proc
    try { proc.stdin.end() } catch {}
    setTimeout(() => { if (proc.exitCode === null) proc.kill() }, 3000)
  }
}

module.exports = { PolicyClient, RETRY_FIRST_MS, RETRY_MAX_MS, MAX_FAILURES, HEALTHY_MS }
