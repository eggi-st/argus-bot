'use strict'
// Phase 3b — deterministic self-diagnosis.
// Turns screening_rejections + per-strategy eligibility failures (decisions.strategy_scores_json)
// over a sustained window into capability_gaps rows. Separates STRUCTURAL blind spots
// (e.g. limit_order can never qualify — missing ATH indicator) from TUNABLE saturation
// (e.g. spot blocked by vol>cap). No LLM, no decision/config writes — read + classify only.
const bus = require('../core/event-bus')
const db  = require('../db/database')
const { getConfig } = require('../config')
const { openOrUpdateGap, resolveStaleGaps } = require('../db/schema')

// Map a free-text reject/ineligibility reason to a stable key (numbers stripped so thresholds
// changing the wording does not fork the key). Keep in sync with screener/router reason strings.
function normalizeReason(reason) {
  const r = String(reason || '').toLowerCase().replace(/[0-9]+(\.[0-9]+)?/g, '#')
  if (r.includes('ath')) return 'no_ath_data'
  if (r.includes('unusable volatility') || r.includes('volatility data')) return 'vol_data_missing'
  if (r.includes('volatility') && r.includes('>')) return 'vol_over_cap'
  if (r.includes('not sol') || (r.includes('quote') && r.includes('sol'))) return 'quote_not_sol'
  if (r.includes('fee/tvl') || r.includes('fee_tvl') || r.includes('feetvl')) return 'fee_tvl_below_min'
  if (r.includes('token age') && r.includes('<')) return 'token_too_young'
  if (r.includes('token age') && r.includes('>')) return 'token_too_old'
  if (r.includes('mcap')) return 'mcap_out_of_range'
  if (r.includes('holders')) return 'holders_below_min'
  if (r.includes('organic')) return 'organic_below_min'
  if (r.includes('bin_step') || r.includes('bin step')) return 'bin_step_out_of_range'
  if (r.includes('tvl')) return 'tvl_out_of_range'
  if (r.includes('yield-trap') || r.includes('yield trap')) return 'fee_tvl_yield_trap'
  if (r.includes('not eligible') || r.includes('no eligible')) return 'not_eligible'
  return r.replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'unknown'
}

function classify(reasonKey, strategy, ratio) {
  switch (reasonKey) {
    case 'no_ath_data':
      return { kind: 'missing_indicator', severity: ratio >= 0.99 ? 'high' : 'medium',
        action: `Strategy "${strategy}" can never qualify without ATH/price-history data — OKX returns no maxPrice for fresh tokens. Wire a second source (Birdeye/Dexscreener) before expecting ${strategy} samples.` }
    case 'vol_over_cap':
      return { kind: 'threshold_saturation', severity: 'medium',
        action: `Most candidates exceed the volatility cap for "${strategy}". Verify its dedicated pipeline universe, or consider raising the cap (auto-tuner territory once data exists).` }
    case 'fee_tvl_below_min': case 'fee_tvl_yield_trap':
      return { kind: 'threshold_saturation', severity: 'low',
        action: `Many candidates fall outside the fee/TVL band for "${strategy}".` }
    case 'vol_data_missing':
      return { kind: 'data_quality', severity: 'medium',
        action: 'Volatility data missing/unusable for many pools — check the volatility-timeframe source.' }
    case 'quote_not_sol': case 'token_too_old': case 'token_too_young':
      return { kind: 'universe_mismatch', severity: 'low', action: 'Expected-by-design universe filtering.' }
    default:
      return { kind: 'universe_mismatch', severity: 'low', action: 'Sustained eligibility failure for this reason.' }
  }
}

const bucketOf = ts => String(ts || '').slice(0, 16)  // minute precision ≈ one scan

/**
 * Per-strategy eligibility saturation from decisions.strategy_scores_json over the window.
 * Each decision scored all strategies, so this captures e.g. limit_order ineligible ~100%.
 */
function eligibilityGaps(windowStart, D) {
  const rows = db.prepare(
    `SELECT created_at, strategy_scores_json FROM decisions WHERE created_at >= ?`
  ).all(windowStart)
  // tally[strategy] = { denom, scans:Set, fails:{reasonKey:{count,scans:Set}} }
  const tally = {}
  for (const row of rows) {
    let scores
    try { scores = JSON.parse(row.strategy_scores_json) } catch { continue }
    if (!Array.isArray(scores)) continue
    const bucket = bucketOf(row.created_at)
    for (const s of scores) {
      if (!s || !s.strategy) continue
      const t = tally[s.strategy] || (tally[s.strategy] = { denom: 0, scans: new Set(), fails: {} })
      t.denom++
      t.scans.add(bucket)
      if (s.eligible === false) {
        const key = normalizeReason(s.reason)
        const f = t.fails[key] || (t.fails[key] = { count: 0, scans: new Set() })
        f.count++; f.scans.add(bucket)
      }
    }
  }
  const gaps = []
  for (const [strategy, t] of Object.entries(tally)) {
    if (t.denom < D.minDenominator) continue
    // dominant failure reason for this strategy
    let best = null
    for (const [key, f] of Object.entries(t.fails)) {
      if (!best || f.count > best.f.count) best = { key, f }
    }
    if (!best) continue
    const ratio = best.f.count / t.denom
    const scans = best.f.scans.size
    if (ratio >= D.saturationRatio && scans >= D.minScans) {
      gaps.push({ stream: 'eligibility', strategy, reasonKey: best.key, ratio, denom: t.denom, scans, observation: best.f.count })
    }
  }
  return gaps
}

/** Screener-level reason saturation (which filters shape the universe). */
function screeningGaps(windowStart, D) {
  const rows = db.prepare(
    `SELECT reason, scanned_at FROM screening_rejections WHERE scanned_at >= ?`
  ).all(windowStart)
  const total = rows.length
  if (total < D.minDenominator) return []
  const byKey = {}
  for (const row of rows) {
    const key = normalizeReason(row.reason)
    const k = byKey[key] || (byKey[key] = { count: 0, scans: new Set() })
    k.count++; k.scans.add(bucketOf(row.scanned_at))
  }
  const gaps = []
  for (const [key, k] of Object.entries(byKey)) {
    const ratio = k.count / total
    if (ratio >= D.saturationRatio && k.scans.size >= D.minScans) {
      gaps.push({ stream: 'screening', strategy: null, reasonKey: key, ratio, denom: total, scans: k.scans.size, observation: k.count })
    }
  }
  return gaps
}

function runDiagnosis(nowIso) {
  const cfg = getConfig()
  const D = cfg.learning?.diagnosis || {}
  if (D.enabled === false) return { gaps: 0, opened: 0 }
  const now = nowIso || new Date().toISOString()
  const windowStart = new Date(Date.parse(now) - (D.windowHours ?? 24) * 3_600_000).toISOString()

  const candidates = [...eligibilityGaps(windowStart, D), ...screeningGaps(windowStart, D)]
  const newlyOpened = []

  const apply = db.transaction(() => {
    for (const c of candidates) {
      const cls = classify(c.reasonKey, c.strategy, c.ratio)
      const signature = `${cls.kind}|${c.reasonKey}|${c.strategy || '-'}`
      const res = openOrUpdateGap({
        signature, kind: cls.kind, reason_key: c.reasonKey, strategy: c.strategy,
        severity: cls.severity, saturation_pct: Math.round(c.ratio * 1000) / 10,
        denominator: c.denom, sustained_scans: c.scans, observation_count: c.observation,
        first_seen_at: now, last_seen_at: now,
        evidence_json: JSON.stringify({ stream: c.stream, ratio: c.ratio, denom: c.denom, scans: c.scans }),
        suggested_action: cls.action,
      })
      if (res.inserted) newlyOpened.push({ signature, ...cls, ...c })
    }
    resolveStaleGaps(windowStart)  // gaps not re-seen in the window are auto-resolved
  })
  apply()

  for (const g of newlyOpened) {
    bus.emitSafe('capability_gap_detected', {
      signature: g.signature, kind: g.kind, severity: g.severity,
      strategy: g.strategy, reason_key: g.reasonKey, saturation_pct: Math.round(g.ratio * 1000) / 10,
      suggested_action: g.action,
    })
  }
  console.log(`[Diagnosis] ${candidates.length} saturated reason(s), ${newlyOpened.length} new gap(s) opened`)
  return { gaps: candidates.length, opened: newlyOpened.length }
}

function init() {
  bus.onSlow('capability_diagnosis', () => {
    try { runDiagnosis() } catch (e) { console.error('[Diagnosis] error:', e.message) }
  })
  // HIGH-severity gaps fire an immediate Telegram alert; everything else rides the daily report.
  bus.onSlow('capability_gap_detected', (g) => {
    if (g?.severity === 'high') {
      try { require('../notifications/telegram').capabilityAlert(g) } catch {}
    }
  })
  console.log('[Diagnosis] ready')
}

module.exports = { init, runDiagnosis, normalizeReason, classify }
