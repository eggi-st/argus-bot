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
 * Per-strategy base win rate. NO LONGER ON THE CONFIDENCE PATH: it was the shrinkage target
 * for adjustScore, which the Tier-A prune neutralised. Kept because it is a correct, tested
 * read of the real-vs-sim base rate and is useful for analysis. NOT 0.5, so genuinely-bad
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
 * NEUTRALISED in the Tier-A prune (2026-08-20). Returns rawScore unchanged, always.
 *
 * WHY: the gate accumulated 255 real outcomes on both arms (Meridian trades regardless of the
 * verdict, so both a treated and an untreated arm exist). Pools Argus recommended returned
 * +0.05% mean / 64.0% win (n=139); pools it rejected returned +0.16% / 68.1% (n=116) — diff
 * -0.11pp, t = -0.46. Confidence-vs-outcome correlation over the same corpus is r = 0.028
 * (n=160), down from rho .083 at n=102: more data moved it toward zero, not away.
 *
 * The pattern library that fed this blend is itself mis-promoted — of its 10 active cells,
 * most carry a NEGATIVE mean_pnl_net (high/neutral/spot -0.20 over N=258, medium/neutral/bid_ask
 * -0.96 over N=102) despite 59-73% win rates, because promotion scores win-rate and the loss
 * tail eats the wins. Blending that into confidence propagates the same error.
 *
 * Patterns are still RECORDED and reconciled — the library remains the substrate for any future
 * analysis, and getPatternContext still renders it for the dashboard. It just no longer moves a
 * number that was measured not to predict anything. Restoring the blend means first showing, on
 * held-out real outcomes, that it beats not blending.
 *
 * The signature is preserved so callers and their confidence traces keep working.
 */
function adjustScore(rawScore, _pattern, _cfg, _strategy) {
  return rawScore
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
