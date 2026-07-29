'use strict'
/**
 * Assertion tests for Phase 4A (config write-path + spotMaxVolatility unify) and
 * Phase 3a (shrinkage + EMA scoring). Run: node test/phase345.test.js
 * The write-path test backs up and restores the real user-config.json.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

require('../src/db/schema').initSchema()  // apply migrations (wins/ema_win_rate/range_pct/...)
const { getConfig, writeUserConfig, reloadConfig } = require('../src/config')
const { resolveScreening } = require('../src/intelligence/index')
const { adjustScore, getBaseRate } = require('../src/learning/pattern-reader')

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1 }
}
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

console.log('Phase 4A — spotMaxVolatility unify:')
ok('spot profile has no own maxVolatility (single source)', () => {
  assert.ok(!('maxVolatility' in getConfig().screening.profiles.spot))
})
ok('resolveScreening injects spot vol cap from strategy.spotMaxVolatility', () => {
  const cfg = getConfig()
  const s = resolveScreening(cfg, 'spot')
  assert.strictEqual(s.maxVolatility, cfg.strategy.spotMaxVolatility)
})
ok('bid_ask profile keeps the base (high) vol cap', () => {
  const s = resolveScreening(getConfig(), 'bid_ask')
  assert.strictEqual(s.maxVolatility, getConfig().screening.maxVolatility)
})

console.log('Phase 4A — writeUserConfig round-trip (backs up + restores real file):')
{
  const USER = path.join(process.cwd(), 'user-config.json')
  const existed = fs.existsSync(USER)
  const backup = existed ? fs.readFileSync(USER, 'utf8') : null
  try {
    ok('scalar patch observed without restart', () => {
      const before = getConfig().scan.topCandidateLimit
      writeUserConfig({ scan: { topCandidateLimit: before + 3 } })
      assert.strictEqual(getConfig().scan.topCandidateLimit, before + 3)
    })
    ok('array path is refused (deepMerge would clobber)', () => {
      const { DEFAULTS } = require('../src/config')
      const defLen = DEFAULTS.scan.pipelines.length
      writeUserConfig({ scan: { pipelines: [{ profile: 'x', strategy: 'x' }] } })
      assert.strictEqual(getConfig().scan.pipelines.length, defLen)  // array patch ignored
    })
  } finally {
    if (backup != null) fs.writeFileSync(USER, backup, 'utf8')
    else if (fs.existsSync(USER)) fs.unlinkSync(USER)
    reloadConfig()
  }
}

console.log('Phase 3a — shrinkage + EMA scoring:')
const cfg = getConfig()
ok('inactive pattern → rawScore unchanged (cold-start dormancy)', () => {
  assert.strictEqual(adjustScore(0.5, { active: 0, sample_count: 1, ema_win_rate: 1 }, cfg, 'bid_ask'), 0.5)
})
ok('small-N active pattern shrinks toward base rate', () => {
  // N=5,k=20,ema=0.9,base=0.5 → p=0.58; adj=0.5*0.7+0.58*0.3=0.674... wait raw0.5
  const adj = adjustScore(0.5, { active: 1, sample_count: 5, ema_win_rate: 0.9 }, cfg, 'bid_ask')
  assert.ok(approx(adj, 0.5 * 0.7 + 0.58 * 0.3, 0.02), `adj=${adj}`)
})
ok('large-N weights EMA more than small-N (for ema>base)', () => {
  const small = adjustScore(0.5, { active: 1, sample_count: 5,   ema_win_rate: 0.9 }, cfg, 'bid_ask')
  const large = adjustScore(0.5, { active: 1, sample_count: 200, ema_win_rate: 0.9 }, cfg, 'bid_ask')
  assert.ok(large > small, `large=${large} small=${small}`)
})
ok('getBaseRate prefers the REAL corpus over simulation', () => {
  // Self-consistent rather than hardcoded: derive the expectation from whatever this database
  // holds, and skip when it holds nothing. Passes on a fresh checkout AND on a live deployment
  // — unlike the assertion below used to.
  const db = require('../src/db/database')
  const min = cfg.learning.baseRateMinSamples ?? 30
  const row = db.prepare(`
    SELECT strategy, COUNT(*) AS n, SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS w
    FROM feedback_outcomes WHERE pnl_pct IS NOT NULL AND strategy IS NOT NULL
    GROUP BY strategy HAVING n >= ? LIMIT 1
  `).get(min)
  if (!row) return  // no real corpus here — nothing to assert
  assert.ok(Math.abs(getBaseRate(row.strategy, cfg) - row.w / row.n) < 1e-9,
    `expected real base rate ${row.w / row.n} for ${row.strategy}, got ${getBaseRate(row.strategy, cfg)}`)
})
ok('getBaseRate sim fallback ignores no-fill positions', () => {
  const db = require('../src/db/database')
  const min = cfg.learning.baseRateMinSamples ?? 30
  // A strategy with enough SIM data but no real corpus — that is where the fallback is used.
  const row = db.prepare(`
    SELECT dr.strategy,
           SUM(CASE WHEN NOT (dr.net_pnl_pct = 0 AND dr.gross_pnl_pct = 0) THEN 1 ELSE 0 END) AS filled,
           SUM(CASE WHEN dr.net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins
    FROM dry_run_positions dr
    WHERE dr.status = 'closed' AND dr.outcome_valid = 1 AND dr.strategy IS NOT NULL
      AND dr.strategy NOT IN (
        SELECT strategy FROM feedback_outcomes WHERE pnl_pct IS NOT NULL AND strategy IS NOT NULL
        GROUP BY strategy HAVING COUNT(*) >= ?)
    GROUP BY dr.strategy HAVING filled >= ? LIMIT 1
  `).get(min, min)
  if (!row) return  // nothing exercises the fallback in this DB
  assert.ok(Math.abs(getBaseRate(row.strategy, cfg) - row.wins / row.filled) < 1e-9,
    `sim fallback must divide by FILLED count, not all closes (${row.strategy})`)
})
ok('getBaseRate falls back to the configured prior with no/low samples', () => {
  // Must name a strategy that genuinely has no rows. This previously asserted on 'spot',
  // which only has <baseRateMinSamples closed dry-runs on a FRESH database — so the test
  // passed on a clean checkout and failed on any real deployment, inverting exactly where
  // a green suite matters most.
  assert.strictEqual(getBaseRate('__no_such_strategy__', cfg), cfg.learning.baseRateFallback)
  assert.strictEqual(getBaseRate(null, cfg), cfg.learning.baseRateFallback)
})

console.log(`\n${passed} assertion(s) passed.`)
