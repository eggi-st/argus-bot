'use strict'

/**
 * Strategy router — pure, deterministic, no LLM.
 *
 * Scores the live strategies for a candidate pool:
 *   spot        — calm vol + moderate fee/TVL + clean signals  (84% win rate historical)
 *   bid_ask     — tail-safe default for high-vol / yield-trap zones
 *
 * limit_order was removed in the Tier-A prune (2026-08-20): zero live executions
 * across the whole corpus, so its only consumer was the dry-run simulator that
 * went with it.
 *
 * Spot/bid_ask logic ported from Meridian choose-strategy.js
 * (validated over 214 spot + 145 bid_ask closed positions, 2026-06-20).
 *
 * FAIL-SAFE: spot requires both vol + feeTvl present. Missing → bid_ask.
 */

function num(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Score the live strategies (spot + bid_ask).
 * @returns {{ strategy: string, eligible: boolean, score: number, reason: string }[]}
 */
function scoreStrategies(pool, config) {
  const sCfg = config?.strategy || {}

  const vol = num(pool?.volatility)
  const feeTvl = num(pool?.fee_active_tvl_ratio)
  const volTrend = pool?.volume_trend ?? null
  const entryPhase = pool?.entry_phase ?? null
  const devSoldAll = pool?.dev_sold_all ?? null

  const scores = []

  // ── SPOT ──────────────────────────────────────────────────────────────────
  {
    const maxVol = sCfg.spotMaxVolatility ?? 2
    const feeMin = sCfg.spotFeeTvlMin ?? 0.1
    const feeMax = sCfg.spotFeeTvlMax ?? 0.4

    let reason = null
    if (vol == null || feeTvl == null) reason = 'fail-safe: missing volatility/feeTvl'
    else if (vol > maxVol)                reason = `volatility ${vol} > ${maxVol}`
    else if (feeTvl < feeMin)             reason = `feeTvl ${feeTvl} < ${feeMin}`
    else if (feeTvl > feeMax)             reason = `feeTvl ${feeTvl} > ${feeMax} (yield-trap)`
    else if (volTrend === 'stable')       reason = 'volume_trend=stable'
    else if (entryPhase === 'price_spike') reason = 'entry_phase=price_spike'
    else if (devSoldAll === true)         reason = 'dev_sold_all'

    if (reason) {
      scores.push({ strategy: 'spot', eligible: false, score: 0, reason })
    } else {
      const volScore = Math.max(0, 1 - vol / maxVol)
      const mid = (feeMin + feeMax) / 2
      const halfRange = (feeMax - feeMin) / 2
      const feeTvlScore = halfRange > 0
        ? Math.max(0, 1 - Math.abs((feeTvl - mid) / halfRange))
        : 1
      const score = Math.round((volScore * 0.6 + feeTvlScore * 0.4) * 100) / 100
      scores.push({
        strategy: 'spot', eligible: true, score,
        reason: `vol=${vol}<=${maxVol}, feeTvl=${feeTvl} in [${feeMin}–${feeMax}]`,
      })
    }
  }

  // ── BID_ASK ───────────────────────────────────────────────────────────────
  // Always eligible as the tail-safe default (single-sided, tail-protected).
  {
    const volScore = vol != null ? Math.min(1, vol / 3) : 0.5
    const feeTvlScore = feeTvl != null ? Math.min(1, feeTvl / 0.3) : 0.5
    const score = Math.round((volScore * 0.5 + feeTvlScore * 0.5) * 100) / 100
    scores.push({
      strategy: 'bid_ask', eligible: true, score,
      reason: vol != null ? `vol=${vol}, feeTvl=${feeTvl}` : 'tail-safe default',
    })
  }

  return scores
}

/**
 * Pick the best eligible strategy.
 * @returns {{ strategy: string, score: number, reason: string, all_scores: any[] }}
 */
function chooseStrategy(pool, config) {
  const all = scoreStrategies(pool, config)
  const eligible = all.filter(s => s.eligible)

  if (!eligible.length) {
    const ba = all.find(s => s.strategy === 'bid_ask')
    return { strategy: 'bid_ask', score: ba?.score ?? 0, reason: 'fallback: no strategy qualified', all_scores: all }
  }

  const best = eligible.reduce((a, b) => b.score > a.score ? b : a)
  return { strategy: best.strategy, score: best.score, reason: best.reason, all_scores: all }
}

module.exports = { chooseStrategy, scoreStrategies }
