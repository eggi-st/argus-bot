'use strict'
const db = require('../db/database')

function getPattern(volatilityBucket, regime, strategy, feeBucket = 'medium', ageBucket = 'new') {
  return db.prepare(`
    SELECT win_rate, mean_pnl_net, sample_count, active, wins, ema_win_rate, source,
           avg_win_pnl, avg_loss_pnl
    FROM pattern_library
    WHERE volatility_bucket = ? AND regime = ? AND strategy = ?
      AND fee_bucket = ? AND age_bucket = ?
    LIMIT 1
  `).get(volatilityBucket, regime, strategy, feeBucket, ageBucket)
}

/**
 * Per-strategy base win rate — the shrinkage target for adjustScore. NOT 0.5, so genuinely-bad
 * strategies are not flattered by a neutral coin-flip prior.
 *
 * REAL outcomes first, simulation only as a fallback. This used to read dry_run_positions
 * unconditionally, which meant a REAL-backed pattern was shrunk toward a SIMULATED base rate —
 * the last path by which dry-run numbers still reached live confidence, after adjustScore and
 * checkPatternGate were both taught to distrust them.
 *
 * The two corpora disagree materially (measured 2026-07-28): spot is 62.1% real vs 88.0% sim
 * among filled positions, bid_ask 55.8% vs 69.9%. Shrinking a real pattern toward the sim
 * number pulled thin patterns toward an optimism reality does not support.
 *
 * The sim fallback now excludes NO-FILLS (net and gross both exactly 0). 44% of closed dry runs
 * are no-fills, and counting them as losses is what made the raw sim win rate read 35% for spot
 * when its filled positions win 88% — an artefact, not a measurement. Reality has almost no
 * equivalent (8 of 393 real spot outcomes are exactly 0), so including them made the fallback
 * incomparable to the real rate it stands in for.
 */
function getBaseRate(strategy, cfg) {
  const L = (cfg && cfg.learning) || {}
  const minSamples = L.baseRateMinSamples ?? 30
  const fallback   = L.baseRateFallback ?? 0.5
  if (!strategy) return fallback

  // 1. REAL outcomes (Meridian executions) — what confidence is ultimately judged against.
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n, SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins
      FROM feedback_outcomes
      WHERE strategy = ? AND pnl_pct IS NOT NULL
    `).get(strategy)
    if (r && (r.n ?? 0) >= minSamples) return (r.wins ?? 0) / r.n
  } catch { /* fall through to sim */ }

  // 2. SIM fallback — filled positions only.
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n, SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins
      FROM dry_run_positions
      WHERE strategy = ? AND status = 'closed' AND outcome_valid = 1
        AND NOT (net_pnl_pct = 0 AND gross_pnl_pct = 0)
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
  // Win-rate shrinkage (unchanged): shrinks toward per-strategy base rate on thin data.
  const wrScore = denom > 0 ? (N / denom) * ema + (k / denom) * r0 : r0

  // Payoff quality term: payoff_ratio = avg_win / |avg_loss|.
  // Normalize via ratio/(ratio+1) → [0,1]: ratio=1 maps to 0.5 (neutral), >1 is better.
  // Falls back to 0.5 (neutral) when data is missing so thin patterns are never penalised.
  let payoffNorm = 0.5
  if (pattern.avg_win_pnl != null && pattern.avg_loss_pnl != null && pattern.avg_loss_pnl < 0) {
    const ratio = pattern.avg_win_pnl / Math.abs(pattern.avg_loss_pnl)
    payoffNorm = Math.min(1, Math.max(0, ratio / (ratio + 1)))
  }

  // Historical score = 70% win-rate momentum + 30% payoff quality.
  // This makes the confidence directly sensitive to risk/reward, not just frequency of wins.
  const historicalScore = 0.7 * wrScore + 0.3 * payoffNorm
  const adjusted = rawScore * (1 - w) + historicalScore * w
  return Math.min(1, Math.max(0, adjusted))
}

/**
 * One-line context string for the LLM prompt / dashboard.
 */
function getPatternContext(volatilityBucket, regime, strategy, cfg, feeBucket = 'medium', ageBucket = 'new') {
  const threshold = cfg?.learning?.promotionThreshold ?? 60
  const p = getPattern(volatilityBucket, regime, strategy, feeBucket, ageBucket)
  if (!p || p.sample_count === 0) return 'No historical data yet'
  if (!p.active) return `Calibrating (N=${p.sample_count}/${threshold})`
  const wr  = (p.win_rate * 100).toFixed(0)
  const pnl = p.mean_pnl_net >= 0 ? `+${p.mean_pnl_net.toFixed(1)}` : p.mean_pnl_net.toFixed(1)
  // Label the provenance. This string goes into the LLM prompt and the dashboard, and a
  // sim-backed cell rendered as bare "Win 88%" reads as validated history when it is really
  // paper-trade output that neither adjustScore nor checkPatternGate is willing to act on.
  const src = p.source === 'sim' ? ' [simulated]' : ''
  return `Win ${wr}%, avg ${pnl}% (N=${p.sample_count})${src}`
}

module.exports = { getPattern, adjustScore, getBaseRate, getPatternContext }
