'use strict'
/**
 * preview-tuner.js — READ-ONLY preview of what the auto-tuner WOULD propose, run on VPS BEFORE
 * enabling it. Replicates the tuner's decision logic (Wilson bound on spot win-rate vs break-even
 * ± hysteresis) WITHOUT calling the real proposeTuning() — so it writes no tuning_event and sends
 * no Telegram. Crucially it runs the logic on BOTH sources:
 *   - SIM  (dry_run_positions) — what the tuner uses TODAY
 *   - REAL (feedback_outcomes)  — the ground truth it SHOULD use
 * If the two disagree, enabling the tuner as-is would tune off the wrong signal.
 *
 * Usage (repo root, VPS):  node scripts/preview-tuner.js
 * Read-only. Writes nothing.
 */
const path = require('path')
const Database = require('better-sqlite3')
const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true, fileMustExist: true })
const fmt = x => x == null ? '—' : Math.round(x*1000)/1000

let T = {}, current = 2.0
try {
  const cfg = require(path.join(process.cwd(),'src','config')).getConfig()
  T = cfg.learning?.autoTuner || {}
  current = Number(cfg.strategy?.spotMaxVolatility ?? 2.0)
} catch {}
const z = T.wilsonZ ?? 1.96, band = T.hysteresisBand ?? 0.05, be = T.breakEvenWinRate ?? 0.50
const bounds = (T.params && T.params['strategy.spotMaxVolatility']) || { min:2.0, max:3.0, step:0.25 }
const minSamples = T.minSamplesPerStrategy ?? 50

function wilson(p, n) {
  if (!n) return { lb:0, ub:1 }
  const z2=z*z, denom=1+z2/n, c=p+z2/(2*n), m=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)
  return { lb:Math.max(0,(c-m)/denom), ub:Math.min(1,(c+m)/denom) }
}
function spotFrom(table) {
  if (table === 'sim') return db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN net_pnl_pct>0 THEN 1 ELSE 0 END) wins, AVG(net_pnl_pct) mean FROM dry_run_positions WHERE status='closed' AND outcome_valid=1 AND strategy='spot'`).get()
  return db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN pnl_pct>0 THEN 1 ELSE 0 END) wins, AVG(pnl_pct) mean FROM feedback_outcomes WHERE strategy='spot' AND pnl_pct IS NOT NULL`).get()
}
function decide(s, label) {
  const wr = s.n ? s.wins/s.n : 0
  const { lb, ub } = wilson(wr, s.n)
  let dir = 0, why = 'hold (within hysteresis dead-band)'
  if (s.n < minSamples) { why = `n=${s.n} < minSamples ${minSamples} — tuner would NOT act` }
  else if (lb > be + band) { dir = +1; why = `widen: Wilson LB ${fmt(lb)} > ${be}+${band}` }
  else if (ub < be - band) { dir = -1; why = `tighten: Wilson UB ${fmt(ub)} < ${be}-${band}` }
  const next = dir ? Math.round(Math.min(bounds.max, Math.max(bounds.min, current + dir*bounds.step))*1000)/1000 : current
  console.log(`${label}: n=${s.n} WR=${Math.round(wr*100)}% mean=${fmt(s.mean)}% Wilson[${fmt(lb)},${fmt(ub)}]`)
  console.log(`  → proposal: ${dir? `${current} → ${next}` : 'no change'}  (${why})`)
  return { dir, next, wr, n: s.n }
}

console.log('═══ AUTO-TUNER PROPOSAL PREVIEW (spotMaxVolatility) ═══')
console.log(`current=${current}  bounds=[${bounds.min},${bounds.max}] step=${bounds.step}  break-even=${be}±${band}  z=${z}  minSamples=${minSamples}`)
console.log(`tuner enabled=${T.enabled} mode=${T.mode}\n`)
console.log('━━ what the tuner uses TODAY (SIM / dry_run_positions) ━━')
const sim = decide(spotFrom('sim'), 'SIM spot')
console.log('\n━━ what it SHOULD use (REAL / feedback_outcomes) ━━')
const real = decide(spotFrom('real'), 'REAL spot')

// ── PROPOSED FIXED LOGIC: real-preferred source + mean-P&L guard on widen ───────
// The fix has TWO parts: (1) prefer REAL outcomes when n>=minSamples (else sim fallback);
// (2) a mean-guard — only WIDEN if mean_pnl >= meanFloor, so a high-WR-but-losing strategy
// (many small wins, fat loss tail) is NOT widened. Tighten needs no mean-guard (safe regardless).
const meanFloor = 0   // don't widen a strategy whose average trade loses money
function decideFixed() {
  const rs = spotFrom('real'), ss = spotFrom('sim')
  const useReal = rs.n >= minSamples
  const s = useReal ? rs : ss
  const src = useReal ? 'REAL' : 'sim-fallback'
  const wr = s.n ? s.wins/s.n : 0
  const { lb, ub } = wilson(wr, s.n)
  let dir = 0, why = 'hold (within dead-band)'
  if (s.n < minSamples) why = `n=${s.n} < minSamples — no act`
  else if (lb > be + band) {
    if ((s.mean ?? 0) >= meanFloor) { dir = +1; why = `WIDEN: WR LB ${fmt(lb)}>${be+band} AND mean ${fmt(s.mean)}>=${meanFloor}` }
    else { dir = 0; why = `HOLD (mean-guard): WR LB ${fmt(lb)} would widen BUT mean ${fmt(s.mean)}<${meanFloor} — refuse to widen a losing strategy` }
  } else if (ub < be - band) { dir = -1; why = `tighten: WR UB ${fmt(ub)}<${be-band}` }
  const next = dir ? Math.round(Math.min(bounds.max, Math.max(bounds.min, current + dir*bounds.step))*1000)/1000 : current
  console.log(`FIXED spot [src=${src}]: n=${s.n} WR=${Math.round(wr*100)}% mean=${fmt(s.mean)}% Wilson[${fmt(lb)},${fmt(ub)}]`)
  console.log(`  → proposal: ${dir? `${current} → ${next}` : 'no change'}  (${why})`)
  return { dir, next }
}
console.log('\n━━ PROPOSED FIXED LOGIC (real-preferred + mean-guard) ━━')
const fixed = decideFixed()

console.log('\n━━ VERDICT ━━')
if (!real.n) console.log('• No real spot outcomes — only sim available.')
else if (sim.dir !== real.dir) console.log(`• CURRENT logic is WRONG: SIM says "${sim.dir>0?'widen':sim.dir<0?'tighten':'hold'}" but REAL says "${real.dir>0?'widen':real.dir<0?'tighten':'hold'}" — drives off the wrong source.`)
console.log(`• FIXED logic proposal: ${fixed.dir? (fixed.dir>0?'widen':'tighten')+` → ${fixed.next}` : 'HOLD'}.`)
console.log(`• KEY CHECK: real spot WR is high (${Math.round(real.wr*100)}%) but mean is ${fmt(spotFrom('real').mean)}% — the mean-guard SHOULD block the widen. If FIXED shows HOLD, the guard works correctly.`)
console.log('• NOTE: volatility had AUC 0.068 (weak) on real outcomes — spotMaxVolatility is a low-value knob. A stronger lever (age/tvl-mcap thresholds) is a future tuner-whitelist candidate.')
console.log('\ndone.')
