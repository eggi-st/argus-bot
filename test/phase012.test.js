'use strict'
/**
 * Assertion tests for Phase 0 (P&L fee model), Phase 1 (Wilson pattern gate),
 * and Phase 2 (per-profile screening resolution). Run: node test/phase012.test.js
 */
const assert = require('assert')
const { computeSimulatedFeePct, computeSingleSidedPnlPct, rangePctForStrategy } = require('../src/dry-run/engine')
const { checkPatternGate, wilsonLowerBound, resolveScreening,
        trackScreenerHealth, _resetScreenerHealth } = require('../src/intelligence/index')
const bus = require('../src/core/event-bus')

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
ok('sim-backed pattern never gates — same distrust adjustScore applies to the boost', () => {
  // Identical stats to the blocked case above, only source differs.
  const real = { active: 1, win_rate: 0.7, sample_count: 40, mean_pnl_net: -3, source: 'real' }
  const sim  = { active: 1, win_rate: 0.7, sample_count: 40, mean_pnl_net: -3, source: 'sim' }
  assert.strictEqual(checkPatternGate(real, 0.8, {}).blocked, true, 'real must still block')
  assert.strictEqual(checkPatternGate(sim,  0.8, {}).blocked, false, 'sim must not block')
})
ok('sim pattern is still subject to the confidence floor', () => {
  const sim = { active: 1, win_rate: 0.7, sample_count: 40, mean_pnl_net: 2, source: 'sim' }
  assert.strictEqual(checkPatternGate(sim, 0.1, {}).blocked, true)
})
ok('pattern with no source set still gates (legacy rows are not sim-exempt)', () => {
  const pat = { active: 1, win_rate: 0.292, sample_count: 24, mean_pnl_net: -4.31 }
  assert.strictEqual(checkPatternGate(pat, 0.8, {}).blocked, true)
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

console.log('\nCross-strategy score normalisation:')
const { normalizeScore, resetCache } = require('../src/intelligence/score-normalizer')
const realCfg = require('../src/config').getConfig()
const normOff = { scoring: { normalize: { enabled: false } } }
const normImpossible = { scoring: { normalize: { minSamples: 1e9 } } }

// Returns a strategy that has a usable reference distribution, or undefined when this database
// has no schema/data yet (fresh checkout). Lets the percentile tests skip instead of exploding.
function refStrategy() {
  try {
    return require('../src/db/database').prepare(
      `SELECT strategy FROM decisions WHERE raw_score IS NOT NULL
        GROUP BY strategy HAVING COUNT(*) >= 50 LIMIT 1`
    ).get()
  } catch { return undefined }
}

ok('disabled → identity', () => {
  resetCache()
  assert.strictEqual(normalizeScore('spot', 0.42, normOff), 0.42)
})
ok('below minSamples → identity (cold start is never reshaped)', () => {
  resetCache()
  assert.strictEqual(normalizeScore('spot', 0.42, normImpossible), 0.42)
  assert.strictEqual(normalizeScore('a_strategy_that_does_not_exist', 0.42, realCfg), 0.42)
})
ok('non-finite input and missing strategy pass through untouched', () => {
  resetCache()
  assert.ok(Number.isNaN(normalizeScore('spot', NaN, realCfg)), 'NaN must pass through, not become 0')
  assert.strictEqual(normalizeScore(null, 0.42, realCfg), 0.42)
  assert.strictEqual(normalizeScore('spot', undefined, realCfg), undefined)
})
ok('output is bounded to [0,1] and monotone non-decreasing in the raw score', () => {
  resetCache()
  const row = refStrategy()
  if (!row) return  // no reference distribution in this DB — nothing to exercise
  let prev = -1
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const v = normalizeScore(row.strategy, x, realCfg)
    assert.ok(v >= 0 && v <= 1, `out of range at raw=${x}: ${v}`)
    assert.ok(v >= prev, `not monotone at raw=${x}: ${v} < ${prev}`)
    prev = v
  }
})
ok('identical raw scores map to an identical percentile', () => {
  resetCache()
  const row = refStrategy()
  if (!row) return
  assert.strictEqual(normalizeScore(row.strategy, 0.5, realCfg), normalizeScore(row.strategy, 0.5, realCfg))
})

console.log('\nScreener health guard (intake silent-outage):')
function captureScreenerEvents(fn) {
  const seen = []
  const onDown = p => seen.push({ e: 'down', ...p })
  const onUp   = p => seen.push({ e: 'recovered', ...p })
  bus.on('screener_down', onDown)
  bus.on('screener_recovered', onUp)
  try { _resetScreenerHealth(); fn() } finally {
    bus.off('screener_down', onDown); bus.off('screener_recovered', onUp)
  }
  return seen
}
ok('a healthy cycle never alerts, however many pipelines find nothing worth taking', () => {
  // 3 pipelines screened a real universe; blank=0. Finding no candidate is a market
  // condition, not an outage — this must stay silent forever.
  const ev = captureScreenerEvents(() => { for (let i = 0; i < 20; i++) trackScreenerHealth(3, 0, 3) })
  assert.strictEqual(ev.length, 0, JSON.stringify(ev))
})
ok('a partial failure never alerts — one live pipeline means the intake is up', () => {
  const ev = captureScreenerEvents(() => { for (let i = 0; i < 20; i++) trackScreenerHealth(3, 2, 3) })
  assert.strictEqual(ev.length, 0, JSON.stringify(ev))
})
ok('stays silent below the threshold', () => {
  const ev = captureScreenerEvents(() => {
    trackScreenerHealth(3, 3, 3); trackScreenerHealth(3, 3, 3)   // 2 all-blank cycles of 3
  })
  assert.strictEqual(ev.length, 0, JSON.stringify(ev))
})
ok('fires on exactly the Nth consecutive all-blank cycle', () => {
  const ev = captureScreenerEvents(() => {
    for (let i = 0; i < 3; i++) trackScreenerHealth(3, 3, 3)
  })
  assert.strictEqual(ev.length, 1, JSON.stringify(ev))
  assert.strictEqual(ev[0].e, 'down')
  assert.strictEqual(ev[0].failedCycles, 3)
  assert.strictEqual(ev[0].pipelines, 3)
})
ok('re-fires every N cycles while down so a lost P1 is not lost forever', () => {
  const ev = captureScreenerEvents(() => { for (let i = 0; i < 9; i++) trackScreenerHealth(2, 2, 3) })
  assert.strictEqual(ev.filter(x => x.e === 'down').length, 3, JSON.stringify(ev))
})
ok('recovery fires once, and only after an alert was raised', () => {
  const ev = captureScreenerEvents(() => {
    for (let i = 0; i < 3; i++) trackScreenerHealth(2, 2, 3)  // down
    trackScreenerHealth(2, 0, 3)                              // healthy → recovered
    trackScreenerHealth(2, 0, 3)                              // still healthy → silent
  })
  assert.strictEqual(ev.filter(x => x.e === 'recovered').length, 1, JSON.stringify(ev))
})
ok('recovery is silent when no alert had been raised', () => {
  const ev = captureScreenerEvents(() => {
    trackScreenerHealth(2, 2, 3)   // one blank cycle, below threshold
    trackScreenerHealth(2, 0, 3)   // healthy again — nobody was told anything
  })
  assert.strictEqual(ev.length, 0, JSON.stringify(ev))
})
ok('a scan with zero pipelines configured is a no-op, not an outage', () => {
  const ev = captureScreenerEvents(() => { for (let i = 0; i < 10; i++) trackScreenerHealth(0, 0, 3) })
  assert.strictEqual(ev.length, 0, JSON.stringify(ev))
})
ok('a crashing scan counts toward the guard — a crash loop is an outage too', () => {
  // runScan's catch reports the cycle as (1 attempted, 1 blank).
  const ev = captureScreenerEvents(() => { for (let i = 0; i < 3; i++) trackScreenerHealth(1, 1, 3) })
  assert.strictEqual(ev.filter(x => x.e === 'down').length, 1, JSON.stringify(ev))
})
ok('a crash followed by healthy scans clears the alert', () => {
  const ev = captureScreenerEvents(() => {
    for (let i = 0; i < 3; i++) trackScreenerHealth(1, 1, 3)  // crash loop → down
    trackScreenerHealth(3, 0, 3)                              // scan works again
  })
  assert.strictEqual(ev.filter(x => x.e === 'recovered').length, 1, JSON.stringify(ev))
})

console.log(`\n${passed} assertion(s) passed.`)
