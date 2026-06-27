'use strict'
const db = require('../db/database')

function getPattern(volatilityBucket, regime, strategy) {
  return db.prepare(`
    SELECT win_rate, mean_pnl_net, sample_count, active, wins, ema_win_rate, source
    FROM pattern_library
    WHERE volatility_bucket = ? AND regime = ? AND strategy = ?
    LIMIT 1
  `).get(volatilityBucket, regime, strategy)
}

/**
 * Per-strategy base win rate from the reconcilable outcome stream (dry_run_positions only,
 * never decisions — avoids Meridian-unlinked skew). Falls back to a configured prior until
 * enough real outcomes exist. This is the shrinkage target — NOT 0.5 — so genuinely-bad
 * strategies are not flattered by a neutral coin-flip prior.
 */
function getBaseRate(strategy, cfg) {
  const L = (cfg && cfg.learning) || {}
  const minSamples = L.baseRateMinSamples ?? 30
  const fallback   = L.baseRateFallback ?? 0.5
  if (!strategy) return fallback
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n, SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins
      FROM dry_run_positions
      WHERE strategy = ? AND status = 'closed' AND outcome_valid = 1
    `).get(strategy)
    if (!r || (r.n ?? 0) < minSamples) return fallback
    return (r.wins ?? 0) / r.n
  } catch { return fallback }
}

/**
 * Blend the rule-based score with a sample-size-shrunk, EMA-weighted historical win rate.
 *   p_score  = N/(N+k)·ema_win_rate + k/(N+k)·baseRate   (shrinks toward base rate on thin N)
 *   adjusted = rawScore·(1−w) + p_score·w
 * Only applies once the pattern is ACTIVE (promoted); calibrating patterns return rawScore
 * unchanged so cold-start exploration is never damped. GATING uses cumulative Wilson, not this.
 */
function adjustScore(rawScore, pattern, cfg, strategy) {
  if (!pattern?.active) return rawScore
  // STEP 1: sim-backed patterns are NEUTRAL — never let an unverified (simulation-only)
  // win rate boost live confidence. Only REAL-outcome-backed patterns adjust the score.
  if (pattern.source === 'sim') return rawScore
  const L = (cfg && cfg.learning) || {}
  const w = L.patternWeight ?? 0.30
  const k = L.shrinkageK ?? 20
  const N = pattern.sample_count ?? 0
  const ema = pattern.ema_win_rate != null ? pattern.ema_win_rate : (pattern.win_rate ?? 0.5)
  const r0 = getBaseRate(strategy, cfg)
  const denom = N + k
  const pScore = denom > 0 ? (N / denom) * ema + (k / denom) * r0 : r0
  const adjusted = rawScore * (1 - w) + pScore * w
  return Math.min(1, Math.max(0, adjusted))
}

/**
 * One-line context string for the LLM prompt / dashboard.
 */
function getPatternContext(volatilityBucket, regime, strategy, cfg) {
  const threshold = cfg?.learning?.promotionThreshold ?? 60
  const p = getPattern(volatilityBucket, regime, strategy)
  if (!p || p.sample_count === 0) return 'No historical data yet'
  if (!p.active) return `Calibrating (N=${p.sample_count}/${threshold})`
  const wr  = (p.win_rate * 100).toFixed(0)
  const pnl = p.mean_pnl_net >= 0 ? `+${p.mean_pnl_net.toFixed(1)}` : p.mean_pnl_net.toFixed(1)
  return `Win ${wr}%, avg ${pnl}% (N=${p.sample_count})`
}

module.exports = { getPattern, adjustScore, getBaseRate, getPatternContext }
