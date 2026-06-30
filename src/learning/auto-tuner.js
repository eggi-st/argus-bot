'use strict'
// Phase 4B — bounded auto-tuner. Ships OFF (learning.autoTuner.enabled=false). Proposes damped,
// clamped deltas to a whitelisted scalar config knob ONLY when reconciled per-strategy evidence
// is statistically significant (Wilson bound clears break-even by a hysteresis margin) AND a
// real-sample floor is met. SHADOW = propose+log+notify (NO write); APPLY = writeUserConfig,
// gated behind mode='apply' + a higher realSampleMin. Every action writes a tuning_events row.
//
// v1 acts on strategy.spotMaxVolatility only (clear directional semantics: spot proven good →
// widen the vol cap). Gate-floor params are whitelisted but deferred. All five damping mechanisms
// are present: unified knob (4A), sample-clock cooldown, hysteresis dead-band, bounded one-step
// clamp + anti-windup, one-directional (min=launch) guard.
const bus = require('../core/event-bus')
const db  = require('../db/database')
const { getConfig, writeUserConfig } = require('../config')
const { recordTuningEvent, getTuningEvents } = require('../db/schema')

function wilsonBounds(p, n, z) {
  if (!n || n <= 0) return { lb: 0, ub: 1 }
  const z2 = z * z, denom = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return { lb: Math.max(0, (center - margin) / denom), ub: Math.min(1, (center + margin) / denom) }
}

const getAtPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
function patchForPath(path, value) {
  const parts = path.split('.'); const root = {}; let cur = root
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = {}
  cur[parts[parts.length - 1]] = value
  return root
}

// Per-strategy win-rate/mean — REAL-PREFERRED: use feedback_outcomes (actual Meridian executions)
// when a strategy has >= minSamplesPerStrategy real closes, else fall back to SIM (dry-run). This is
// the ground-truth source; SIM was proven directionally optimistic. Validated via preview-tuner.js:
// SIM spot said "hold" (WR 46%) while REAL said the opposite (WR 63%) — driving off SIM is wrong.
function strategyStats() {
  const minReal = getConfig().learning?.autoTuner?.minSamplesPerStrategy ?? 50
  const sim = db.prepare(`
    SELECT strategy, COUNT(*) AS n, SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins, AVG(net_pnl_pct) AS mean
    FROM dry_run_positions WHERE status='closed' AND outcome_valid=1 GROUP BY strategy
  `).all()
  const real = db.prepare(`
    SELECT strategy, COUNT(*) AS n, SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins, AVG(pnl_pct) AS mean
    FROM feedback_outcomes WHERE pnl_pct IS NOT NULL GROUP BY strategy
  `).all()
  const realMap = {}; for (const r of real) realMap[r.strategy] = r
  const simMap  = {}; for (const r of sim)  simMap[r.strategy]  = r
  const m = {}
  for (const strat of new Set([...sim.map(r=>r.strategy), ...real.map(r=>r.strategy)])) {
    const rr = realMap[strat], sr = simMap[strat]
    const useReal = rr && rr.n >= minReal
    const src = useReal ? rr : (sr || { n: 0, wins: 0, mean: 0 })
    m[strat] = { n: src.n, wins: src.wins, wr: src.n ? src.wins / src.n : 0, mean: src.mean ?? 0, source: useReal ? 'real' : 'sim' }
  }
  return m
}

function lastEventFor(paramPath) {
  return db.prepare(
    `SELECT new_value, old_value, delta, sample_count FROM tuning_events
     WHERE param_path = ? AND status IN ('applied','proposed') ORDER BY created_at DESC LIMIT 1`
  ).get(paramPath)
}

function proposeTuning() {
  const cfg = getConfig()
  const T = cfg.learning?.autoTuner || {}
  if (!T.enabled) return { proposed: 0, reason: 'disabled' }

  const z = T.wilsonZ ?? 1.96
  const band = T.hysteresisBand ?? 0.05
  const be = T.breakEvenWinRate ?? 0.50
  const stats = strategyStats()
  const now = new Date().toISOString()
  let proposed = 0

  // ── v1: strategy.spotMaxVolatility, driven by spot evidence ────────────────
  const paramPath = 'strategy.spotMaxVolatility'
  const bounds = T.params?.[paramPath]
  const spot = stats['spot']
  if (bounds && spot && spot.n >= (T.minSamplesPerStrategy ?? 50)) {
    const { lb, ub } = wilsonBounds(spot.wr, spot.n, z)
    let dir = 0
    if (lb > be + band) dir = +1        // proven profitable → widen the vol cap
    else if (ub < be - band) dir = -1   // proven unprofitable → tighten (bounded at launch min)

    // Mean-P&L guard: never WIDEN a strategy whose average trade loses money. A high win-rate with a
    // negative mean = many small wins + a fat loss tail; widening the vol cap admits MORE such pools.
    // (Tighten is unaffected — tightening a loser is always safe.) Validated: real spot WR 63% but
    // mean −0.18% would wrongly widen under WR-alone; the guard correctly holds.
    const meanFloor = T.meanFloorForWiden ?? 0
    if (dir === +1 && (spot.mean ?? 0) < meanFloor) {
      console.log(`[Tuner] ${paramPath}: WR LB ${(lb*100).toFixed(0)}% would widen but mean ${spot.mean.toFixed(2)}% < ${meanFloor} [${spot.source}] — mean-guard holds`)
      dir = 0
    }

    if (dir !== 0) {
      const current = Number(getAtPath(cfg, paramPath))
      const last = lastEventFor(paramPath)
      // Anti-windup: if the previous move was the opposite direction, halve the step.
      let step = bounds.step
      if (last && Math.sign(last.delta || 0) === -dir) step = step / 2
      // Cooldown on a SAMPLE clock: require enough NEW closed spot samples since the last move.
      const enoughNew = !last || (spot.n - (last.sample_count || 0)) >= (T.cooldownSamples ?? 45)
      let next = Math.min(bounds.max, Math.max(bounds.min, current + dir * step))
      next = Math.round(next * 1000) / 1000

      if (!enoughNew) {
        console.log(`[Tuner] ${paramPath}: cooldown (only ${spot.n - (last.sample_count || 0)} new samples) — skip`)
      } else if (next === current) {
        console.log(`[Tuner] ${paramPath}: already at bound ${current} — skip`)
      } else {
        proposed++
        const reason = `[${spot.source}] spot WR ${(spot.wr * 100).toFixed(0)}% (Wilson ${dir > 0 ? 'LB' : 'UB'} ${((dir > 0 ? lb : ub) * 100).toFixed(0)}%) vs break-even ${(be * 100).toFixed(0)}±${(band * 100).toFixed(0)} over N=${spot.n}, mean ${spot.mean.toFixed(2)}%. ` +
          `${spot.source === 'sim' ? 'CAVEAT: SIM fallback — net_pnl uses a capped flat fee estimate; verify the edge is not fee-only before APPLY.' : 'Source: real Meridian outcomes.'}`
        const mode = T.mode === 'apply' && spot.n >= (T.realSampleMin ?? 100) ? 'apply' : 'shadow'
        const evt = {
          created_at: now, param_path: paramPath, old_value: current, new_value: next, delta: next - current,
          strategy: 'spot', reason, sample_count: spot.n, win_rate: spot.wr,
          wilson_lb: Math.round(lb * 1000) / 1000, mean_pnl_net: spot.mean, metric_confidence: 'medium',
          mode, status: mode === 'apply' ? 'applied' : 'proposed', reverted_from: null,
        }
        if (mode === 'apply') {
          writeUserConfig(patchForPath(paramPath, next))
          recordTuningEvent(evt)
          console.log(`[Tuner] APPLIED ${paramPath}: ${current} → ${next}`)
          bus.emitSafe('tuning_applied', { param_path: paramPath, old_value: current, new_value: next })
        } else {
          recordTuningEvent(evt)
          console.log(`[Tuner] SHADOW proposal ${paramPath}: ${current} → ${next}`)
          bus.emitSafe('tuning_proposal', { param_path: paramPath, old_value: current, new_value: next, reason })
          try { require('../notifications/telegram').tuningProposal(evt) } catch {}
        }
      }
    }
  }
  return { proposed }
}

/** Approve a shadow proposal by id → applies it via writeUserConfig and records an applied event. */
function approveProposal(id) {
  const e = db.prepare(`SELECT * FROM tuning_events WHERE id = ? AND status = 'proposed'`).get(id)
  if (!e) return { ok: false, reason: 'not a pending proposal' }
  writeUserConfig(patchForPath(e.param_path, e.new_value))
  db.prepare(`UPDATE tuning_events SET status='applied', mode='apply' WHERE id=?`).run(id)
  bus.emitSafe('tuning_applied', { param_path: e.param_path, old_value: e.old_value, new_value: e.new_value })
  return { ok: true }
}

function init() {
  bus.onSlow('tuner_cycle', () => {
    try { proposeTuning() } catch (e) { console.error('[Tuner] error:', e.message) }
  })
  const enabled = getConfig().learning?.autoTuner?.enabled
  console.log(`[Tuner] ready (${enabled ? 'ENABLED ' + (getConfig().learning.autoTuner.mode) : 'disabled'})`)
}

module.exports = { init, proposeTuning, approveProposal, wilsonBounds }
