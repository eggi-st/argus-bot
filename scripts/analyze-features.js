'use strict'
/**
 * Feature analysis over Meridian's real position history (lessons.json performance[]).
 *
 * Answers: which entry/screening features actually separate WINNERS from LOSERS, and do
 * EvilPanda's anti-rug thresholds (top10<16%, age 6h-1wk, TVL/mcap<=5, etc.) hold up against
 * real outcomes? This turns "copy EvilPanda's thresholds" into "validate/learn them from data".
 *
 * Read-only. Run on the VPS (or anywhere lessons.json is reachable):
 *   node scripts/analyze-features.js
 *   LESSONS=~/meridian-bot/lessons.json node scripts/analyze-features.js
 */
const fs = require('fs')
const os = require('os')

const LESSONS = (process.env.LESSONS || '~/meridian-bot/lessons.json').replace(/^~/, os.homedir())
if (!fs.existsSync(LESSONS)) { console.error('lessons.json not found at:', LESSONS); process.exit(1) }
const recs = (JSON.parse(fs.readFileSync(LESSONS, 'utf8')).performance || [])
  .filter(r => r && r.pool && (r.pnl_pct != null))

const feat = (r, k) => r[k] ?? r.signal_snapshot?.[k] ?? null
const tvlMcap = (r) => { const m = feat(r, 'entry_mcap'), t = feat(r, 'entry_tvl'); return (m > 0 && t != null) ? t / m : null }
const isWin = (r) => Number(r.pnl_pct) > 0
const pct = (x) => x == null ? '  — ' : (Math.round(x * 1000) / 10).toFixed(1) + '%'
const f2 = (x) => x == null ? '—' : (Math.round(x * 100) / 100).toFixed(2)

function stats(rows) {
  const n = rows.length
  if (!n) return { n: 0, wr: null, mean: null }
  const wins = rows.filter(isWin).length
  const mean = rows.reduce((s, r) => s + Number(r.pnl_pct), 0) / n
  return { n, wr: wins / n, mean }
}

console.log('Meridian feature analysis')
console.log('=========================')
console.log('lessons.json:', LESSONS, '| records:', recs.length)
const all = stats(recs)
console.log(`overall: WR ${pct(all.wr)}  meanPnL ${f2(all.mean)}%  (N=${all.n})\n`)

// ── by category ─────────────────────────────────────────────────────────────
function byGroup(label, keyFn) {
  const g = {}
  for (const r of recs) { const k = keyFn(r); if (k == null) continue; (g[k] ||= []).push(r) }
  console.log(`── by ${label} ──`)
  Object.entries(g).sort((a, b) => b[1].length - a[1].length).forEach(([k, rows]) => {
    const s = stats(rows)
    console.log(`  ${String(k).padEnd(22)} WR ${pct(s.wr)}  meanPnL ${f2(s.mean).padStart(7)}%  N=${s.n}`)
  })
  console.log('')
}
byGroup('strategy', r => r.strategy)
byGroup('close_reason', r => (r.close_reason || '').split(':')[0].slice(0, 20) || null)
byGroup('decided_by', r => feat(r, 'decided_by'))

// ── numeric features: split at median, compare below vs above ────────────────
const NUMERIC = [
  'top10_pct', 'bundle_pct', 'bot_holders_pct', 'organic_score', 'fee_tvl_ratio', 'volatility',
  'token_age_hours', 'entry_mcap', 'entry_tvl', 'entry_volume', 'flow_imbalance',
  'volume_change_pct', 'price_change_pct', 'candidate_score', 'range_efficiency', 'minutes_held',
]
console.log('── numeric features — split at median (which features separate win/loss?) ──')
console.log('  feature              median   below: WR/meanPnL (N)        above: WR/meanPnL (N)     ΔWR')
const rowsOut = []
for (const key of NUMERIC.concat(['tvl_mcap_ratio'])) {
  const get = key === 'tvl_mcap_ratio' ? tvlMcap : (r) => feat(r, key)
  const vals = recs.map(r => ({ r, v: get(r) })).filter(x => x.v != null && Number.isFinite(Number(x.v)))
  if (vals.length < 12) continue
  vals.sort((a, b) => a.v - b.v)
  const med = vals[Math.floor(vals.length / 2)].v
  const below = stats(vals.filter(x => x.v <= med).map(x => x.r))
  const above = stats(vals.filter(x => x.v > med).map(x => x.r))
  if (below.n < 4 || above.n < 4) continue
  const dWr = (above.wr - below.wr)
  rowsOut.push({ key, med, below, above, dWr })
}
rowsOut.sort((a, b) => Math.abs(b.dWr) - Math.abs(a.dWr))
for (const o of rowsOut) {
  console.log(`  ${o.key.padEnd(20)} ${f2(o.med).padStart(7)}   ${pct(o.below.wr)}/${f2(o.below.mean).padStart(6)}% (${String(o.below.n).padStart(3)})    ${pct(o.above.wr)}/${f2(o.above.mean).padStart(6)}% (${String(o.above.n).padStart(3)})   ${(o.dWr >= 0 ? '+' : '') + pct(o.dWr).trim()}`)
}
console.log('  (large |ΔWR| = predictive feature; sign shows whether higher value helps)\n')

// ── EvilPanda threshold validation ───────────────────────────────────────────
console.log('── EvilPanda thresholds vs real outcomes ──')
function gate(label, passFn) {
  const withData = recs.filter(r => passFn(r) !== null)
  const pass = stats(withData.filter(r => passFn(r) === true))
  const fail = stats(withData.filter(r => passFn(r) === false))
  console.log(`  ${label.padEnd(34)} PASS ${pct(pass.wr)}/${f2(pass.mean).padStart(6)}%(${pass.n})   FAIL ${pct(fail.wr)}/${f2(fail.mean).padStart(6)}%(${fail.n})`)
}
gate('top10 < 16%', r => { const v = feat(r, 'top10_pct'); return v == null ? null : v < 16 })
gate('tvl/mcap <= 5', r => { const v = tvlMcap(r); return v == null ? null : v <= 5 })
gate('age 6h–168h', r => { const v = feat(r, 'token_age_hours'); return v == null ? null : (v >= 6 && v <= 168) })
gate('bundle < 16%', r => { const v = feat(r, 'bundle_pct'); return v == null ? null : v < 16 })
gate('organic >= 60', r => { const v = feat(r, 'organic_score'); return v == null ? null : v >= 60 })
console.log('\n  PASS = meets EvilPanda rule. If PASS WR >> FAIL WR, the rule is validated by real data.')
console.log('  (low N on either side = inconclusive — note before acting.)')
