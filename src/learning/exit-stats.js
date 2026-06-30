'use strict'
// Tier 1-C — exit-technique learning. Recomputes exit_technique_stats from closed dry-run
// outcomes grouped by (strategy × exit_technique), making exit quality VISIBLE: which exit
// fires how often per strategy and how it performs. This closes the structural blind spot
// where exit_technique was recorded per close but never aggregated — the system learned only
// on final net P&L, never on "which exit was right for this condition."
//
// Additive + derived: full transactional rebuild each cycle (idempotent, like reconcile.js),
// does NOT touch the primary pattern_library learner. win_rate is computed on FILLED positions
// only (no-fills tracked separately as nofill_count); share_pct is over ALL closes so misses
// stay visible. Runs on the same pattern_reconciliation event as the pattern reconciler.
const bus = require('../core/event-bus')
const db  = require('../db/database')

function reconcileExitTechniques() {
  const now = new Date().toISOString()

  // Per (strategy, exit_technique): filled stats + no-fill count. exit_technique falls back to
  // close_reason then 'unknown' so legacy rows (null exit_technique, e.g. ttl_expired) still group.
  const rows = db.prepare(`
    SELECT strategy,
           COALESCE(exit_technique, close_reason, 'unknown') AS exit_technique,
           COUNT(*) AS total,
           SUM(CASE WHEN net_pnl_pct = 0 AND gross_pnl_pct = 0 THEN 1 ELSE 0 END) AS nofill,
           SUM(CASE WHEN NOT (net_pnl_pct = 0 AND gross_pnl_pct = 0) THEN 1 ELSE 0 END) AS filled,
           SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(CASE WHEN NOT (net_pnl_pct = 0 AND gross_pnl_pct = 0) THEN net_pnl_pct END) AS mean_pnl,
           AVG(hold_minutes) AS avg_hold
    FROM dry_run_positions
    WHERE status = 'closed' AND outcome_valid = 1 AND strategy IS NOT NULL
    GROUP BY strategy, COALESCE(exit_technique, close_reason, 'unknown')
  `).all()

  // Per-strategy totals for share_pct (denominator includes no-fills, so a high no-fill exit
  // share is visible as "this strategy misses a lot via price_ran_up").
  const stratTotal = new Map()
  for (const r of rows) stratTotal.set(r.strategy, (stratTotal.get(r.strategy) || 0) + r.total)

  const upsert = db.prepare(`
    INSERT INTO exit_technique_stats
      (updated_at, strategy, exit_technique, sample_count, wins, win_rate,
       mean_pnl_net, avg_hold_minutes, nofill_count, share_pct)
    VALUES (@updated_at, @strategy, @exit_technique, @sample_count, @wins, @win_rate,
       @mean_pnl_net, @avg_hold_minutes, @nofill_count, @share_pct)
    ON CONFLICT(strategy, exit_technique) DO UPDATE SET
      updated_at       = excluded.updated_at,
      sample_count     = excluded.sample_count,
      wins             = excluded.wins,
      win_rate         = excluded.win_rate,
      mean_pnl_net     = excluded.mean_pnl_net,
      avg_hold_minutes = excluded.avg_hold_minutes,
      nofill_count     = excluded.nofill_count,
      share_pct        = excluded.share_pct
  `)

  const rebuild = db.transaction(() => {
    db.prepare(`DELETE FROM exit_technique_stats`).run()  // full rebuild — drops vanished combos
    for (const r of rows) {
      const total = stratTotal.get(r.strategy) || 0
      upsert.run({
        updated_at:       now,
        strategy:         r.strategy,
        exit_technique:   r.exit_technique,
        sample_count:     r.filled,
        wins:             r.wins,
        win_rate:         r.filled > 0 ? r.wins / r.filled : null,
        mean_pnl_net:     r.mean_pnl != null ? Math.round(r.mean_pnl * 100) / 100 : null,
        avg_hold_minutes: r.avg_hold != null ? Math.round(r.avg_hold) : null,
        nofill_count:     r.nofill,
        share_pct:        total > 0 ? Math.round((r.total / total) * 1000) / 10 : null,
      })
    }
  })
  rebuild()

  console.log(`[ExitStats] rebuilt ${rows.length} (strategy × exit_technique) row(s)`)
  return { rows: rows.length }
}

function init() {
  bus.onSlow('pattern_reconciliation', () => {
    try { reconcileExitTechniques() } catch (e) { console.error('[ExitStats] error:', e.message) }
  })
  console.log('[ExitStats] ready')
}

module.exports = { init, reconcileExitTechniques }
