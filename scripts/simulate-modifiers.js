'use strict'
/**
 * simulate-modifiers.js — READ-ONLY backtest of PROPOSED confidence modifiers against the real
 * feedback_outcomes (run on VPS). Tests the design BEFORE writing production code:
 *
 *   - Does the RE-TUNED liquidityModifier discriminate better than the current (mis-set) one?
 *   - Does the proposed AGE modifier discount the catastrophe zone WITHOUT over-penalising winners?
 *   - Combined effect.
 *
 * A good modifier gives winners factor≈1.0 (don't suppress good trades) and catastrophes factor<1.0
 * (suppress bad ones). The headline metric is DISCRIMINATION = mean_factor(winners) − mean_factor(catas):
 * positive and large = the modifier down-weights catastrophes more than winners. We also report the
 * OVER-PENALTY rate on winners (must stay LOW — a modifier that hurts winners is useless).
 *
 * Usage (repo root, VPS):  node scripts/simulate-modifiers.js
 * Read-only. Writes nothing.
 */
const path = require('path')
const Database = require('better-sqlite3')
const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true, fileMustExist: true })
const num = x => { const v = Number(x); return Number.isFinite(v) ? v : null }
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null
const fmt = x => x == null ? '—' : Math.round(x*1000)/1000

// ── Modifier implementations (faithful to production math) ──────────────────────
// Liquidity modifier — same shape as src/intelligence/index.js liquidityModifier()
function liqFactor(tvl, mcap, holders, p) {
  let f = 1
  if (tvl != null && mcap != null && mcap > 0) {
    const r = tvl / mcap
    if (r > p.tvlMcapClean) { const span = Math.max(1e-9, p.tvlMcapGate - p.tvlMcapClean)
      f *= 1 - Math.min(1, (r - p.tvlMcapClean) / span) * p.tvlMcapMaxPenalty }
  }
  if (tvl != null && holders != null && holders > 0) {
    const t = tvl / holders
    if (t > p.tvlPerHolderClean) { const span = Math.max(1e-9, p.tvlPerHolderHigh - p.tvlPerHolderClean)
      f *= 1 - Math.min(1, (t - p.tvlPerHolderClean) / span) * p.tvlPerHolderMaxPenalty }
  }
  return Math.max(p.floor, f)
}
// Age modifier — discount below safeAgeHours, ramping to floor at/below youngAgeHours, 1.0 at ≥safe.
function ageFactor(age, p) {
  if (age == null || age >= p.safeAgeHours) return 1
  const span = Math.max(1e-9, p.safeAgeHours - p.youngAgeHours)
  const frac = Math.min(1, Math.max(0, (p.safeAgeHours - age) / span))
  return Math.max(1 - p.maxPenalty, 1 - frac * p.maxPenalty)
}

const CURRENT_LIQ  = { tvlMcapClean:0.05, tvlMcapGate:0.10, tvlMcapMaxPenalty:0.10, tvlPerHolderClean:20, tvlPerHolderHigh:40, tvlPerHolderMaxPenalty:0.12, floor:0.80 }
const PROPOSED_LIQ = { tvlMcapClean:0.045, tvlMcapGate:0.08, tvlMcapMaxPenalty:0.10, tvlPerHolderClean:13, tvlPerHolderHigh:26, tvlPerHolderMaxPenalty:0.12, floor:0.80 }
const PROPOSED_AGE = { safeAgeHours:72, youngAgeHours:24, maxPenalty:0.12 }

// ── Load real closes ────────────────────────────────────────────────────────────
const rows = db.prepare(`SELECT pnl_pct, features_json FROM feedback_outcomes WHERE pnl_pct IS NOT NULL`).all()
  .map(r => { let f={}; try{f=r.features_json?JSON.parse(r.features_json):{}}catch{}
    return { pnl:r.pnl_pct, age:num(f.token_age_hours), mcap:num(f.entry_mcap),
      holders:num(f.entry_holders ?? f.holder_count), tvl:num(f.entry_tvl), tvlMcap:num(f.tvl_mcap_ratio) } })
const winners = rows.filter(r => r.pnl > 2)
const catas   = rows.filter(r => r.pnl < -5)
console.log(`═══ MODIFIER SIMULATION (real feedback_outcomes) ═══`)
console.log(`closes: ${rows.length} · winners(pnl>2%)=${winners.length} · catastrophes(pnl<-5%)=${catas.length}\n`)

// For liquidity we need tvl+mcap (ratio) and tvl+holders. mcap reconstructed from tvl/tvlMcap if absent.
const mcapOf = r => r.mcap != null ? r.mcap : (r.tvl != null && r.tvlMcap > 0 ? r.tvl / r.tvlMcap : null)

function report(name, factorFn) {
  const wf = winners.map(factorFn).filter(x=>x!=null)
  const cf = catas.map(factorFn).filter(x=>x!=null)
  const mw = mean(wf), mc = mean(cf)
  const disc = (mw!=null && mc!=null) ? mw - mc : null
  const wOver = wf.filter(x=>x<0.90).length, cOver = cf.filter(x=>x<0.90).length
  const pct = (a,b) => b ? Math.round(a/b*100)+'%' : 'n/a'
  console.log(`${name}`)
  console.log(`  mean factor: winners=${fmt(mw)}  catas=${fmt(mc)}  DISCRIMINATION=${fmt(disc)} ${disc>0.04?'<-- GOOD (catas penalised more)':disc>0.01?'(weak)':'<-- NO EDGE'}`)
  console.log(`  penalised >10%: winners=${wOver}/${wf.length} (${pct(wOver,wf.length)})  catas=${cOver}/${cf.length} (${pct(cOver,cf.length)})`)
  console.log(`  → want LOW winner-penalty %, HIGH catas-penalty %, positive discrimination\n`)
}

console.log('━━ LIQUIDITY MODIFIER: current vs proposed thresholds ━━')
report('CURRENT (clean20/high40, mcap0.05/0.10)', r => liqFactor(r.tvl, mcapOf(r), r.holders, CURRENT_LIQ))
report('PROPOSED (clean13/high26, mcap0.045/0.08)', r => liqFactor(r.tvl, mcapOf(r), r.holders, PROPOSED_LIQ))

console.log('━━ AGE MODIFIER (proposed: safe72h, young24h, maxPenalty0.12) ━━')
report('AGE', r => ageFactor(r.age, PROPOSED_AGE))

console.log('━━ COMBINED (proposed liquidity × age) ━━')
report('COMBINED', r => liqFactor(r.tvl, mcapOf(r), r.holders, PROPOSED_LIQ) * ageFactor(r.age, PROPOSED_AGE))

console.log('done — discrimination>0.04 with low winner-penalty confirms the design; else adjust thresholds.')
