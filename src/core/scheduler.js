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

  // ── Pattern reconciliation: recompute authoritative stats from source ──────
  const learnCfg = require('../config').getConfig().learning || {}
  if (learnCfg.reconcileEnabled !== false) {
    schedule('pattern-reconcile', learnCfg.reconcileCron || '0 */6 * * *', () => {
      bus.emitSafe('pattern_reconciliation', { ts: Date.now() })
    })
  }

  // ── Self-diagnosis: surface sustained capability gaps ──────────────────────
  if (learnCfg.diagnosis?.enabled !== false) {
    schedule('capability-diagnosis', learnCfg.diagnosis?.cron || '0 */6 * * *', () => {
      bus.emitSafe('capability_diagnosis', { ts: Date.now() })
    })
  }

  // ── Daily self-report digest (consolidated status) ─────────────────────────
  const aiCfg = require('../config').getConfig().ai || {}
  if (aiCfg.selfReport?.enabled !== false && aiCfg.selfReport?.digestCron) {
    schedule('self-report-digest', aiCfg.selfReport.digestCron, () => {
      bus.emitSafe('self_report_due', { ts: Date.now() })
    })
  }

  // ── Auto-tuner cycle (no-op while learning.autoTuner.enabled = false) ──────
  if (learnCfg.autoTuner?.enabled) {
    schedule('auto-tune', learnCfg.autoTuner.intervalCron || '0 */1 * * *', () => {
      bus.emitSafe('tuner_cycle', { ts: Date.now() })
    })
  }

  // ── Wallet lifecycle: state transitions + quality scoring ─────────────────
  const walletCfg = require('../config').getConfig().wallet || {}
  schedule('wallet-lifecycle', walletCfg.lifecycle?.cron || '0 6 * * *', () => {
    bus.emitSafe('wallet_lifecycle_check', { ts: Date.now() })
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
