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

  // ── 5-minute sampling tick ──────────────────────────────
  // Drives learning/exit-path-tracker, which samples the price of every pool Meridian is
  // currently holding. The event name is kept because the dry-run simulator originally
  // owned this tick; the simulator went in the Tier-A prune, the sampler inherited it.
  // DO NOT REMOVE: position_price_path is the only un-confounded exit measurement Argus has.
  schedule('dry-run-update', '*/5 * * * *', () => {
    bus.emitSafe('dry_run_update', { trigger: 'scheduled', ts: Date.now() })
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

  // ── Regime-risk observatory: rolling recompute of the (vol × regime) map ───
  const regimeCfg = require('../config').getConfig().regimeRisk || {}
  if (regimeCfg.mode !== 'off') {
    schedule('regime-observatory', regimeCfg.cron || '0 */6 * * *', () => {
      bus.emitSafe('regime_observatory', { ts: Date.now() })
    })
  }

  // ── Portfolio-risk observatory: outcome correlation × concurrent exposure ──
  const pfCfg = require('../config').getConfig().portfolioRisk || {}
  if (pfCfg.mode !== 'off') {
    schedule('portfolio-observatory', pfCfg.cron || '0 */6 * * *', () => {
      bus.emitSafe('portfolio_observatory', { ts: Date.now() })
    })
  }

  // ── Wallet lifecycle: state transitions + quality scoring ─────────────────
  const walletCfg = require('../config').getConfig().wallet || {}
  schedule('wallet-lifecycle', walletCfg.lifecycle?.cron || '0 6 * * *', () => {
    bus.emitSafe('wallet_lifecycle_check', { ts: Date.now() })
  })

  // ── DB retention: prune the unbounded diagnostic tables ───────────────────
  const retCfg = require('../config').getConfig().retention || {}
  if (retCfg.enabled !== false) {
    schedule('retention-prune', retCfg.cron || '30 4 * * *', () => {
      bus.emitSafe('retention_prune', { ts: Date.now() })
    })
  }

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
