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
  const threshold      = cfg.learning?.promotionThreshold ?? 60
  const minRealSamples = cfg.learning?.minRealSamples ?? 20
  const now = new Date().toISOString()

  // SIM rollup — dry-run outcomes, keyed by the decision's bucket (the legacy source).
  // win_pnl_sum / loss_pnl_sum are conditional totals used to compute per-bucket avg_win/loss_pnl.
  const simRows = db.prepare(`
    SELECT d.condition_bucket AS bucket, dr.strategy AS strategy,
           COUNT(*) AS n,
           SUM(CASE WHEN dr.net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(dr.net_pnl_pct) AS mean_pnl,
           SUM(CASE WHEN dr.net_pnl_pct > 0 THEN dr.net_pnl_pct ELSE 0 END) AS win_pnl_sum,
           SUM(CASE WHEN dr.net_pnl_pct <= 0 THEN dr.net_pnl_pct ELSE 0 END) AS loss_pnl_sum
    FROM dry_run_positions dr
    JOIN decisions d ON d.id = dr.decision_id
    WHERE dr.status = 'closed' AND dr.outcome_valid = 1 AND d.condition_bucket IS NOT NULL
    GROUP BY d.condition_bucket, dr.strategy
  `).all()

  // REAL rollup — actual Meridian executions (feedback_outcomes). Exclude spot_lo so the
  // pure 'spot' learner stays clean (consistent with the Spot-LO routing decision).
  const realRows = db.prepare(`
    SELECT condition_bucket AS bucket, strategy AS strategy,
           COUNT(*) AS n,
           SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
           AVG(pnl_pct) AS mean_pnl,
           SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END) AS win_pnl_sum,
           SUM(CASE WHEN pnl_pct <= 0 THEN pnl_pct ELSE 0 END) AS loss_pnl_sum
    FROM feedback_outcomes
    WHERE condition_bucket IS NOT NULL AND strategy IN ('spot','bid_ask','limit_order')
    GROUP BY condition_bucket, strategy
  `).all()

  // Merge both rollups keyed on the PARSED pattern (vol×regime×strategy) — different raw
  // condition_bucket strings can map to the same (vol,regime), so accumulate by parsed key.
  const merged = new Map()
  const addRow = (r, kind) => {
    const { volatility_bucket, regime } = parseBucket(r.bucket)
    if (!volatility_bucket || !regime) return
    const key = `${volatility_bucket}::${regime}::${r.strategy}`
    let e = merged.get(key)
    if (!e) { e = { volatility_bucket, regime, strategy: r.strategy, sim: null, real: null }; merged.set(key, e) }
    if (!e[kind]) e[kind] = { n: 0, wins: 0, sumPnl: 0, winPnlSum: 0, lossPnlSum: 0 }
    e[kind].n        += r.n
    e[kind].wins     += r.wins
    e[kind].sumPnl   += (r.mean_pnl || 0) * r.n
    e[kind].winPnlSum  += r.win_pnl_sum  || 0
    e[kind].lossPnlSum += r.loss_pnl_sum || 0
  }
  for (const r of simRows)  addRow(r, 'sim')
  for (const r of realRows) addRow(r, 'real')

  let changed = 0, realCount = 0, simCount = 0
  const apply = db.transaction(() => {
    for (const m of merged.values()) {
      const { volatility_bucket, regime } = m
      const sim  = m.sim  ? { ...m.sim,  mean_pnl: m.sim.n  ? m.sim.sumPnl  / m.sim.n  : 0,
                                          winPnlSum: m.sim.winPnlSum, lossPnlSum: m.sim.lossPnlSum } : null
      const real = m.real ? { ...m.real, mean_pnl: m.real.n ? m.real.sumPnl / m.real.n : 0,
                                          winPnlSum: m.real.winPnlSum, lossPnlSum: m.real.lossPnlSum } : null
      const simWr  = sim  && sim.n  > 0 ? sim.wins  / sim.n  : null
      const realWr = real && real.n > 0 ? real.wins / real.n : null
      // Real-preferred: use REAL when it has enough samples, else SIM (flagged unverified).
      const useReal = real && real.n >= minRealSamples
      const source  = useReal ? 'real' : 'sim'
      const chosen  = useReal ? real : (sim || { n: 0, wins: 0, mean_pnl: 0 })
      const win_rate = chosen.n > 0 ? chosen.wins / chosen.n : 0
      // Only REAL-backed patterns are promoted to 'active' (drives confidence). Sim-only
      // patterns stay inactive → adjustScore treats them as neutral (no confidence boost).
      // useReal already requires real.n >= minRealSamples; promotion needs real.n >= threshold.
      // Was: Math.min(threshold, minRealSamples) = Math.min(45, 20) = 20 → threshold ignored.
      const active = (useReal && real.n >= threshold) ? 1 : 0
      if (useReal) realCount++; else simCount++
      const reality_gap = (realWr != null && simWr != null) ? (realWr - simWr) : null

      // EV decomposition: separate avg PnL for wins vs losses.
      // payoff_ratio = avg_win_pnl / |avg_loss_pnl| — blocks patterns with bad risk/reward
      // even when win_rate looks acceptable (e.g. wins +0.5%, losses -8% = terrible payoff).
      const lossCount = chosen.n - chosen.wins
      const avg_win_pnl  = chosen.wins   > 0 ? chosen.winPnlSum  / chosen.wins   : null
      const avg_loss_pnl = lossCount     > 0 ? chosen.lossPnlSum / lossCount      : null

      const before = db.prepare(
        `SELECT win_rate, sample_count, active, source FROM pattern_library WHERE volatility_bucket=? AND regime=? AND strategy=?`
      ).get(volatility_bucket, regime, m.strategy)
      recordPatternReconciled(volatility_bucket, regime, m.strategy, {
        updated_at: now, win_rate, mean_pnl_net: chosen.mean_pnl ?? 0,
        sample_count: chosen.n, wins: chosen.wins, active, last_reconciled_at: now,
        source,
        live_win_rate: realWr, live_mean_pnl: real?.mean_pnl ?? null, live_sample_count: real?.n ?? 0,
        sim_win_rate: simWr, sim_sample_count: sim?.n ?? 0, reality_gap,
        avg_win_pnl, avg_loss_pnl,
      })
      const moved = !before || before.sample_count !== chosen.n ||
        Math.abs((before.win_rate || 0) - win_rate) > 1e-9 || before.active !== active || before.source !== source
      if (moved) {
        changed++
        console.log(`[Reconcile] ${volatility_bucket}×${regime}×${m.strategy} [${source}]: N=${chosen.n} ` +
          `WR ${(win_rate * 100).toFixed(0)}% active=${active}` + (reality_gap != null ? ` gap ${(reality_gap*100).toFixed(0)}pp` : ''))
      }
    }
  })
  apply()
  console.log(`[Reconcile] ${merged.size} pattern(s); ${realCount} real-backed, ${simCount} sim-fallback; ${changed} changed`)
  return { patterns: merged.size, realCount, simCount, changed }
}

function init() {
  bus.onSlow('pattern_reconciliation', () => {
    try { reconcilePatterns() } catch (e) { console.error('[Reconcile] error:', e.message) }
  })
  console.log('[Reconcile] ready')
}

module.exports = { init, reconcilePatterns }
