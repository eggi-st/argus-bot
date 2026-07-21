'use strict'
// Regime-risk OBSERVATORY — recomputes the (volatility × market-regime) → outcome map on a rolling
// window and tracks which cells carry a STABLE, tail-heavy negative edge worth sizing down.
//
// Why monitoring-only: validated 2026-07-21 that the aggregate map separates but per-cell EV FLIPS
// SIGN across time-thirds at current sample sizes — the signal is noise until more data accrues. So
// a cell only becomes 'brake_ready' after passing the brake gate for graduateStreak consecutive
// recomputes. In mode 'observatory' the size_factor is advisory (exposed, never applied); only mode
// 'live' means a consumer (Meridian) should honor it.

const bus = require('../core/event-bus')
const db  = require('../db/database')
const { getConfig } = require('../config')
const { upsertRegimeRisk, getRegimeRiskCell } = require('../db/schema')

const regimeOf = cb => { const m = String(cb || '').match(/froth|neutral|decline|recovery/); return m ? m[0] : null }
const volOf = cb => {
  const s = String(cb || '')
  if (/^high/.test(s))   return 'high'
  if (/^medium/.test(s)) return 'medium'
  if (/^low/.test(s))    return 'low'
  return null
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

// Wilson lower bound on a proportion (z=1.0, matching learning.confidenceGate).
function wilsonLB(wins, n, z = 1.0) {
  if (!n) return null
  const p = wins / n
  const d = 1 + z * z / n
  const c = p + z * z / (2 * n)
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return (c - s) / d
}

function recompute() {
  const cfg = getConfig().regimeRisk || {}
  const windowDays     = cfg.windowDays     ?? 90
  const minSamples     = cfg.minSamples     ?? 25
  const tailRatePct    = cfg.tailRatePct    ?? 4.0
  const graduateStreak = cfg.graduateStreak ?? 3
  const brakeFactor    = cfg.brakeFactor    ?? 0.5
  const mode           = cfg.mode           || 'observatory'

  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT condition_bucket AS cb, pnl_pct AS p, created_at AS t
    FROM feedback_outcomes
    WHERE pnl_pct IS NOT NULL AND condition_bucket IS NOT NULL AND created_at >= ?
  `).all(since)

  const cells = new Map()
  for (const r of rows) {
    const vol = volOf(r.cb), reg = regimeOf(r.cb)
    if (!vol || !reg) continue
    const key = `${vol}|${reg}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push({ p: r.p, t: r.t })
  }

  const now = new Date().toISOString()
  let brakeReady = 0, watching = 0, immature = 0
  const tx = db.transaction(() => {
    for (const [key, set] of cells) {
      const [vol_bucket, regime] = key.split('|')
      set.sort((a, b) => (a.t < b.t ? -1 : 1))
      const ps = set.map(x => x.p)
      const n = ps.length
      const ev = +mean(ps).toFixed(3)
      const wins = ps.filter(x => x > 0).length
      const win_rate = +(wins / n).toFixed(3)
      const wilson_lb = +(100 * wilsonLB(wins, n)).toFixed(1)
      const tail_rate = +(100 * ps.filter(x => x <= -8).length / n).toFixed(1)

      // Stability: split the window into time-thirds; a brake candidate must be NEGATIVE in all three.
      const k = Math.floor(n / 3)
      const thirds = k >= 1 ? [mean(ps.slice(0, k)), mean(ps.slice(k, 2 * k)), mean(ps.slice(2 * k))] : [ev, ev, ev]
      const sign_stable = thirds.every(x => x < 0) ? 1 : 0

      const gate_pass = (n >= minSamples && ev < 0 && tail_rate >= tailRatePct && sign_stable) ? 1 : 0

      const prior = getRegimeRiskCell(vol_bucket, regime)
      const stable_streak = gate_pass ? (prior?.stable_streak ?? 0) + 1 : 0
      const maturity = stable_streak >= graduateStreak ? 'brake_ready' : (gate_pass ? 'watching' : 'immature')
      // Advisory only. Even 'brake_ready' size_factor stays 1.0 until mode === 'live'.
      const size_factor = (maturity === 'brake_ready' && mode === 'live') ? brakeFactor : 1.0

      if (maturity === 'brake_ready') brakeReady++
      else if (maturity === 'watching') watching++
      else immature++

      upsertRegimeRisk({
        vol_bucket, regime, updated_at: now, window_days: windowDays, n, ev, win_rate,
        wilson_lb, tail_rate, sign_stable, gate_pass, stable_streak, maturity, size_factor,
      })
    }
  })
  tx()

  console.log(`[RegimeObservatory] mode=${mode} cells=${cells.size} — brake_ready=${brakeReady} watching=${watching} immature=${immature} (window ${windowDays}d, ${rows.length} outcomes)`)
  return { cells: cells.size, brakeReady, watching, immature }
}

function init() {
  bus.onSlow('regime_observatory', () => {
    try { recompute() }
    catch (e) { console.error('[RegimeObservatory] recompute error:', e.message) }
  })
  console.log('[RegimeObservatory] Ready')
}

module.exports = { init, recompute }
