'use strict'
/**
 * analyze-real-signals.js — READ-ONLY design analysis on the REAL feedback_outcomes (run on VPS).
 * Answers the 5 questions needed to design the token_age signal + re-tune liquidityModifier
 * CORRECTLY (not from a single AUC number):
 *
 *   1. Age distribution — how many closes below the 48h antirug gate? Does age vary above it?
 *   2. Curve shape — win-rate & mean-pnl per age band (linear? step? plateau? where's the knee?)
 *   3. Collinearity — age vs mcap vs holders vs tvl/mcap. If highly correlated they're one
 *      "maturity" factor and stacking separate modifiers would double-count.
 *   4. Does age separate ABOVE the gate? (if the 48h hard-gate already removed the young
 *      catastrophes, a continuous bonus above 48h may add little.)
 *   5. Real thresholds for tvl_mcap_ratio + tvl_per_holder (winners vs catastrophes) → re-tune.
 *
 * Usage (repo root, VPS):  node scripts/analyze-real-signals.js
 * Read-only. Safe on a live DB.
 */
const path = require('path')
const Database = require('better-sqlite3')
const db = new Database(path.join(process.cwd(), 'data', 'argus.db'), { readonly: true, fileMustExist: true })

const num = x => { const v = Number(x); return Number.isFinite(v) ? v : null }
const med = a => { if (!a.length) return null; const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)] }
const q = (a,p) => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor((s.length-1)*p)] }
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null
const fmt = x => x == null ? '—' : Math.round(x*1000)/1000
const pearson = (xs,ys) => { const n=xs.length; if(n<3)return null; const mx=mean(xs),my=mean(ys); let nu=0,dx=0,dy=0; for(let i=0;i<n;i++){nu+=(xs[i]-mx)*(ys[i]-my);dx+=(xs[i]-mx)**2;dy+=(ys[i]-my)**2} return (dx&&dy)?nu/Math.sqrt(dx*dy):null }

const fb = db.prepare(`SELECT pnl_pct, win, features_json FROM feedback_outcomes WHERE pnl_pct IS NOT NULL`).all()
const rows = fb.map(r => { let f={}; try { f = r.features_json ? JSON.parse(r.features_json) : {} } catch {}
  return { pnl: r.pnl_pct,
    age: num(f.token_age_hours), mcap: num(f.entry_mcap), holders: num(f.entry_holders ?? f.holder_count),
    tvl: num(f.entry_tvl), tvlMcap: num(f.tvl_mcap_ratio) } })
const withAge = rows.filter(r => r.age != null)
console.log(`═══ REAL-SIGNAL DESIGN ANALYSIS ═══\nreal closes: ${rows.length} · with age: ${withAge.length}\n`)

// ── 1. AGE DISTRIBUTION ────────────────────────────────────────────────────────
console.log('━━ 1. AGE DISTRIBUTION (hours) ━━')
const ages = withAge.map(r=>r.age)
if (!ages.length) { console.log('no age data — run on VPS where feedback_outcomes is populated.'); process.exit(0) }
console.log(`min=${fmt(Math.min(...ages))} p25=${fmt(q(ages,.25))} median=${fmt(med(ages))} p75=${fmt(q(ages,.75))} max=${fmt(Math.max(...ages))}`)
console.log(`below 48h gate: ${withAge.filter(r=>r.age<48).length} · 48-168h: ${withAge.filter(r=>r.age>=48&&r.age<168).length} · 168h+: ${withAge.filter(r=>r.age>=168).length}`)

// ── 2. CURVE SHAPE — outcome by age band ───────────────────────────────────────
console.log('\n━━ 2. CURVE SHAPE — win-rate & mean-pnl & catastrophe-rate by age band ━━')
const bands = [[0,24],[24,48],[48,72],[72,168],[168,336],[336,1e9]]
console.log('band(h)        n    WR%   mean_pnl%  catas%(<-5)')
for (const [lo,hi] of bands) {
  const b = withAge.filter(r=>r.age>=lo&&r.age<hi)
  if (!b.length) { console.log(`${(lo+'-'+(hi>1e8?'∞':hi)).padEnd(12)} 0`); continue }
  const wr = b.filter(r=>r.pnl>0).length/b.length*100
  const mp = mean(b.map(r=>r.pnl))
  const cat = b.filter(r=>r.pnl<-5).length/b.length*100
  console.log(`${(lo+'-'+(hi>1e8?'∞':hi)).padEnd(12)} ${String(b.length).padStart(3)}  ${String(Math.round(wr)).padStart(3)}   ${String(fmt(mp)).padStart(7)}    ${Math.round(cat)}`)
}

// ── 3. COLLINEARITY — are age/mcap/holders/tvlMcap the same "maturity" factor? ──
console.log('\n━━ 3. COLLINEARITY (Pearson; >0.5 = redundant, stacking would double-count) ━━')
const pair = (ka,kb) => { const r=withAge.filter(x=>x[ka]!=null&&x[kb]!=null); return r.length<3?null:pearson(r.map(x=>x[ka]),r.map(x=>x[kb])) }
console.log(`age~mcap=${fmt(pair('age','mcap'))}  age~holders=${fmt(pair('age','holders'))}  age~tvlMcap=${fmt(pair('age','tvlMcap'))}  mcap~holders=${fmt(pair('mcap','holders'))}`)
console.log('(if age~mcap and age~holders are HIGH → use ONE maturity factor, not three modifiers)')

// ── 4. DOES AGE SEPARATE ABOVE THE 48h GATE? ───────────────────────────────────
console.log('\n━━ 4. AGE SEPARATION ABOVE THE 48h GATE (is a continuous bonus useful post-gate?) ━━')
const above = withAge.filter(r=>r.age>=48)
const aw = above.filter(r=>r.pnl>2), ac = above.filter(r=>r.pnl<-5)
const aucAge = (() => { const W=aw.map(r=>r.age),C=ac.map(r=>r.age); if(W.length<3||C.length<3)return null; let s=0; for(const w of W)for(const c of C)s+=w>c?1:w===c?.5:0; return s/(W.length*C.length) })()
console.log(`among age>=48h: n=${above.length} winners=${aw.length} catas=${ac.length} · AUC(age)=${fmt(aucAge)} (0.5=age stops mattering once gated; >0.65=still useful)`)
console.log(`  winners age median=${fmt(med(aw.map(r=>r.age)))}h  catas age median=${fmt(med(ac.map(r=>r.age)))}h`)

// ── 5. RE-TUNE THRESHOLDS — tvl_mcap_ratio + tvl_per_holder, winners vs catas ───
console.log('\n━━ 5. LIQUIDITY THRESHOLDS from real winners vs catastrophes ━━')
const W2 = rows.filter(r=>r.pnl>2), C2 = rows.filter(r=>r.pnl<-5)
const tm = r => r.tvlMcap
console.log('tvl_mcap_ratio:')
console.log(`  winners: p25=${fmt(q(W2.map(tm).filter(Boolean),.25))} median=${fmt(med(W2.map(tm).filter(Boolean)))} p75=${fmt(q(W2.map(tm).filter(Boolean),.75))}`)
console.log(`  catas:   p25=${fmt(q(C2.map(tm).filter(Boolean),.25))} median=${fmt(med(C2.map(tm).filter(Boolean)))} p75=${fmt(q(C2.map(tm).filter(Boolean),.75))}`)
console.log(`  → set tvlMcapClean≈winner-median, tvlMcapGate≈catas-p25 (current cfg: clean 0.05 / gate 0.10)`)
const tph = r => (r.tvl>0&&r.holders>0) ? r.tvl/r.holders : null
const wt = W2.map(tph).filter(x=>x!=null), ct = C2.map(tph).filter(x=>x!=null)
console.log('tvl_per_holder (reconstructed entry_tvl/entry_holders):')
console.log(`  winners: median=${fmt(med(wt))} p75=${fmt(q(wt,.75))}`)
console.log(`  catas:   median=${fmt(med(ct))} p75=${fmt(q(ct,.75))}`)
console.log(`  → set tvlPerHolderClean≈winner-median, tvlPerHolderHigh≈catas-median (current cfg: clean 20 / high 40)`)

console.log('\ndone — paste this output back to design the age signal + threshold re-tune.')
