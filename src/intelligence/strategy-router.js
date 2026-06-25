'use strict'

/**
 * Strategy router — pure, deterministic, no LLM.
 *
 * Scores all three strategies for a candidate pool:
 *   spot        — calm vol + moderate fee/TVL + clean signals  (84% win rate historical)
 *   bid_ask     — tail-safe default for high-vol / yield-trap zones
 *   limit_order — token has pulled back from ATH, low vol, strong organic
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
 * Score all three strategies.
 * @returns {{ strategy: string, eligible: boolean, score: number, reason: string }[]}
 */
function scoreStrategies(pool, config) {
  const sCfg = config?.strategy || {}
  const loCfg = config?.limitOrder || {}

  const vol = num(pool?.volatility)
  const feeTvl = num(pool?.fee_active_tvl_ratio)
  const volTrend = pool?.volume_trend ?? null
  const entryPhase = pool?.entry_phase ?? null
  const devSoldAll = pool?.dev_sold_all ?? null
  const priceVsAth = num(pool?.price_vs_ath_pct)
  const organic = num(pool?.organic_score)
  const holders = num(pool?.holders)
  const tvl = num(pool?.tvl)

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
      const score = Math.round((volScore * 60 + feeTvlScore * 40) * 100) / 100
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
    const score = Math.round((volScore * 50 + feeTvlScore * 50) * 100) / 100
    scores.push({
      strategy: 'bid_ask', eligible: true, score,
      reason: vol != null ? `vol=${vol}, feeTvl=${feeTvl}` : 'tail-safe default',
    })
  }

  // ── LIMIT ORDER ───────────────────────────────────────────────────────────
  // Only eligible when token has pulled back meaningfully from ATH but isn't dead.
  {
    const maxAth = loCfg.maxPriceVsAthPct ?? 70
    const minAth = loCfg.minPriceVsAthPct ?? 20
    const maxVol = loCfg.maxVolatility ?? 2.0
    const minOrg = loCfg.minOrganic ?? 50
    const minHld = loCfg.minHolders ?? 500
    const minTvlLo = loCfg.minTvl ?? 10_000

    let reason = null
    if (priceVsAth == null)                reason = 'no ATH price data'
    else if (priceVsAth > maxAth)          reason = `${priceVsAth}% ATH > ${maxAth}% (too close to ATH for LO)`
    else if (priceVsAth < minAth)          reason = `${priceVsAth}% ATH < ${minAth}% (potentially dead token)`
    else if (vol != null && vol > maxVol)  reason = `volatility ${vol} > ${maxVol} (too volatile for LO)`
    else if (organic != null && organic < minOrg) reason = `organic ${organic} < ${minOrg}`
    else if (holders != null && holders < minHld) reason = `holders ${holders} < ${minHld}`
    else if (tvl != null && tvl < minTvlLo)      reason = `TVL ${tvl} < ${minTvlLo}`

    if (reason) {
      scores.push({ strategy: 'limit_order', eligible: false, score: 0, reason })
    } else {
      // Deeper pullback = better LO setup (more margin before ATH resistance)
      const athRange = maxAth - minAth
      const pullback = maxAth - priceVsAth  // 0 = at maxAth, athRange = at minAth
      const pullbackScore = athRange > 0 ? Math.min(1, pullback / athRange) : 0.5
      const volScore = vol != null ? Math.max(0, 1 - vol / maxVol) : 0.5
      const orgScore = organic != null ? Math.min(1, organic / 100) : 0.5
      const score = Math.round((pullbackScore * 40 + volScore * 30 + orgScore * 30) * 100) / 100
      scores.push({
        strategy: 'limit_order', eligible: true, score,
        reason: `ath=${priceVsAth}%, vol=${vol}, organic=${organic}`,
      })
    }
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
