'use strict'
// Portfolio-risk OBSERVATORY — measures whether Argus/Meridian outcomes are correlated, and
// whether enough positions are ever held at once for that correlation to matter.
//
// WHY THIS IS MONITORING AND NOT A BRAKE. Portfolio risk needs BOTH ingredients: outcomes that
// move together, AND several positions open at the same time. Measured 2026-07-29 on 594 real
// outcomes, neither is established:
//
//   overdispersion  1.64x independent   p = 0.099 (permutation)  → suggestive, not significant
//   peak concurrency  4 positions, ever   >=3 open only 0.5% of the time, median 1
//
// So a sizing rule today would be built on an insignificant correlation applied to a portfolio
// that is usually one position deep. That is precisely the mistake the regime observatory was
// created to avoid. This ships the measurement, gates hard on both dimensions, and emits no
// advice until both clear.
//
// A METHOD NOTE THAT CHANGES THE ANSWER. Event time must come from outcome_id (`pool:deployed_at`),
// NOT created_at. created_at is when Argus INGESTED the outcome, and a bulk backfill on
// 2026-06-26 landed 428 historical positions in one hour — which alone inflated the measured
// overdispersion from 1.6x to 5.2x and produced a phantom "428 concurrent positions". Deploy
// time is the real trade clock and needs no special-casing for imports.

const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')

// Deterministic PRNG so a recompute over unchanged data yields an identical p-value —
// a maturity streak must not advance or reset on shuffle luck.
function makeRng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}

/**
 * Overdispersion = observed variance of the per-day loss rate / the variance independent
 * Bernoulli draws would produce. 1.0 means indistinguishable from independence; >1 means
 * losses arrive in clusters.
 */
function overdispersionRatio(daySizes, labels) {
  const total = labels.length
  if (!total || !daySizes.length) return null
  let i = 0
  const rates = []
  for (const sz of daySizes) {
    const seg = labels.slice(i, i + sz); i += sz
    if (!seg.length) continue
    rates.push(seg.reduce((a, b) => a + b, 0) / seg.length)
  }
  if (rates.length < 2) return null
  const lossRate = labels.reduce((a, b) => a + b, 0) / total
  if (lossRate <= 0 || lossRate >= 1) return null
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  const varObs = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length
  const avgN = total / rates.length
  const varExp = lossRate * (1 - lossRate) / avgN
  return varExp > 0 ? varObs / varExp : null
}

/**
 * Permutation p-value: reshuffle which day each outcome fell on, keeping day sizes fixed, and
 * count how often chance alone produces clustering at least this strong.
 */
function permutationPValue(daySizes, labels, iterations, seed) {
  const observed = overdispersionRatio(daySizes, labels)
  if (observed == null) return { observed: null, pValue: null }
  const rng = makeRng(seed)
  const shuffled = labels.slice()
  let atLeast = 0
  for (let k = 0; k < iterations; k++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t
    }
    const r = overdispersionRatio(daySizes, shuffled)
    if (r != null && r >= observed) atLeast++
  }
  return { observed, pValue: (atLeast + 1) / (iterations + 1) }
}

/** Rows on the real trade clock, oldest first. */
function loadOutcomes(windowDays) {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  return db.prepare(`
    SELECT substr(outcome_id, instr(outcome_id, ':') + 1) AS deployed_at,
           minutes_held, pnl_pct
    FROM feedback_outcomes
    WHERE pnl_pct IS NOT NULL
      AND outcome_id LIKE '%:%'
      AND substr(outcome_id, instr(outcome_id, ':') + 1) >= ?
    ORDER BY deployed_at ASC
  `).all(cutoff).filter(r => /^\d{4}-\d{2}-\d{2}T/.test(r.deployed_at || ''))
}

/** Peak simultaneous positions, and what share of wall-clock time sat at or above a level. */
function concurrencyProfile(rows, atLeast) {
  const events = []
  for (const r of rows) {
    const open = Date.parse(r.deployed_at)
    if (!Number.isFinite(open)) continue
    const close = open + (r.minutes_held ?? 0) * 60_000
    events.push([open, 1], [close, -1])
  }
  if (!events.length) return { peak: 0, pctTimeAtOrAbove: 0 }
  events.sort((a, b) => a[0] - b[0])
  let cur = 0, peak = 0, spanHigh = 0, spanTotal = 0, last = events[0][0]
  for (const [t, delta] of events) {
    if (t > last) { spanTotal += t - last; if (cur >= atLeast) spanHigh += t - last; last = t }
    cur += delta
    if (cur > peak) peak = cur
  }
  return { peak, pctTimeAtOrAbove: spanTotal > 0 ? (100 * spanHigh) / spanTotal : 0 }
}

function computeSnapshot(cfg) {
  const P = cfg.portfolioRisk || {}
  const windowDays  = P.windowDays  ?? 90
  const minPerDay   = P.minOutcomesPerDay ?? 4
  const iterations  = P.permutations ?? 5000
  const concLevel   = P.concurrencyLevel ?? 3

  const rows = loadOutcomes(windowDays)
  const byDay = new Map()
  for (const r of rows) {
    const day = r.deployed_at.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(r.pnl_pct < 0 ? 1 : 0)
  }
  // Days with too few outcomes make the per-day loss rate almost pure noise.
  const days = [...byDay.entries()].filter(([, v]) => v.length >= minPerDay).sort()
  const daySizes = days.map(([, v]) => v.length)
  const labels   = days.flatMap(([, v]) => v)

  const { observed, pValue } = permutationPValue(daySizes, labels, iterations, P.seed ?? 20260729)
  const conc = concurrencyProfile(rows, concLevel)

  return {
    window_days:   windowDays,
    n_outcomes:    labels.length,
    n_days:        days.length,
    loss_rate:     labels.length ? labels.reduce((a, b) => a + b, 0) / labels.length : null,
    overdispersion: observed != null ? Math.round(observed * 1000) / 1000 : null,
    p_value:        pValue != null ? Math.round(pValue * 10000) / 10000 : null,
    peak_concurrency: conc.peak,
    pct_time_concurrent: Math.round(conc.pctTimeAtOrAbove * 100) / 100,
  }
}

/**
 * Recompute and persist. The gate needs BOTH dimensions: correlation that is statistically
 * real, AND enough simultaneous exposure for it to cost anything. Either one alone is
 * harmless — perfectly correlated outcomes across a one-position portfolio are just outcomes.
 */
function runObservatory() {
  const cfg = getConfig()
  const P = cfg.portfolioRisk || {}
  if (P.mode === 'off') return null

  const minOutcomes    = P.minOutcomes ?? 200
  const minDays        = P.minDays ?? 30
  const alpha          = P.alpha ?? 0.05
  const minPeak        = P.minPeakConcurrency ?? 3
  const minPctTime     = P.minPctTimeConcurrent ?? 5
  const graduateStreak = P.graduateStreak ?? 3

  const s = computeSnapshot(cfg)

  const enoughData   = s.n_outcomes >= minOutcomes && s.n_days >= minDays
  const correlated   = s.p_value != null && s.p_value < alpha && s.overdispersion > 1
  const concentrated = s.peak_concurrency >= minPeak && s.pct_time_concurrent >= minPctTime
  const gatePass     = enoughData && correlated && concentrated ? 1 : 0

  const prior = db.prepare(`SELECT stable_streak FROM portfolio_risk WHERE id = 1`).get()
  const stableStreak = gatePass ? (prior?.stable_streak ?? 0) + 1 : 0
  const maturity = stableStreak >= graduateStreak ? 'advisory_ready' : (gatePass ? 'watching' : 'immature')

  // Advisory only. Even 'advisory_ready' emits no cap until mode === 'live'.
  const advisedMaxConcurrent = (maturity === 'advisory_ready' && P.mode === 'live')
    ? (P.advisedMaxConcurrent ?? 2)
    : null

  db.prepare(`
    INSERT INTO portfolio_risk
      (id, updated_at, window_days, n_outcomes, n_days, loss_rate, overdispersion, p_value,
       peak_concurrency, pct_time_concurrent, gate_pass, stable_streak, maturity,
       advised_max_concurrent, blocking_reason)
    VALUES (1, @updated_at, @window_days, @n_outcomes, @n_days, @loss_rate, @overdispersion,
       @p_value, @peak_concurrency, @pct_time_concurrent, @gate_pass, @stable_streak, @maturity,
       @advised_max_concurrent, @blocking_reason)
    ON CONFLICT(id) DO UPDATE SET
      updated_at=excluded.updated_at, window_days=excluded.window_days,
      n_outcomes=excluded.n_outcomes, n_days=excluded.n_days, loss_rate=excluded.loss_rate,
      overdispersion=excluded.overdispersion, p_value=excluded.p_value,
      peak_concurrency=excluded.peak_concurrency, pct_time_concurrent=excluded.pct_time_concurrent,
      gate_pass=excluded.gate_pass, stable_streak=excluded.stable_streak,
      maturity=excluded.maturity, advised_max_concurrent=excluded.advised_max_concurrent,
      blocking_reason=excluded.blocking_reason
  `).run({
    ...s,
    updated_at: new Date().toISOString(),
    gate_pass: gatePass,
    stable_streak: stableStreak,
    maturity,
    advised_max_concurrent: advisedMaxConcurrent,
    // List EVERY unmet condition, not just the first. Both dimensions are usually failing at
    // once, and reporting only the correlation would imply that a p-value dropping under alpha
    // is all that stands in the way — when shallow exposure would still block on its own.
    blocking_reason: gatePass ? null : [
      !enoughData   && `thin data (${s.n_outcomes}/${minOutcomes} outcomes, ${s.n_days}/${minDays} days)`,
      !correlated   && `clustering not significant (ratio ${s.overdispersion}, p=${s.p_value} >= ${alpha})`,
      !concentrated && `exposure too shallow (peak ${s.peak_concurrency}/${minPeak}, ${s.pct_time_concurrent}% of time vs ${minPctTime}% needed)`,
    ].filter(Boolean).join(' · '),
  })

  console.log(`[PortfolioRisk] ratio=${s.overdispersion} p=${s.p_value} peak=${s.peak_concurrency} → ${maturity}`)
  return { ...s, maturity, gate_pass: gatePass, stable_streak: stableStreak }
}

function init() {
  bus.onSlow('portfolio_observatory', () => {
    try { runObservatory() }
    catch (e) { console.error('[PortfolioRisk] Observatory error:', e.message) }
  })
  console.log('[PortfolioRisk] Ready')
}

module.exports = { init, runObservatory, computeSnapshot, overdispersionRatio, permutationPValue, concurrencyProfile }
