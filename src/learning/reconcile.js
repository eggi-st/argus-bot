'use strict'
// Pattern reconciliation — recomputes authoritative win_rate/wins/mean_pnl/sample_count/active
// directly from the outcome source (dry_run_positions JOIN decisions), making the event-driven
// UPSERT in pattern-updater.js a fast cache rather than the source of truth. This is the
// integrity backstop: the live UPSERT has no idempotency guard, so a re-fired outcome_recorded
// would inflate sample_count; reconcile overwrites it idempotently from source every cycle.
const bus = require('../core/event-bus')
const db  = require('../db/database')
const { getConfig, reloadConfig } = require('../config')
const { recordPatternReconciled } = require('../db/schema')
const { parseBucket } = require('./pattern-updater')

function reconcilePatterns() {
  reloadConfig()  // observe latest learning.* (config write-path wired in Phase 4A)
  const cfg = getConfig()
  const threshold = cfg.learning?.promotionThreshold ?? 60
  const now = new Date().toISOString()

  // Authoritative source: actual tracked dry-run outcomes, keyed by the decision's bucket.
  const rows = db.prepare(`
    SELECT d.condition_bucket AS bucket, dr.strategy AS strategy,
           COUNT(*) AS n,
           SUM(CASE WHEN dr.net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(dr.net_pnl_pct) AS mean_pnl
    FROM dry_run_positions dr
    JOIN decisions d ON d.id = dr.decision_id
    WHERE dr.status = 'closed' AND dr.outcome_valid = 1 AND d.condition_bucket IS NOT NULL
    GROUP BY d.condition_bucket, dr.strategy
  `).all()

  // Outcomes the authoritative source cannot represent (e.g. Meridian-feedback decisions with
  // no dry-run row). v1 intentionally DROPS these from reconciled stats — logged, never silent.
  const unlinked = db.prepare(`
    SELECT COUNT(*) AS n FROM decisions d
    WHERE d.outcome_known = 1 AND d.condition_bucket IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dry_run_positions dr WHERE dr.decision_id = d.id AND dr.outcome_valid = 1)
  `).get()

  let changed = 0
  const apply = db.transaction(() => {
    for (const r of rows) {
      const { volatility_bucket, regime } = parseBucket(r.bucket)
      const win_rate = r.n > 0 ? r.wins / r.n : 0
      const active = r.n >= threshold ? 1 : 0
      const before = db.prepare(
        `SELECT win_rate, sample_count, active FROM pattern_library WHERE volatility_bucket=? AND regime=? AND strategy=?`
      ).get(volatility_bucket, regime, r.strategy)
      recordPatternReconciled(volatility_bucket, regime, r.strategy, {
        updated_at: now, win_rate, mean_pnl_net: r.mean_pnl ?? 0,
        sample_count: r.n, wins: r.wins, active, last_reconciled_at: now,
      })
      const moved = !before || before.sample_count !== r.n ||
        Math.abs((before.win_rate || 0) - win_rate) > 1e-9 || before.active !== active
      if (moved) {
        changed++
        console.log(`[Reconcile] ${volatility_bucket}×${regime}×${r.strategy}: N ${before?.sample_count ?? 0}→${r.n} ` +
          `WR ${((before?.win_rate || 0) * 100).toFixed(0)}→${(win_rate * 100).toFixed(0)}% active ${before?.active ?? 0}→${active}`)
      }
    }
  })
  apply()
  console.log(`[Reconcile] ${rows.length} pattern(s) recomputed, ${changed} changed; ${unlinked?.n ?? 0} unlinked outcome(s) not in source`)
  return { patterns: rows.length, changed, unlinked: unlinked?.n ?? 0 }
}

function init() {
  bus.onSlow('pattern_reconciliation', () => {
    try { reconcilePatterns() } catch (e) { console.error('[Reconcile] error:', e.message) }
  })
  console.log('[Reconcile] ready')
}

module.exports = { init, reconcilePatterns }
