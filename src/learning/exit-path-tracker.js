'use strict'
// Exit intelligence, step 1 — record the PRICE PATH of positions Meridian is holding.
//
// WHY THIS IS THE PREREQUISITE, NOT THE ANALYSIS. Every exit comparison available today is
// confounded, verified 2026-07-29 on all 593 labelled real exits:
//
//   - Across techniques it is a tautology. il_stop fires BECAUSE the position was losing, so its
//     mean of -5.94% is not "il_stop is bad", it is "positions that hit the stop were losing".
//     Comparing it to net_target compares losers to winners.
//   - Across thresholds it is confounded by time. The history does contain a natural experiment
//     — oor_timeout ran at 15m and at 30m — and @15m looks better (win 62% vs 58%, mean +0.263
//     vs +0.128). But @15m only ran 24 May–6 Jun while @30m ran through 26 Jul, so the periods
//     barely overlap, and a permutation test puts the gap at p = 0.385. It is noise plus regime.
//
// The only non-confounded question is counterfactual: given the price path this position
// ACTUALLY took, what would a different exit rule have returned? That needs the path. Argus
// stores two points per position (entry and exit prices) and an ATH watermark — no series. So
// exit intelligence is not blocked on cleverness or on sample size, it is blocked on a missing
// measurement, and this starts taking it.
//
// Each position yields a whole path rather than a single row, so this accumulates far faster
// than the gate-calibration route: weeks, not months.
//
// Scope is deliberately collection ONLY. The replay engine comes once there is something to
// replay — building an analyser against an empty table is how the sim corpus got trusted.

const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')
const { getPoolSnapshot } = require('../dry-run/price-feed')

/**
 * Pools Meridian is currently holding, inferred from the observed on-chain actions of our own
 * wallet: an add_liquidity with no later remove_liquidity on the same pool.
 *
 * The staleness cap matters. Without it the query returns positions that were closed while the
 * observer was down — on the 2026-07-28 snapshot, 4 of 5 "open" positions dated to 26 June,
 * left behind by the three-week Helius outage. Real holds average 58 minutes, so anything open
 * beyond maxOpenHours is presumed closed-and-missed rather than genuinely held.
 */
function getHeldPools(maxOpenHours) {
  const cutoff = new Date(Date.now() - maxOpenHours * 3_600_000).toISOString()
  try {
    return db.prepare(`
      SELECT a.pool_address AS pool, MAX(a.detected_at) AS opened_at
      FROM wallet_actions a
      WHERE a.wallet_type = 'own'
        AND a.action_type = 'add_liquidity'
        AND a.pool_address IS NOT NULL
      GROUP BY a.pool_address
      HAVING opened_at >= @cutoff
         AND opened_at > COALESCE((
               SELECT MAX(r.detected_at) FROM wallet_actions r
               WHERE r.wallet_type = 'own' AND r.action_type = 'remove_liquidity'
                 AND r.pool_address = a.pool_address
             ), '')
    `).all({ cutoff })
  } catch (e) {
    console.warn('[ExitPath] held-pool query failed:', e.message)
    return []
  }
}

const insert = () => db.prepare(`
  INSERT INTO position_price_path (pool_address, observed_at, price_sol, fee_active_tvl_ratio, source)
  VALUES (@pool_address, @observed_at, @price_sol, @fee_active_tvl_ratio, @source)
`)

/**
 * Sample every held pool once. Runs on the existing dry-run tick (5 min), so the sampling
 * interval is inherited rather than a new timer. Bounded by maxPoolsPerTick so an observer
 * backlog can never turn one tick into a hundred API calls.
 */
async function sampleHeldPools() {
  const cfg = getConfig()
  const E = cfg.exitIntel || {}
  if (E.enabled === false) return { sampled: 0 }

  const held = getHeldPools(E.maxOpenHours ?? 12).slice(0, E.maxPoolsPerTick ?? 10)
  if (!held.length) return { sampled: 0 }

  const now = new Date().toISOString()
  const rows = []
  for (const h of held) {
    try {
      const snap = await getPoolSnapshot(h.pool)
      if (!snap || !(snap.price > 0)) continue
      rows.push({
        pool_address: h.pool,
        observed_at: now,
        price_sol: snap.price,
        // fee/TVL is captured alongside the price because the low_yield exit triggers on it —
        // a replay of that rule needs the ratio at each step, not just the price.
        fee_active_tvl_ratio: snap.fee_active_tvl_ratio ?? null,
        source: 'pool_discovery',
      })
    } catch { /* one bad pool must not stop the rest */ }
  }
  if (!rows.length) return { sampled: 0 }

  try {
    const stmt = insert()
    db.transaction(rs => { for (const r of rs) stmt.run(r) })(rows)
  } catch (e) {
    console.warn('[ExitPath] insert failed:', e.message)
    return { sampled: 0 }
  }
  return { sampled: rows.length, pools: held.length }
}

function init() {
  // Piggybacks the dry-run cadence rather than adding a timer: same 5-minute rhythm, and it
  // cannot drift out of step with the position updates it will eventually be replayed against.
  bus.onSlow('dry_run_update', () => {
    sampleHeldPools()
      .then(r => { if (r.sampled) console.log(`[ExitPath] sampled ${r.sampled} held pool(s)`) })
      .catch(e => console.warn('[ExitPath] sample cycle error:', e.message))
  })
  console.log('[ExitPath] Ready')
}

module.exports = { init, sampleHeldPools, getHeldPools }
