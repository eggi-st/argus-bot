'use strict'
const cron = require('node-cron')
const bus = require('./event-bus')

const jobs = new Map()

function schedule(name, cronExpr, fn) {
  const job = cron.schedule(cronExpr, () => {
    try { fn() } catch (err) { console.error(`[Scheduler] Job "${name}" error:`, err.message) }
  })
  jobs.set(name, job)
  return job
}

function start() {
  // ── Heartbeat: every minute ──────────────────────────────────────────────
  schedule('heartbeat', '* * * * *', () => {
    bus.emitSafe('heartbeat', { ts: Date.now() })
  })

  // ── Main scan cycle: every 15 minutes ────────────────────────────────────
  // Phase 1 will hook into this to trigger pool screening
  schedule('main-scan', '*/15 * * * *', () => {
    bus.emitSafe('scan_complete', { trigger: 'scheduled', ts: Date.now() })
    console.log('[Scheduler] Scan cycle triggered')
  })

  // ── TTL check: every 2 minutes ───────────────────────────────────────────
  // Checks all active recommendations — expires any past their TTL
  schedule('ttl-check', '*/2 * * * *', () => {
    bus.emitSafe('ttl_check', { ts: Date.now() })
  })

  // ── Dry run update: every 5 minutes ──────────────────────────────────────
  // Phase 2 will use this to update virtual position P&L
  schedule('dry-run-update', '*/5 * * * *', () => {
    bus.emitSafe('dry_run_update', { trigger: 'scheduled', ts: Date.now() })
  })

  // ── Hivemind discovery: every 6 hours ────────────────────────────────────
  // Scans Meteora on-chain (+ fallback sources) for new smart money wallets.
  // Sources manage their own cooldown/backoff internally.
  schedule('hivemind', '0 */6 * * *', () => {
    const hivemind = require('../wallet/hivemind-discovery')
    hivemind.runDiscovery().catch(e =>
      console.error('[Hivemind] Discovery error:', e.message)
    )
  })

  // ── Daily reset: midnight ─────────────────────────────────────────────────
  schedule('daily-reset', '0 0 * * *', () => {
    require('./risk-state')._resetIfNewDay()
    console.log('[Scheduler] Daily reset completed')
  })

  console.log(`[Scheduler] ${jobs.size} jobs scheduled`)
}

function stop() {
  for (const [name, job] of jobs) {
    job.stop()
    console.log('[Scheduler] Stopped job:', name)
  }
  jobs.clear()
}

function getStatus() {
  return [...jobs.keys()].map(name => ({ name, running: true }))
}

module.exports = { start, stop, getStatus }
