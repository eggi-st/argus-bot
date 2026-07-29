'use strict'
// Cross-strategy score normalisation.
//
// THE PROBLEM. Every strategy in strategy-router.js scores on its own invented scale, and the
// scales disagree about what is even good. spot uses `max(0, 1 - vol/maxVol)` — volatility
// PUNISHES it. bid_ask uses `min(1, vol/3)` — the same volatility REWARDS it. Measured over
// 3656 decisions, the raw score distributions barely overlap:
//
//   strategy      p10    p50    p90
//   spot         0.20   0.36   0.57
//   bid_ask      0.26   0.71   1.00
//   limit_order  0.50   0.76   0.80
//
// Those numbers were then treated as one shared currency by everything downstream: Argus's own
// learning.confidenceGate.minConfidence floor, Meridian's argus.signalThreshold, the dashboard,
// the alerts and the LLM prompt. So a single threshold silently became a STRATEGY filter. At
// 0.65 it passed 67.8% of limit_order, 53.5% of bid_ask — and 5.1% of spot, which is the best
// real performer of the three (62.1% win rate against bid_ask's 55.8%).
//
// THE FIX. Map each raw score to its percentile within its OWN strategy's historical
// distribution. "0.8" then means "better than 80% of what this strategy normally scores",
// which is the same claim regardless of strategy. Simulated on the same 3656 decisions, the
// 0.65 threshold goes from 5.1/53.5/67.8% to 34.0/34.4/26.9% — near-neutral, as a percentile
// scale should be.
//
// WHAT THIS DOES NOT DO. It does not make confidence PREDICTIVE. Confidence has no measurable
// relationship with real outcomes (Spearman 0.083, p=0.41, n=102 — see the warning in the
// config's meridian block), and normalisation cannot manufacture signal that is not there.
// Calibrating score → P(win) is the fix that would, but it is not buildable: bid_ask and
// limit_order have ZERO decisions linked to a real outcome, so there is nothing to fit. This
// removes a systematic bias; it does not add information.

const db = require('../db/database')

// Sorted raw-score array per strategy, rebuilt at most once per refreshMs. Rebuilding on every
// pool would run ~90 queries per scan (30 pools x 3 pipelines) for a distribution that moves
// on the scale of days.
const _cache = new Map()   // strategy → { sorted: number[], builtAt: number }

function loadDistribution(strategy, cfg) {
  const N = cfg?.scoring?.normalize || {}
  const refreshMs = (N.refreshMinutes ?? 60) * 60_000
  const windowDays = N.windowDays ?? 30

  const hit = _cache.get(strategy)
  if (hit && (Date.now() - hit.builtAt) < refreshMs) return hit.sorted

  let sorted = []
  try {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    sorted = db.prepare(`
      SELECT raw_score FROM decisions
      WHERE strategy = ? AND raw_score IS NOT NULL AND created_at >= ?
      ORDER BY raw_score ASC
    `).all(strategy, cutoff).map(r => r.raw_score)
  } catch { sorted = [] }

  _cache.set(strategy, { sorted, builtAt: Date.now() })
  return sorted
}

/**
 * Raw strategy score → cross-strategy-comparable percentile in [0,1].
 *
 * Returns the RAW score unchanged when normalisation is off, or when this strategy has fewer
 * than minSamples historical scores — an empirical percentile off a handful of points is noise,
 * and a cold start must not be reshaped by three data points.
 *
 * Ties matter here: limit_order's scores cluster tightly, so a midpoint rank (rather than a
 * lower-bound rank) keeps a run of identical scores centred instead of pinning them all to the
 * bottom of their own tie group.
 */
function normalizeScore(strategy, rawScore, cfg) {
  const N = cfg?.scoring?.normalize || {}
  if (N.enabled === false) return rawScore
  if (!strategy || !Number.isFinite(rawScore)) return rawScore

  const minSamples = N.minSamples ?? 50
  const sorted = loadDistribution(strategy, cfg)
  if (sorted.length < minSamples) return rawScore

  // Rank via binary search on both tie edges, then take the midpoint of the tie block.
  let lo = 0, hi = sorted.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < rawScore) lo = m + 1; else hi = m }
  const first = lo
  lo = 0; hi = sorted.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= rawScore) lo = m + 1; else hi = m }
  const last = lo

  const pct = ((first + last) / 2) / sorted.length
  return Math.min(1, Math.max(0, Math.round(pct * 1000) / 1000))
}

/** Drop cached distributions — used by tests and after a bulk backfill. */
function resetCache() { _cache.clear() }

module.exports = { normalizeScore, resetCache }
