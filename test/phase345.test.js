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
      writeUserConfig({ scan: { pipelines: [{ profile: 'x', strategy: 'x' }] } })
      assert.strictEqual(getConfig().scan.pipelines.length, 2)
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
ok('getBaseRate falls back to 0.5 with no/low samples', () => {
  assert.strictEqual(getBaseRate('spot', cfg), cfg.learning.baseRateFallback)
  assert.strictEqual(getBaseRate(null, cfg), cfg.learning.baseRateFallback)
})

console.log(`\n${passed} assertion(s) passed.`)
