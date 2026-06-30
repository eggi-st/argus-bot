'use strict'
/**
 * validate-learning.js — READ-ONLY learning-health report. Run on the VPS (where the 428 real
 * Meridian closes live in feedback_outcomes) to answer the questions we could NOT answer from the
 * local sim-only DB:
 *
 *   1. PROMOTION HEALTH — are (bucket × strategy) patterns actually reaching `active` from REAL
 *      outcomes? (Locally 0/28 active is EXPECTED — reconcile only promotes real-backed patterns,
 *      and local feedback_outcomes=0. The real question is whether the 428 closes promote anything.)
 *   2. FEATURE SEPARATION on REAL data — re-run the tail-separation AUC (winners vs catastrophes)
 *      on feedback_outcomes.features_json, the authoritative version of the local sim analysis.
 *   3. FRAGMENTATION — is the learning key too fine? (closes spread thin across cells → nothing
 *      reaches the promotion threshold). This decides whether hierarchical-backoff work is needed.
 *   4. DATA VELOCITY — accumulation rate, for context.
 *
 * Usage (from repo root on VPS):  node scripts/validate-learning.js
 * Writes nothing. Safe to run against a live DB.
 */
const path = require('path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(process.cwd(), 'data', 'argus.db')
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
const fmt = x => x == null ? '—' : Math.round(x * 1000) / 1000
const has = name => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)

// Promotion threshold from config (fallback 45)
let PROMO = 45, MIN_REAL = 20
try { const c = require(path.join(process.cwd(), 'src', 'config')).getConfig().learning || {}
  PROMO = c.promotionThreshold ?? 45; MIN_REAL = c.minRealSamples ?? 20 } catch {}

console.log('═══ ARGUS LEARNING-HEALTH VALIDATION ═══')
console.log(`db: ${DB_PATH}  ·  promotionThreshold=${PROMO}  minRealSamples=${MIN_REAL}\n`)

// ── 1. PROMOTION HEALTH ────────────────────────────────────────────────────────
console.log('━━ 1. PROMOTION HEALTH (pattern_library) ━━')
const pats = db.prepare(`SELECT volatility_bucket vb, regime, strategy, sample_count n, win_rate wr,
  active, source, live_sample_count ln, nofill_count FROM pattern_library`).all()
const active = pats.filter(p => p.active)
const realBacked = pats.filter(p => p.source === 'real')
console.log(`patterns: ${pats.length} total · ${active.length} ACTIVE · ${realBacked.length} real-backed · ${pats.filter(p=>p.source==='sim').length} sim-only`)
if (active.length) {
  console.log('ACTIVE patterns (gate is live for these):')
  for (const p of active.sort((a,b)=>b.n-a.n))
    console.log(`  ${(p.vb+'×'+p.regime+'×'+p.strategy).padEnd(36)} N=${p.n} WR=${Math.round((p.wr||0)*100)}% src=${p.source} live=${p.ln||0}`)
} else {
  console.log('⚠ NO active patterns. If feedback_outcomes>0 below, fragmentation or real-sample gating is blocking promotion.')
}
const top = pats.sort((a,b)=>b.n-a.n).slice(0,8)
console.log(`top cells by sample_count (need ${PROMO} to promote, real≥${MIN_REAL}):`)
for (const p of top)
  console.log(`  ${(p.vb+'×'+p.regime+'×'+p.strategy).padEnd(36)} N=${String(p.n).padStart(3)}/${PROMO}  real=${p.ln||0}/${MIN_REAL}  src=${p.source||'—'}  ${p.active?'ACTIVE':''}`)

// ── 2. FEATURE SEPARATION on REAL outcomes ─────────────────────────────────────
console.log('\n━━ 2. FEATURE SEPARATION on REAL Meridian outcomes (feedback_outcomes) ━━')
if (!has('feedback_outcomes')) { console.log('no feedback_outcomes table') }
else {
  const fb = db.prepare(`SELECT pnl_pct, win, features_json FROM feedback_outcomes WHERE pnl_pct IS NOT NULL`).all()
  console.log(`real closes: ${fb.length}`)
  if (!fb.length) {
    console.log('⚠ 0 real outcomes here — run this on the VPS where the 428 backfill lives.')
  } else {
    // auto-discover numeric feature keys present in features_json
    const rows = fb.map(r => { let f={}; try { f = r.features_json ? JSON.parse(r.features_json) : {} } catch {}; return { pnl: r.pnl_pct, f } })
    const withF = rows.filter(r => Object.keys(r.f).length)
    console.log(`closes with features_json: ${withF.length}/${fb.length}`)
    if (withF.length >= 10) {
      const keys = [...new Set(withF.flatMap(r => Object.keys(r.f)))]
        .filter(k => withF.some(r => Number.isFinite(Number(r.f[k]))))
      // derived composites if components exist
      const winners = withF.filter(r => r.pnl > 2), catas = withF.filter(r => r.pnl < -5)
      console.log(`winners(pnl>2%)=${winners.length}  catastrophes(pnl<-5%)=${catas.length}`)
      const auc = key => {
        const get = r => { const v = Number(r.f[key]); return Number.isFinite(v) ? v : null }
        const W = winners.map(get).filter(x=>x!=null), C = catas.map(get).filter(x=>x!=null)
        if (W.length < 3 || C.length < 3) return null
        let s=0; for (const w of W) for (const c of C) s += w>c?1:w===c?0.5:0
        return s/(W.length*C.length)
      }
      const ranked = keys.map(k => ({ k, a: auc(k) })).filter(x => x.a != null)
        .map(x => ({ ...x, power: Math.abs(x.a-0.5) })).sort((a,b)=>b.power-a.power)
      console.log('separation power (|AUC-0.5|; >0.20 STRONG, >0.12 moderate):')
      for (const r of ranked.slice(0, 14))
        console.log(`  ${r.k.padEnd(22)} AUC=${fmt(r.a)}  power=${fmt(r.power)}  ${r.power>0.2?'<-- STRONG':r.power>0.12?'<- moderate':''}`)
      console.log('→ compare to LOCAL SIM ranking (fee/TVL .30, tvl .22, vol .21, holders .21). If REAL agrees, Tier 1-B thresholds are confirmed.')
    } else console.log('⚠ too few feature-bearing closes to compute separation — features_json sparse.')
  }
}

// ── 3. FRAGMENTATION ───────────────────────────────────────────────────────────
console.log('\n━━ 3. FRAGMENTATION (is the learning key too fine?) ━━')
const cells = db.prepare(`SELECT d.condition_bucket bucket, dr.strategy strategy, COUNT(*) n
  FROM dry_run_positions dr JOIN decisions d ON d.id=dr.decision_id
  WHERE dr.status='closed' AND dr.outcome_valid=1 AND d.condition_bucket IS NOT NULL
  GROUP BY d.condition_bucket, dr.strategy`).all()
const totalCloses = cells.reduce((s,c)=>s+c.n,0)
const cellsAtPromo = cells.filter(c => c.n >= PROMO).length
console.log(`${totalCloses} dry-run closes across ${cells.length} distinct (bucket×strategy) cells`)
console.log(`avg ${fmt(totalCloses/Math.max(cells.length,1))} closes/cell · max cell=${Math.max(0,...cells.map(c=>c.n))} · cells reaching ${PROMO}: ${cellsAtPromo}`)
if (cells.length && cellsAtPromo === 0)
  console.log(`⚠ FRAGMENTATION SIGNAL: 0 cells reach the threshold. If promotion is also stuck → hierarchical backoff (sparse fine-cell borrows a coarser parent's stats) is the high-value fix.`)
else if (cellsAtPromo > 0)
  console.log(`✓ ${cellsAtPromo} cell(s) have enough samples to promote — fragmentation is NOT the blocker.`)

// ── 4. DATA VELOCITY ───────────────────────────────────────────────────────────
console.log('\n━━ 4. DATA VELOCITY ━━')
const dspan = db.prepare(`SELECT MIN(created_at) mn, MAX(created_at) mx, COUNT(*) n FROM decisions`).get()
if (dspan.n) {
  const days = Math.max(0.1, (new Date(dspan.mx)-new Date(dspan.mn))/86400000)
  console.log(`${dspan.n} decisions over ${fmt(days)}d = ${fmt(dspan.n/days)}/day`)
}
const fbN = has('feedback_outcomes') ? db.prepare(`SELECT COUNT(*) c FROM feedback_outcomes`).get().c : 0
console.log(`feedback_outcomes (real): ${fbN}  ·  dry_run closed: ${totalCloses}`)

// ── 5. VERDICT ─────────────────────────────────────────────────────────────────
console.log('\n━━ 5. VERDICT ━━')
if (fbN === 0) console.log('• No real outcomes here — this looks like a non-VPS db. Re-run on the VPS for an authoritative read.')
else if (active.length === 0 && cellsAtPromo === 0) console.log('• Promotion stuck AND no cell hits threshold → FRAGMENTATION is the bottleneck. Build hierarchical backoff.')
else if (active.length === 0 && realBacked.length > 0) console.log('• Real-backed patterns exist but none active → tighten/inspect promotion (real-sample gating may be the limiter, not fragmentation).')
else if (active.length > 0) console.log(`• ${active.length} pattern(s) active — learning IS engaging. Fragmentation work NOT urgent; focus on fee-persistence (#9) + shadow auto-tuner (#11).`)
console.log('\ndone.')
