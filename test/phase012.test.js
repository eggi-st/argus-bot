'use strict'
/**
 * Assertion tests for Phase 0 (P&L fee model), Phase 1 (Wilson pattern gate),
 * and Phase 2 (per-profile screening resolution). Run: node test/phase012.test.js
 */
const assert = require('assert')
const { computeSimulatedFeePct, computeSingleSidedPnlPct, rangePctForStrategy } = require('../src/dry-run/engine')
const { checkPatternGate, wilsonLowerBound, resolveScreening } = require('../src/intelligence/index')

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1 }
}
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

console.log('Phase 0 — computeSimulatedFeePct (percentage points, capped):')
ok('high-yield pool clamps to maxFeePct (cap=10)', () => {
  // 1.01 × (14/30) × 0.6 × 100 = 28.28 → clamped to 10
  assert.strictEqual(computeSimulatedFeePct(1.01, 14, 30, {}), 10)
})
ok('moderate yield not capped', () => {
  // 0.2 × (14/30) × 0.6 × 100 = 5.6
  assert.ok(approx(computeSimulatedFeePct(0.2, 14, 30, {}), 5.6))
})
ok('respects a lower explicit cap', () => {
  assert.strictEqual(computeSimulatedFeePct(0.2, 14, 30, { maxFeePct: 3 }), 3)
})
ok('disabled → 0', () => {
  assert.strictEqual(computeSimulatedFeePct(1.01, 14, 30, { simulateFees: false }), 0)
})
ok('null fee rate → 0 (the pre-fix dead-code case)', () => {
  assert.strictEqual(computeSimulatedFeePct(null, 14, 30, {}), 0)
})
ok('zero hold → 0', () => {
  assert.strictEqual(computeSimulatedFeePct(1.01, 0, 30, {}), 0)
})

console.log('Phase 1 — Wilson lower bound + pattern gate:')
ok('wilson LB widens below point estimate for small N', () => {
  const lb = wilsonLowerBound(0.292, 24, 1.0)
  assert.ok(lb < 0.292 && lb > 0, `lb=${lb}`)
})
ok('high_froth (WR=29%, N=24) is BLOCKED — closes the old N<30 dead-zone', () => {
  const pat = { active: 1, win_rate: 0.292, sample_count: 24, mean_pnl_net: -4.31 }
  const g = checkPatternGate(pat, 0.8, {})
  assert.strictEqual(g.blocked, true, JSON.stringify(g))
})
ok('genuinely good pattern (WR=70%, N=36) passes', () => {
  const pat = { active: 1, win_rate: 0.7, sample_count: 36, mean_pnl_net: 2 }
  assert.strictEqual(checkPatternGate(pat, 0.8, {}).blocked, false)
})
ok('calibrating pattern (not active) is never blocked', () => {
  const pat = { active: 0, win_rate: 1.0, sample_count: 1, mean_pnl_net: 5 }
  assert.strictEqual(checkPatternGate(pat, 0.8, {}).blocked, false)
})
ok('confidence below floor is blocked', () => {
  const pat = { active: 1, win_rate: 0.7, sample_count: 36, mean_pnl_net: 2 }
  assert.strictEqual(checkPatternGate(pat, 0.1, {}).blocked, true)
})
ok('good WR but negative mean P&L is blocked by meanPnl gate', () => {
  const pat = { active: 1, win_rate: 0.7, sample_count: 40, mean_pnl_net: -3 }
  const g = checkPatternGate(pat, 0.8, {})
  assert.strictEqual(g.blocked, true, JSON.stringify(g))
})

console.log('Phase 2 — resolveScreening profiles:')
const cfg = {
  screening: {
    maxVolatility: 4, maxTokenAgeHours: 72, minMcap: 50000,
    profiles: { spot: { maxVolatility: 2, minTokenAgeHours: 24, maxTokenAgeHours: null } },
  },
}
ok('bid_ask profile = base, with no profiles key leaking', () => {
  const s = resolveScreening(cfg, 'bid_ask')
  assert.strictEqual(s.maxVolatility, 4)
  assert.strictEqual(s.maxTokenAgeHours, 72)
  assert.ok(!('profiles' in s))
})
ok('spot profile overrides base correctly', () => {
  const s = resolveScreening(cfg, 'spot')
  assert.strictEqual(s.maxVolatility, 2)
  assert.strictEqual(s.minTokenAgeHours, 24)
  assert.strictEqual(s.maxTokenAgeHours, null)
  assert.strictEqual(s.minMcap, 50000)  // inherited
  assert.ok(!('profiles' in s))
})
ok('real DEFAULTS resolve a spot profile with vol from strategy.spotMaxVolatility (unified)', () => {
  const { DEFAULTS } = require('../src/config')
  // After Phase 4A the spot vol cap is injected from strategy.spotMaxVolatility (single source),
  // so a cfg without `strategy` no longer yields 2 — pass the full config.
  const s = resolveScreening({ screening: DEFAULTS.screening, strategy: DEFAULTS.strategy }, 'spot')
  assert.strictEqual(s.maxVolatility, DEFAULTS.strategy.spotMaxVolatility)
  assert.strictEqual(s.maxTokenAgeHours, null)
})

console.log('Single-sided SOL P&L (Meridian quote=SOL bid below price):')
ok('price RISE earns 0 price P&L (SOL never converts) — the core fix', () => {
  assert.strictEqual(computeSingleSidedPnlPct(1, 1.5, 0.34), 0)
})
ok('flat price → 0', () => {
  assert.strictEqual(computeSingleSidedPnlPct(1, 1.0, 0.34), 0)
})
ok('small dip into range → small loss', () => {
  const p = computeSingleSidedPnlPct(1, 0.9, 0.34)
  assert.ok(approx(p, -1.55, 0.1), `p=${p}`)
})
ok('price below range → sizable IL', () => {
  const p = computeSingleSidedPnlPct(1, 0.5, 0.34)
  assert.ok(approx(p, -39.76, 0.2), `p=${p}`)
})
ok('token to ~0 → bounded near −100%', () => {
  const p = computeSingleSidedPnlPct(1, 0.0001, 0.34)
  assert.ok(p > -100 && p < -99, `p=${p}`)
})
ok('rangePctForStrategy maps bins×binStep correctly', () => {
  assert.ok(approx(rangePctForStrategy('bid_ask', 100), 0.34))
  assert.ok(approx(rangePctForStrategy('spot', 100), 0.69))
  assert.ok(approx(rangePctForStrategy('limit_order', 100), 0.10))
})
ok('rangePctForStrategy defaults binStep and clamps', () => {
  assert.ok(approx(rangePctForStrategy('bid_ask', null), 0.34))
  assert.strictEqual(rangePctForStrategy('spot', 500), 0.99)  // 69×5% clamped
})

console.log(`\n${passed} assertion(s) passed.`)
